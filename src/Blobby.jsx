import { useRef, useEffect, useState, useCallback } from 'react';

// --- Audio utility functions ---

function buildLogBinMap(fftSize, sampleRate, numBars) {
  const binCount = fftSize / 2;
  const nyquist = sampleRate / 2;
  const minFreq = 20;
  const maxFreq = Math.min(nyquist, 20000);
  const logMin = Math.log10(minFreq);
  const logMax = Math.log10(maxFreq);
  const logStep = (logMax - logMin) / numBars;
  const map = [];
  for (let i = 0; i < numBars; i++) {
    const freqLo = Math.pow(10, logMin + i * logStep);
    const freqHi = Math.pow(10, logMin + (i + 1) * logStep);
    const startBin = Math.max(1, Math.round((freqLo / nyquist) * binCount));
    const endBin = Math.min(binCount - 1, Math.round((freqHi / nyquist) * binCount));
    map.push({ startBin, endBin: Math.max(startBin, endBin), centerFreq: Math.sqrt(freqLo * freqHi) });
  }
  return map;
}

function averageBins(freqData, binMap) {
  const result = new Float32Array(binMap.length);
  for (let i = 0; i < binMap.length; i++) {
    const { startBin, endBin } = binMap[i];
    let sum = 0, count = 0;
    for (let b = startBin; b <= endBin; b++) { sum += freqData[b]; count++; }
    result[i] = count > 0 ? sum / count : 0;
  }
  return result;
}

// --- Constants ---
const NUM_BARS = 64;
const CIRC_LAYERS = 5;
const BG_COLOR = '#08060f';

// --- Blobby Component ---

