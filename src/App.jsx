import { useState, useCallback, useRef, useEffect } from 'react';
import Blobby from './Blobby';
import './App.css';

const ACCEPT_MEDIA = 'audio/*,video/*,.mp3,.m4a,.wav,.ogg,.flac,.aac,.wma,.opus,.webm,.mp4,.mov';

function parseYouTubeTarget(str) {
  const videoId = (str.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/) || [])[1] || null;
  let listId = (str.match(/[?&]list=([\w-]+)/) || [])[1] || null;
  // Mixes (RD*) and private lists (WL/LL) don't work in embeds - drop them
  // and fall back to the single video if there is one
  if (listId && /^(RD|WL|LL)/.test(listId)) listId = null;
  if (!videoId && !listId) return null;
  return { videoId, listId };
}

// Tab audio capture via getDisplayMedia only works on desktop Chromium.
// userAgentData exists only in Chromium; mobile Chromium lacks getDisplayMedia.
const SUPPORTS_TAB_CAPTURE =
  typeof navigator.mediaDevices?.getDisplayMedia === 'function' && !!navigator.userAgentData;

// YouTube IFrame Player API loader (needed to detect embed-disabled videos)
let ytApiPromise = null;
function loadYouTubeApi() {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    if (window.YT?.Player) { resolve(window.YT); return; }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(script);
  });
  return ytApiPromise;
}

const YT_EMBED_BLOCKED_MSG =
  'This video does not allow embedding. Open it on YouTube in another tab, then Capture Tab Audio and pick that tab.';

