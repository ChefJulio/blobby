import { useState, useCallback, useRef } from 'react';
import Blobby from './Blobby';
import './App.css';

function App() {
  const [audioSource, setAudioSource] = useState(null);
  const [mode, setMode] = useState(null); // null | 'mic' | 'file'
  const [fileName, setFileName] = useState('');
  const audioCtxRef = useRef(null);
  const audioElRef = useRef(null);

  const setupAnalysers = useCallback((ctx, source, isMono) => {
    // Create splitter for L/R channels
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
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      setupAnalysers(ctx, source, false);
      setMode('mic');
    } catch (err) {
      console.error('Mic access denied:', err);
    }
  }, [setupAnalysers]);

  const handleFile = useCallback((file) => {
    if (!file || !file.type.startsWith('audio/')) return;
    setFileName(file.name);

    // Clean up previous
    if (audioElRef.current) { audioElRef.current.pause(); audioElRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close(); }

    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.src = URL.createObjectURL(file);
    audioElRef.current = audio;

    const source = ctx.createMediaElementSource(audio);
    setupAnalysers(ctx, source, false);
    audio.play();
    setMode('file');
  }, [setupAnalysers]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleFileInput = useCallback((e) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

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

      {mode === 'file' && (
        <div className="file-controls">
          <span className="file-name">{fileName}</span>
          <label className="file-button small">
            Change
            <input type="file" accept="audio/*" onChange={handleFileInput} hidden />
          </label>
        </div>
      )}

      {mode === 'mic' && (
        <div className="file-controls">
          <span className="file-name">Listening to microphone...</span>
        </div>
      )}
    </div>
  );
}

export default App;