export default function Blobby({ audioSource }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!audioSource) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const { analyserL, analyserR, analyserMixed, isMono } = audioSource;

    // Setup
    const binMap = buildLogBinMap(analyserMixed.fftSize, analyserMixed.context.sampleRate, NUM_BARS);
    const freqData = new Uint8Array(analyserMixed.frequencyBinCount);
    const freqL = new Uint8Array(analyserL.frequencyBinCount);
    const freqR = new Uint8Array(analyserR.frequencyBinCount);

    // Persistent state
    const circTrails = [];
    for (let l = 0; l < CIRC_LAYERS; l++) circTrails.push(new Float32Array(NUM_BARS));
    const circAvg = new Float32Array(NUM_BARS);
    let circPeakTracker = 0.01;
    let circFaceBaseline = 0;
    let circGrinTimer = 0;
    let lastTs = 0;
    let raf;

    function draw(timestamp) {
      raf = requestAnimationFrame(draw);
      const dt = lastTs ? (timestamp - lastTs) / 1000 : 0.016;
      lastTs = timestamp;

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const W = rect.width;
      const H = rect.height;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        canvas.style.width = W + 'px';
        canvas.style.height = H + 'px';
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Read frequency data
      analyserMixed.getByteFrequencyData(freqData);
      if (!isMono) {
        analyserL.getByteFrequencyData(freqL);
        analyserR.getByteFrequencyData(freqR);
      }

      const binned = averageBins(freqData, binMap);
      const binnedL = isMono ? binned : averageBins(freqL, binMap);
      const binnedR = isMono ? binned : averageBins(freqR, binMap);

      // Clear
      ctx.fillStyle = BG_COLOR;
      ctx.fillRect(0, 0, W, H);

      // --- Blobby drawing ---
      const cx = W / 2;
      const cy = H / 2;
      const maxRadius = Math.min(W / 2, H / 2) - 4;
      const innerRadius = maxRadius * 0.38;
      const barMaxLen = maxRadius - innerRadius;
      const angleStep = (Math.PI * 2) / NUM_BARS;
      const startAngle = Math.PI / 2;
      const half = NUM_BARS >> 1;

      // Smooth each channel: 4 passes
      const smL = new Float32Array(NUM_BARS);
      const smR = new Float32Array(NUM_BARS);
      for (let i = 0; i < NUM_BARS; i++) { smL[i] = binnedL[i] / 255; smR[i] = binnedR[i] / 255; }
      for (let pass = 0; pass < 4; pass++) {
        const tmpL = Float32Array.from(smL);
        const tmpR = Float32Array.from(smR);
        for (let i = 0; i < NUM_BARS; i++) {
          smL[i] = tmpL[(i - 1 + NUM_BARS) % NUM_BARS] * 0.2 + tmpL[i] * 0.6 + tmpL[(i + 1) % NUM_BARS] * 0.2;
          smR[i] = tmpR[(i - 1 + NUM_BARS) % NUM_BARS] * 0.2 + tmpR[i] * 0.6 + tmpR[(i + 1) % NUM_BARS] * 0.2;
        }
      }

      // Mirror with L/R channels, blend at bass seam
      const mirrored = new Float32Array(NUM_BARS);
      for (let i = 0; i < half; i++) {
        const t = i / (half - 1);
        const binF = t * (NUM_BARS - 1);
        const lo = Math.floor(binF);
        const hi = Math.min(lo + 1, NUM_BARS - 1);
        const frac = binF - lo;
        const valL = smL[lo] * (1 - frac) + smL[hi] * frac;
        const valR = smR[lo] * (1 - frac) + smR[hi] * frac;
        const blend = 1 - (i / (half - 1));
        const blendW = blend * blend;
        const mixR = valR * (1 - blendW) + ((valL + valR) / 2) * blendW;
        const mixL = valL * (1 - blendW) + ((valL + valR) / 2) * blendW;
        mirrored[i] = mixR;              // right side (CW from bottom)
        mirrored[NUM_BARS - 1 - i] = mixL; // left side (CCW from bottom)
      }

      // Auto-normalization
      let frameMax = 0;
      for (let i = 0; i < NUM_BARS; i++) { if (mirrored[i] > frameMax) frameMax = mirrored[i]; }
      if (frameMax > circPeakTracker) {
        circPeakTracker += (frameMax - circPeakTracker) * 0.3;
      } else {
        circPeakTracker *= 0.992;
      }
      circPeakTracker = Math.max(circPeakTracker, 0.02);

      // Dynamic per-bin threshold
      const current = new Float32Array(NUM_BARS);
      for (let i = 0; i < NUM_BARS; i++) {
        const norm = Math.min(1, mirrored[i] / circPeakTracker);
        circAvg[i] += (norm - circAvg[i]) * 0.008;
        const spike = Math.max(0, norm - circAvg[i]);
        const headroom = Math.max(0.01, 1 - circAvg[i]);
        current[i] = Math.pow(Math.min(1, spike / headroom), 0.9);
      }

      // Trail layers with rotating prominence
      const cycle = (Date.now() * 0.001 * 0.4) % CIRC_LAYERS;
      const decays = [];
      for (let l = 0; l < CIRC_LAYERS; l++) {
        const dist = Math.abs(((l - cycle + CIRC_LAYERS) % CIRC_LAYERS) - 0);
        const prominence = Math.max(0, 1 - dist / (CIRC_LAYERS * 0.5));
        decays.push(0.87 + prominence * 0.07);
      }
      for (let l = 0; l < CIRC_LAYERS; l++) {
        for (let i = 0; i < NUM_BARS; i++) {
          circTrails[l][i] = Math.max(circTrails[l][i] * decays[l], current[i]);
        }
      }

      const layerColors = [
        'rgba(0,255,70,0.7)', 'rgba(255,40,40,0.7)', 'rgba(0,120,255,0.7)',
        'rgba(255,50,200,0.45)', 'rgba(255,150,250,0.35)'
      ];

      // Path helpers
      function smoothPath(radii) {
        const aL = startAngle + (NUM_BARS - 1) * angleStep;
        ctx.moveTo(
          (cx + Math.cos(aL) * radii[NUM_BARS - 1] + cx + Math.cos(startAngle) * radii[0]) / 2,
          (cy + Math.sin(aL) * radii[NUM_BARS - 1] + cy + Math.sin(startAngle) * radii[0]) / 2
        );
        for (let i = 0; i < NUM_BARS; i++) {
          const a = startAngle + i * angleStep;
          const cpx = cx + Math.cos(a) * radii[i];
          const cpy = cy + Math.sin(a) * radii[i];
          const ni = (i + 1) % NUM_BARS;
          const na = startAngle + ni * angleStep;
          const nx = cx + Math.cos(na) * radii[ni];
          const ny = cy + Math.sin(na) * radii[ni];
          ctx.quadraticCurveTo(cpx, cpy, (cpx + nx) / 2, (cpy + ny) / 2);
        }
      }

      function toRadii(amps) {
        const r = new Float32Array(NUM_BARS);
        for (let i = 0; i < NUM_BARS; i++) r[i] = innerRadius + amps[i] * barMaxLen;
        return r;
      }

      // Draw trail strokes
      for (let l = 0; l < CIRC_LAYERS; l++) {
        const radii = toRadii(circTrails[l]);
        ctx.save();
        ctx.shadowColor = layerColors[l];
        ctx.shadowBlur = 6;
        ctx.strokeStyle = layerColors[l];
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        smoothPath(radii);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }

      // Black fill inside current shape
      const currentRadii = toRadii(current);
      ctx.fillStyle = BG_COLOR;
      ctx.beginPath();
      smoothPath(currentRadii);
      ctx.closePath();
      ctx.fill();

      // Glowing white border
      ctx.save();
      ctx.shadowColor = 'rgba(180,200,255,0.6)';
      ctx.shadowBlur = 20;
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 4;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      smoothPath(currentRadii);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.shadowColor = 'rgba(200,220,255,0.7)';
      ctx.shadowBlur = 10;
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      smoothPath(currentRadii);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();

      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      smoothPath(currentRadii);
      ctx.closePath();
      ctx.stroke();

      // Face :) / :D
      const faceR = innerRadius * 0.55;
      const faceColor = 'rgba(255,255,255,0.7)';
      ctx.fillStyle = faceColor;
      ctx.strokeStyle = faceColor;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';

      // Drop detection
      let rawEnergy = 0;
      for (let i = 0; i < NUM_BARS; i++) rawEnergy += current[i];
      rawEnergy = Math.min(1, rawEnergy / (NUM_BARS * 0.12));
      circFaceBaseline += (rawEnergy - circFaceBaseline) * 0.01;
      const faceSpike = rawEnergy - circFaceBaseline;
      if (faceSpike > 0.25) circGrinTimer = 3.0;
      circGrinTimer = Math.max(0, circGrinTimer - dt);
      const e = circGrinTimer > 1 ? 1 : circGrinTimer;

      // Eyes
      const eyeY = cy - faceR * 0.15;
      const eyeSpread = faceR * 0.35;
      const eyeR = faceR * 0.09;
      ctx.beginPath(); ctx.arc(cx - eyeSpread, eyeY, eyeR, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + eyeSpread, eyeY, eyeR, 0, Math.PI * 2); ctx.fill();

      // Mouth
      const mouthY = cy + faceR * 0.1;
      if (e > 0.5) {
        const mR = faceR * 0.4;
        ctx.beginPath();
        ctx.arc(cx, mouthY, mR, 0.05 * Math.PI, 0.95 * Math.PI);
        ctx.closePath();
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.fill();
      } else {
        const mR = faceR * 0.28;
        ctx.beginPath();
        ctx.arc(cx, mouthY, mR, 0.15 * Math.PI, 0.85 * Math.PI);
        ctx.stroke();
      }
    }

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [audioSource]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', background: BG_COLOR }}>
      <canvas ref={canvasRef} style={{ display: 'block' }} />
    </div>
  );
}
