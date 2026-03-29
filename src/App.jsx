import { useState, useCallback, useRef, useEffect } from 'react';
import Blobby from './Blobby';
import './App.css';

const ACCEPT_MEDIA = 'audio/*,video/*,.mp3,.m4a,.wav,.ogg,.flac,.aac,.wma,.opus,.webm,.mp4,.mov';
const AUDIUS_API = 'https://api.audius.co/v1';
const AUDIUS_APP = 'blobby';

function isAudiusUrl(str) {
  return /audius\.co\//.test(str);
}

function App() {
  const [audioSource, setAudioSource] = useState(null);
  const [mode, setMode] = useState(null); // null | 'mic' | 'file'
  const [fileName, setFileName] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubPos, setScrubPos] = useState(0);
  const [hasVideo, setHasVideo] = useState(false);
  const [showVideo, setShowVideo] = useState(false);
  // Audius
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const audioCtxRef = useRef(null);
  const audioElRef = useRef(null);
  const micStreamRef = useRef(null);
  const rafRef = useRef(null);
  const seekBarRef = useRef(null);
  const scrubPosRef = useRef(0);
  const videoContainerRef = useRef(null);

  const cleanup = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (audioElRef.current) { audioElRef.current.pause(); audioElRef.current = null; }
    if (micStreamRef.current) { micStreamRef.current.getTracks().forEach(t => t.stop()); micStreamRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null; }
    if (videoContainerRef.current) videoContainerRef.current.innerHTML = '';
    setAudioSource(null);
    setIsPlaying(false);
    setProgress(0);
    setDuration(0);
    setHasVideo(false);
    setShowVideo(false);
  }, []);

  const setupAnalysers = useCallback((ctx, source, isMono, monitor = true) => {
    const splitter = ctx.createChannelSplitter(2);
    source.connect(splitter);
    if (monitor) source.connect(ctx.destination);

    const analyserMixed = ctx.createAnalyser();
    analyserMixed.fftSize = 2048;
    analyserMixed.smoothingTimeConstant = 0.8;
    source.connect(analyserMixed);

    const analyserL = ctx.createAnalyser();
    analyserL.fftSize = 2048;
    analyserL.smoothingTimeConstant = 0.8;
    splitter.connect(analyserL, 0);

    const analyserR = ctx.createAnalyser();
    analyserR.fftSize = 2048;
    analyserR.smoothingTimeConstant = 0.8;
    splitter.connect(analyserR, isMono ? 0 : 1);

    setAudioSource({ analyserL, analyserR, analyserMixed, isMono });
  }, []);

  const startMic = useCallback(async () => {
    cleanup();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      setupAnalysers(ctx, source, false, false);
      setMode('mic');
    } catch (err) {
      console.error('Mic access denied:', err);
    }
  }, [setupAnalysers, cleanup]);

  const startProgressLoop = useCallback(() => {
    function tick() {
      const audio = audioElRef.current;
      if (audio) {
        setProgress(audio.currentTime);
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const playAudioUrl = useCallback((url, name) => {
    cleanup();
    setFileName(name);

    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.src = url;
    audioElRef.current = audio;

    audio.addEventListener('loadedmetadata', () => setDuration(audio.duration));
    audio.addEventListener('ended', () => setIsPlaying(false));
    audio.addEventListener('play', () => setIsPlaying(true));
    audio.addEventListener('pause', () => setIsPlaying(false));

    const source = ctx.createMediaElementSource(audio);
    setupAnalysers(ctx, source, false);
    audio.play();
    setIsPlaying(true);
    setMode('file');
    startProgressLoop();
  }, [setupAnalysers, cleanup, startProgressLoop]);

  const handleFile = useCallback((file) => {
    if (!file) return;
    cleanup();
    setFileName(file.name);

    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const media = document.createElement('video');
    media.crossOrigin = 'anonymous';
    media.playsInline = true;
    media.src = URL.createObjectURL(file);
    audioElRef.current = media;

    if (videoContainerRef.current) {
      videoContainerRef.current.innerHTML = '';
      videoContainerRef.current.appendChild(media);
    }

    media.addEventListener('loadedmetadata', () => {
      setDuration(media.duration);
      const isVideo = media.videoWidth > 0 && media.videoHeight > 0;
      setHasVideo(isVideo);
      if (isVideo) setShowVideo(true);
    });
    media.addEventListener('ended', () => setIsPlaying(false));
    media.addEventListener('play', () => setIsPlaying(true));
    media.addEventListener('pause', () => setIsPlaying(false));

    const source = ctx.createMediaElementSource(media);
    setupAnalysers(ctx, source, false);
    media.play();
    setIsPlaying(true);
    setMode('file');
    startProgressLoop();
  }, [setupAnalysers, cleanup, startProgressLoop]);

  // --- Audius ---
  const playAudiusTrack = useCallback((track) => {
    const streamUrl = `${AUDIUS_API}/tracks/${track.id}/stream?app_name=${AUDIUS_APP}`;
    const label = `${track.user.name} - ${track.title}`;
    playAudioUrl(streamUrl, label);
    setSearchResults(null);
    setSearchQuery('');
  }, [playAudioUrl]);

  const handleSearch = useCallback(async (query) => {
    if (!query.trim()) return;
    setSearchLoading(true);
    try {
      let data;
      if (isAudiusUrl(query)) {
        const res = await fetch(`${AUDIUS_API}/resolve?url=${encodeURIComponent(query)}&app_name=${AUDIUS_APP}`);
        if (!res.ok) throw new Error('Track not found');
        const json = await res.json();
        data = json.data;
        // Resolve returns a single track — play it directly
        if (data && data.id) {
          playAudiusTrack(data);
          setSearchLoading(false);
          return;
        }
      } else {
        const res = await fetch(`${AUDIUS_API}/tracks/search?query=${encodeURIComponent(query)}&limit=8&app_name=${AUDIUS_APP}`);
        if (!res.ok) throw new Error('Search failed');
        const json = await res.json();
        data = json.data || [];
        setSearchResults(data);
      }
    } catch (err) {
      console.error('Audius error:', err);
      setSearchResults([]);
    }
    setSearchLoading(false);
  }, [playAudiusTrack]);

  const togglePlay = useCallback(() => {
    const audio = audioElRef.current;
    if (!audio) return;
    if (audio.paused) {
      if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume();
      audio.play();
    } else {
      audio.pause();
    }
  }, []);

  // --- Seek bar scrubbing ---
  const getScrubFraction = useCallback((clientX) => {
    const bar = seekBarRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const handleScrubStart = useCallback((clientX) => {
    if (!duration) return;
    setScrubbing(true);
    const pos = getScrubFraction(clientX) * duration;
    scrubPosRef.current = pos;
    setScrubPos(pos);
  }, [duration, getScrubFraction]);

  const handleScrubMove = useCallback((clientX) => {
    if (!duration) return;
    const pos = getScrubFraction(clientX) * duration;
    scrubPosRef.current = pos;
    setScrubPos(pos);
  }, [duration, getScrubFraction]);

  const handleScrubEnd = useCallback(() => {
    const audio = audioElRef.current;
    if (audio && duration) {
      audio.currentTime = scrubPosRef.current;
      setProgress(scrubPosRef.current);
    }
    setScrubbing(false);
  }, [duration]);

  const onSeekMouseDown = useCallback((e) => {
    e.preventDefault();
    handleScrubStart(e.clientX);
  }, [handleScrubStart]);

  const onSeekTouchStart = useCallback((e) => {
    handleScrubStart(e.touches[0].clientX);
  }, [handleScrubStart]);

  useEffect(() => {
    if (!scrubbing) return;

    const onMouseMove = (e) => handleScrubMove(e.clientX);
    const onMouseUp = () => handleScrubEnd();
    const onTouchMove = (e) => {
      e.preventDefault();
      handleScrubMove(e.touches[0].clientX);
    };
    const onTouchEnd = () => handleScrubEnd();

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [scrubbing, handleScrubMove, handleScrubEnd]);

  // --- Drag and drop ---
  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setDragOver(false);
  }, []);

  const handleFileInput = useCallback((e) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const formatTime = (s) => {
    if (!isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  const displayProgress = scrubbing ? scrubPos : progress;
  const seekPercent = duration ? `${(displayProgress / duration) * 100}%` : '0%';

  return (
    <div
      className="app"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="blobby-container">
        <Blobby audioSource={audioSource} />
      </div>

      {/* Video picture-in-picture */}
      <div
        className={`video-pip${showVideo && hasVideo ? ' visible' : ''}`}
        ref={videoContainerRef}
      />

      {dragOver && (
        <div className="drag-overlay">
          <div className="drag-label">Drop audio file</div>
        </div>
      )}

      {!mode && (
        <div className="controls-overlay">
          <h1>Blobby</h1>
          <p>Drop an audio file or use your mic</p>
          <div className="buttons">
            <button onClick={startMic}>Use Microphone</button>
            <label className="file-button">
              Choose File
              <input type="file" accept={ACCEPT_MEDIA} onChange={handleFileInput} hidden />
            </label>
          </div>
          <form className="search-row" onSubmit={(e) => { e.preventDefault(); handleSearch(searchQuery); }}>
            <input
              className="search-input"
              type="text"
              placeholder="Search Audius or paste link"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="search-go" type="submit" disabled={searchLoading}>
                {searchLoading ? '...' : 'Go'}
              </button>
            )}
          </form>
          {searchResults && (
            <div className="search-results">
              {searchResults.length === 0 && <div className="search-empty">No results found</div>}
              {searchResults.map((track) => (
                <button
                  key={track.id}
                  className="search-result"
                  onClick={() => playAudiusTrack(track)}
                >
                  {track.artwork?.['150x150'] && (
                    <img className="result-art" src={track.artwork['150x150']} alt="" />
                  )}
                  <div className="result-info">
                    <span className="result-title">{track.title}</span>
                    <span className="result-artist">{track.user.name}</span>
                  </div>
                  <span className="result-duration">{formatTime(track.duration)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {mode && (
        <div className="bottom-bar">
          {mode === 'file' && (
            <div
              className={`seek-bar${scrubbing ? ' scrubbing' : ''}`}
              ref={seekBarRef}
              onMouseDown={onSeekMouseDown}
              onTouchStart={onSeekTouchStart}
            >
              <div className="seek-fill" style={{ width: seekPercent }} />
              <div className="seek-thumb" style={{ left: seekPercent }} />
            </div>
          )}

          <div className="bar-row">
            <div className="source-tabs">
              <button className={`tab ${mode === 'file' ? 'active' : ''}`} onClick={() => document.getElementById('file-pick').click()}>
                File
              </button>
              <button className={`tab ${mode === 'mic' ? 'active' : ''}`} onClick={startMic}>
                Mic
              </button>
              <input id="file-pick" type="file" accept={ACCEPT_MEDIA} onChange={handleFileInput} hidden />
            </div>

            {mode === 'file' && (
              <>
                <button className="play-btn" onClick={togglePlay}>
                  {isPlaying ? '||' : '\u25B6'}
                </button>
                <span className="time">
                  {formatTime(displayProgress)} / {formatTime(duration)}
                </span>
                <span className="file-name">{fileName}</span>
              </>
            )}

            {mode === 'file' && hasVideo && (
              <button
                className={`tab ${showVideo ? 'active' : ''}`}
                onClick={() => setShowVideo(v => !v)}
              >
                Video
              </button>
            )}

            {mode === 'mic' && <span className="mic-label">Listening...</span>}

            <label className="file-button small">
              {mode === 'file' ? 'Change' : 'Load File'}
              <input type="file" accept={ACCEPT_MEDIA} onChange={handleFileInput} hidden />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