function App() {
  const [audioSource, setAudioSource] = useState(null);
  const [mode, setMode] = useState(null); // null | 'mic' | 'file' | 'youtube'
  const [fileName, setFileName] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubPos, setScrubPos] = useState(0);
  const [hasVideo, setHasVideo] = useState(false);
  const [showVideo, setShowVideo] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fsDegraded, setFsDegraded] = useState(false);
  const [cursorHidden, setCursorHidden] = useState(false);
  const cursorTimerRef = useRef(null);
  // YouTube tab capture
  const [ytVideoId, setYtVideoId] = useState(null);
  const [ytListId, setYtListId] = useState(null);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const [showYtPopover, setShowYtPopover] = useState(false);
  const [showYtLanding, setShowYtLanding] = useState(false);
  const [ytLinkInput, setYtLinkInput] = useState('');
  const [ytNotice, setYtNotice] = useState('');
  const [ytError, setYtError] = useState('');
  const [ytLoop, setYtLoop] = useState(false);
  const ytLoopRef = useRef(false); // read inside player callbacks
  const captureStreamRef = useRef(null);
  const ytPlayerRef = useRef(null);
  const ytPlayerBoxRef = useRef(null);
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
    if (captureStreamRef.current) { captureStreamRef.current.getTracks().forEach(t => t.stop()); captureStreamRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null; }
    if (videoContainerRef.current) videoContainerRef.current.innerHTML = '';
    setAudioSource(null);
    setIsPlaying(false);
    setProgress(0);
    setDuration(0);
    setHasVideo(false);
    setShowVideo(false);
    setYtVideoId(null);
    setYtListId(null);
    setCapturing(false);
    setCaptureError('');
    setYtError('');
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

  const startMicStream = useCallback(async () => {
    // Voice-call processing (echo cancellation, noise suppression, AGC)
    // strips exactly the music we want to visualize - especially when the
    // sound comes from this device's own speakers
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    micStreamRef.current = stream;
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    // Treat mic as mono: phone mics often deliver imbalanced or single-channel
    // stereo, which made the blob lopsided. The mono path renders the mixed
    // signal symmetrically on both halves.
    setupAnalysers(ctx, source, true, false);
  }, [setupAnalysers]);

  const startMic = useCallback(async () => {
    cleanup();
    try {
      await startMicStream();
      setMode('mic');
    } catch (err) {
      console.error('Mic access denied:', err);
    }
  }, [startMicStream, cleanup]);

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

  // --- YouTube audio (tab capture, or mic fallback where capture is unsupported) ---
  const stopYtAudio = useCallback(() => {
    let hadStream = false;
    if (captureStreamRef.current) {
      captureStreamRef.current.getTracks().forEach(t => t.stop());
      captureStreamRef.current = null;
      hadStream = true;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
      hadStream = true;
    }
    if (!hadStream) return;
    if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null; }
    setAudioSource(null);
    setCapturing(false);
  }, []);

  const startMicListen = useCallback(async () => {
    setCaptureError('');
    try {
      await startMicStream();
      setCapturing(true);
    } catch (err) {
      console.error('Mic access denied:', err);
      setCaptureError('Blobby needs microphone access - allow it and try again');
    }
  }, [startMicStream]);

  const startTabCapture = useCallback(async (pickAnyTab = false) => {
    setCaptureError('');
    try {
      // Default: one-step dialog offering only this tab (preferCurrentTab).
      // pickAnyTab: full picker so any tab, window, or screen can be the
      // audio source; selfBrowserSurface makes this tab choosable there too.
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        ...(pickAnyTab ? { selfBrowserSurface: 'include' } : { preferCurrentTab: true }),
      });
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        stream.getTracks().forEach(t => t.stop());
        setCaptureError('Blobby got no sound - try again and switch on "Also share tab audio"');
        return;
      }
      // Only the audio track is needed; drop video to save decoding work
      stream.getVideoTracks().forEach(t => t.stop());
      captureStreamRef.current = stream;
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      setupAnalysers(ctx, source, false, false);
      setCapturing(true);
      // Fires when the user clicks the browser's "Stop sharing" bar
      audioTracks[0].addEventListener('ended', stopYtAudio);
    } catch (err) {
      // User dismissed the picker - not an error worth surfacing
      console.warn('Tab capture cancelled:', err);
    }
  }, [setupAnalysers, stopYtAudio]);

  const playYouTube = useCallback((target) => {
    // Keep an active capture alive across video/playlist switches - it
    // captures the whole tab, so a new target needs no new share dialog
    if (mode !== 'youtube') cleanup();
    setYtVideoId(target.videoId);
    setYtListId(target.listId);
    setFileName(target.videoId ? 'youtube.com/watch?v=' + target.videoId : 'YouTube playlist');
    setMode('youtube');
    setShowVideo(true);
    setYtLinkInput('');
    setShowYtPopover(false);
    setYtNotice('');
    setYtError('');
  }, [mode, cleanup]);

  const toggleYtLoop = useCallback(() => {
    const next = !ytLoopRef.current;
    ytLoopRef.current = next;
    setYtLoop(next);
    try { ytPlayerRef.current?.setLoop(next); } catch { /* player not ready */ }
  }, []);

  // (Re)create the IFrame API player for the current video/playlist. The
  // wrapper is keyed on the target, so each change mounts a fresh box div.
  useEffect(() => {
    if (ytPlayerRef.current) {
      try { ytPlayerRef.current.destroy(); } catch { /* DOM already gone */ }
      ytPlayerRef.current = null;
    }
    if (!ytVideoId && !ytListId) return;
    let cancelled = false;
    loadYouTubeApi().then((YT) => {
      if (cancelled || !ytPlayerBoxRef.current) return;
      ytPlayerRef.current = new YT.Player(ytPlayerBoxRef.current, {
        ...(ytVideoId ? { videoId: ytVideoId } : {}),
        width: 320,
        height: 180,
        playerVars: {
          autoplay: 1,
          playsinline: 1,
          ...(ytListId ? { listType: 'playlist', list: ytListId } : {}),
        },
        events: {
          onReady: (e) => {
            // Playlist looping is native; re-apply the preference per player
            if (ytLoopRef.current) e.target.setLoop(true);
          },
          onStateChange: (e) => {
            // Keep the label current as playlists auto-advance
            if (e.data === 1) {
              setYtError(''); // playlists skip past unplayable entries
              const d = e.target.getVideoData?.();
              if (d?.title) setFileName(d.author ? `${d.author} - ${d.title}` : d.title);
            }
            // Single videos have no native loop - replay on end
            if (e.data === 0 && ytLoopRef.current && !ytListId) {
              e.target.seekTo(0);
              e.target.playVideo();
            }
          },
          onError: (e) => {
            if (e.data === 101 || e.data === 150) setYtError(YT_EMBED_BLOCKED_MSG);
            else if (e.data === 100) setYtError('Video not found or private.');
            else setYtError('This video cannot be played here.');
          },
        },
      });
    });
    return () => { cancelled = true; };
  }, [ytVideoId, ytListId]);

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

  useEffect(() => {
    const onChange = () => {
      const fs = !!document.fullscreenElement;
      setIsFullscreen(fs);
      if (!fs) {
        setCursorHidden(false);
        setFsDegraded(false);
        clearTimeout(cursorTimerRef.current);
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // While a tab is being shared, Chromium keeps the browser toolbar visible in
  // fullscreen (anti-phishing). Detect that "degraded" fullscreen by checking
  // whether the viewport actually reached screen height.
  useEffect(() => {
    if (!isFullscreen) return;
    const check = () => setFsDegraded(window.innerHeight < screen.height - 40);
    const timer = setTimeout(check, 400); // let the fullscreen transition settle
    window.addEventListener('resize', check);
    return () => { clearTimeout(timer); window.removeEventListener('resize', check); };
  }, [isFullscreen]);

  const resetCursorTimer = useCallback(() => {
    setCursorHidden(false);
    clearTimeout(cursorTimerRef.current);
    if (isFullscreen) {
      cursorTimerRef.current = setTimeout(() => setCursorHidden(true), 1000);
    }
  }, [isFullscreen]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  }, []);

  const displayProgress = scrubbing ? scrubPos : progress;
  const seekPercent = duration ? `${(displayProgress / duration) * 100}%` : '0%';

  const youtubeUI = (
    <div className="search-wrapper">
      <form
        className="search-row"
        onSubmit={(e) => {
          e.preventDefault();
          const target = parseYouTubeTarget(ytLinkInput);
          if (target) playYouTube(target);
          else setYtNotice('Not a valid YouTube link');
        }}
      >
        <input
          className="search-input"
          type="text"
          placeholder="Paste a YouTube link"
          value={ytLinkInput}
          onChange={(e) => { setYtLinkInput(e.target.value); setYtNotice(''); }}
          autoFocus
        />
        {ytLinkInput && <button className="search-go" type="submit">Go</button>}
      </form>
      <div className="search-hint">Video and playlist links both work - copy from YouTube&apos;s address bar or Share button</div>
      {ytNotice && (
        <div className="search-results">
          <div className="search-empty">{ytNotice}</div>
        </div>
      )}
    </div>
  );

  return (
    <div
      className="app"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className={`blobby-container${isFullscreen ? ' fullscreen' : ''}${cursorHidden ? ' cursor-hidden' : ''}${!mode ? ' landing' : ''}`}
        onClick={isFullscreen ? () => document.exitFullscreen() : undefined}
        onMouseMove={isFullscreen ? resetCursorTimer : undefined}
      >
        <Blobby audioSource={audioSource} />
      </div>

      {isFullscreen && fsDegraded && (
        <div className="fs-notice">
          Your browser keeps its toolbar visible while a tab is being shared.
          Stop sharing to get true fullscreen.
        </div>
      )}

      {!isFullscreen && <div
        className={`video-pip${showVideo && hasVideo ? ' visible' : ''}`}
        ref={videoContainerRef}
      />}

      {/* Stays mounted when hidden/minimized/fullscreen so playback continues.
          The IFrame API replaces the inner div, so React must never touch it. */}
      {mode === 'youtube' && (ytVideoId || ytListId) && (
        <div className={`youtube-pip${isFullscreen || !showVideo ? ' hidden' : ''}`}>
          <div className="yt-player-box" key={`${ytVideoId}|${ytListId}`}>
            <div ref={ytPlayerBoxRef} />
          </div>
          {ytError && <div className="yt-error">{ytError}</div>}
        </div>
      )}

      {!isFullscreen && dragOver && (
        <div className="drag-overlay">
          <div className="drag-label">Drop audio file</div>
        </div>
      )}

      {!isFullscreen && !mode && (
        <div className="controls-overlay">
          <h1>Blobby</h1>
          <p>Blobby dances to whatever you play. Where&apos;s your music?</p>
          <div className="source-cards">
            <button
              className={`source-card${showYtLanding ? ' selected' : ''}`}
              onClick={() => setShowYtLanding(v => !v)}
            >
              <span className="card-title">YouTube</span>
              <span className="card-desc">Paste a video link</span>
            </button>
            <button className="source-card" onClick={startMic}>
              <span className="card-title">Microphone</span>
              <span className="card-desc">Blobby hears the room</span>
            </button>
            <label className="source-card">
              <span className="card-title">My own file</span>
              <span className="card-desc">Songs or videos</span>
              <input type="file" accept={ACCEPT_MEDIA} onChange={handleFileInput} hidden />
            </label>
          </div>
          {showYtLanding && youtubeUI}
          {!showYtLanding && <p className="drop-hint">...or just drag a song onto this page</p>}
        </div>
      )}

      {!isFullscreen && mode === 'youtube' && (ytVideoId || ytListId) && !capturing && !showYtPopover && (
        <div className="capture-guide">
          {ytError ? (
            SUPPORTS_TAB_CAPTURE ? (
              <>
                <div>
                  <strong>This video won&apos;t play here.</strong> Open it on YouTube in
                  another tab, press play there, then come back and:
                </div>
                <button className="capture-btn big" onClick={() => startTabCapture(true)}>
                  Capture That Tab
                </button>
                <div className="guide-steps">
                  In the popup: pick the YouTube tab, then switch on <em>Also share tab audio</em>.
                </div>
              </>
            ) : (
              <>
                <div>
                  <strong>This video won&apos;t play here.</strong> Play it in the YouTube
                  app out loud, then:
                </div>
                <button className="capture-btn big" onClick={startMicListen}>
                  Let Blobby Listen
                </button>
                <div className="guide-steps">Blobby listens through your microphone.</div>
              </>
            )
          ) : SUPPORTS_TAB_CAPTURE ? (
            <>
              <div><strong>One more step!</strong> Blobby needs your OK to hear this tab.</div>
              <button className="capture-btn big" onClick={() => startTabCapture(false)}>
                Let Blobby Listen
              </button>
              <div className="guide-steps">
                A popup will ask - switch on <em>Also share tab audio</em>, then click <em>Allow</em>.
              </div>
              <button className="guide-alt" onClick={() => startTabCapture(true)}>
                Music playing in a different tab? Capture that instead
              </button>
            </>
          ) : (
            <>
              <div><strong>One more step!</strong> Turn your volume up.</div>
              <button className="capture-btn big" onClick={startMicListen}>
                Let Blobby Listen
              </button>
              <div className="guide-steps">
                Blobby listens through your microphone - allow access when asked.
              </div>
            </>
          )}
        </div>
      )}

      {!isFullscreen && mode && showYtPopover && (
        <>
          <div className="search-backdrop" onClick={() => setShowYtPopover(false)} />
          <div className="search-popover">
            {youtubeUI}
          </div>
        </>
      )}

      {!isFullscreen && mode && (
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
              <button
                className={`tab ${showYtPopover || mode === 'youtube' ? 'active' : ''}`}
                onClick={() => setShowYtPopover(v => !v)}
              >
                YouTube
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

            {((mode === 'file' && hasVideo) || mode === 'youtube') && (
              <button
                className={`tab ${showVideo ? 'active' : ''}`}
                onClick={() => setShowVideo(v => !v)}
              >
                Video
              </button>
            )}

            {mode === 'youtube' && (
              <>
                <button
                  className={`tab ${ytLoop ? 'active' : ''}`}
                  onClick={toggleYtLoop}
                  title="Replay the video or playlist when it ends"
                >
                  Loop
                </button>
                {capturing ? (
                  <>
                    <span className="capture-live">
                      <span className="live-dot" />
                      {SUPPORTS_TAB_CAPTURE ? 'Capturing' : 'Listening'}
                    </span>
                    <button className="tab" onClick={stopYtAudio}>Stop</button>
                  </>
                ) : (
                  <button
                    className="capture-btn"
                    onClick={() => (SUPPORTS_TAB_CAPTURE ? startTabCapture(false) : startMicListen())}
                    title={SUPPORTS_TAB_CAPTURE
                      ? 'A popup will ask to share this tab - switch on "Also share tab audio", then click Allow'
                      : 'Blobby listens through your microphone'}
                  >
                    Let Blobby Listen
                  </button>
                )}
                {captureError && <span className="capture-error">{captureError}</span>}
                <span className="file-name">{fileName}</span>
              </>
            )}

            {mode === 'mic' && <span className="mic-label">Listening...</span>}

            {document.fullscreenEnabled && <button className="fullscreen-btn" onClick={toggleFullscreen} title="Toggle fullscreen">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <polyline points="1,5 1,1 5,1" />
                <polyline points="9,1 13,1 13,5" />
                <polyline points="13,9 13,13 9,13" />
                <polyline points="5,13 1,13 1,9" />
              </svg>
            </button>}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
