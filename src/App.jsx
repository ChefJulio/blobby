import { useState, useCallback, useRef } from 'react';
import Blobby from './Blobby';
import './App.css';

function App() {
  const [audioSource, setAudioSource] = useState(null);
  const [mode, setMode] = useState(null); // null | 'mic' | 'file'
  const [fileName, setFileName] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioCtxRef = useRef(null);
  const audioElRef = useRef(null);
  const micStreamRef = useRef(null);
  const rafRef = useRef(null);

  const cleanup = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (audioElRef.current) { audioElRef.current.pause(); audioElRef.current = null; }
    if (micStreamRef.current) { micStreamRef.current.getTracks().forEach(t => t.stop()); micStreamRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null; }
    setAudioSource(null);
    setIsPlaying(false);
    setProgress(0);
    setDuration(0);
  }, []);

  const setupAnalysers = useCallback((ctx, source, isMono) => {
    const splitter = ctx.createChannelSplitter(2);
    source.connect(splitter);
    source.connect(ctx.destination);

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
      setupAnalysers(ctx, source, false);
      setMode('mic');
    } catch (err) {
      console.error('Mic access denied:', err);
    }
  }, [setupAnalysers, cleanup]);

  const startProgressLoop = useCallback((audio) => {
    function tick() {
      if (audio && !audio.paused) {
        setProgress(audio.currentTime);
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const handleFile = useCallback((file) => {
    if (!file || !file.type.startsWith('audio/')) return;
    cleanup();
    setFileName(file.name);

    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.src = URL.createObjectURL(file);
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
    startProgressLoop(audio);
  }, [setupAnalysers, cleanup, startProgressLoop]);

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

  const seek = useCallback((e) => {
    const audio = audioElRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = t * duration;
    setProgress(audio.currentTime);
  }, [duration]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

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

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      <div className="blobby-container">
        <Blobby audioSource={audioSource} />
      </div>

      {!mode && (
        <div className="controls-overlay">
          <h1>Blobby</h1>
          <p>Drop an audio file or use your mic</p>
          <div className="buttons">
            <button onClick={startMic}>Use Microphone</button>
            <label className="file-button">
              Choose File
              <input type="file" accept="audio/*" onChange={handleFileInput} hidden />
            </label>
          </div>
        </div>
      )}

      {mode && (
        <div className="bottom-bar">
          <div className="bar-row">
            {/* Source switcher */}
            <div className="source-tabs">
              <button className={`tab ${mode === 'file' ? 'active' : ''}`} onClick={() => document.getElementById('file-pick').click()}>
                File
              </button>
              <button className={`tab ${mode === 'mic' ? 'active' : ''}`} onClick={startMic}>
                Mic
              </button>
              <input id="file-pick" type="file" accept="audio/*" onChange={handleFileInput} hidden />
            </div>

            {/* Player controls (file mode only) */}
            {mode === 'file' && (
              <>
                <button className="play-btn" onClick={togglePlay}>
                  {isPlaying ? '||' : '\u25B6'}
                </button>
                <span className="time">{formatTime(progress)}</span>
                <div className="seek-bar" onClick={seek}>
                  <div className="seek-fill" style={{ width: duration ? `${(progress / duration) * 100}%` : '0%' }} />
                </div>
                <span className="time">{formatTime(duration)}</span>
              </>
            )}

            {mode === 'mic' && <span className="mic-label">Listening...</span>}

            {/* File name */}
            {mode === 'file' && <span className="file-name">{fileName}</span>}

            {/* New file */}
            <label className="file-button small">
              {mode === 'file' ? 'Change' : 'Load File'}
              <input type="file" accept="audio/*" onChange={handleFileInput} hidden />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
