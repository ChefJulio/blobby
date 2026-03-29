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
const NUM_STARS = 120;

function createStars() {
  const stars = [];
  for (let i = 0; i < NUM_STARS; i++) {
    stars.push({
      // Position in 3D: x,y are -1 to 1 from center, z is depth (0=far, 1=near)
      x: (Math.random() - 0.5) * 2,
      y: (Math.random() - 0.5) * 2,
      z: Math.random(),
      speed: Math.random() * 0.0008 + 0.0004,
    });
  }
  return stars;
}

function drawStars(ctx, W, H, stars, blobRadius) {
  const cx = W / 2;
  const cy = H / 2;
  const rSq = blobRadius * blobRadius;
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    s.z += s.speed;
    if (s.z > 1) {
      s.z = Math.random() * 0.3;
      s.x = (Math.random() - 0.5) * 2;
      s.y = (Math.random() - 0.5) * 2;
      s.speed = Math.random() * 0.0015 + 0.0005;
    }
    // Project 3D -> 2D (perspective)
    const scale = s.z * s.z;
    const sx = cx + s.x / (1.01 - s.z) * cx * 0.8;
    const sy = cy + s.y / (1.01 - s.z) * cy * 0.8;
    if (sx < -10 || sx > W + 10 || sy < -10 || sy > H + 10) {
      s.z = Math.random() * 0.3;
      s.x = (Math.random() - 0.5) * 2;
      s.y = (Math.random() - 0.5) * 2;
      s.speed = Math.random() * 0.0015 + 0.0005;
      continue;
    }
    // Skip stars inside Blobby's area
    const dx = sx - cx, dy = sy - cy;
    if (dx * dx + dy * dy < rSq) continue;
    const size = scale * 2.5 + 0.3;
    const alpha = scale * 0.7 + 0.05;
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.beginPath();
    ctx.arc(sx, sy, size, 0, Math.PI * 2);
    ctx.fill();
  }
}

// --- Blobby Component ---

export default function Blobby({ audioSource }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const starsRef = useRef(null);
  if (!starsRef.current) starsRef.current = createStars();

  // Draw idle blob when no audio source
  useEffect(() => {
    if (audioSource) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const stars = starsRef.current;
    let raf;

    function drawIdle() {
      raf = requestAnimationFrame(drawIdle);
      const rect = container.getBoundingClientRect();
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
      ctx.fillStyle = BG_COLOR;
      ctx.fillRect(0, 0, W, H);

      const cx = W / 2;
      const cy = H / 2;
      const maxRadius = Math.min(W / 2, H / 2) - 4;
      const radius = maxRadius * 0.38;

      drawStars(ctx, W, H, stars, radius);

      // Circle outline
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      // Face
      const faceR = radius * 0.55;
      const faceColor = 'rgba(255,255,255,0.7)';
      ctx.fillStyle = faceColor;
      ctx.strokeStyle = faceColor;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      const eyeY = cy - faceR * 0.15;
      const eyeSpread = faceR * 0.35;
      const eyeR = faceR * 0.09;
      ctx.beginPath(); ctx.arc(cx - eyeSpread, eyeY, eyeR, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + eyeSpread, eyeY, eyeR, 0, Math.PI * 2); ctx.fill();
      const mouthY = cy + faceR * 0.1;
      const mR = faceR * 0.28;
      ctx.beginPath();
      ctx.arc(cx, mouthY, mR, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    }

    raf = requestAnimationFrame(drawIdle);
    return () => cancelAnimationFrame(raf);
  }, [audioSource]);

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
    let circSurpriseTimer = 0;
    let circRecentPeak = 0;
    let circSilenceTime = 0;
    let circBobble = 0;
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

      drawStars(ctx, W, H, starsRef.current, maxRadius);
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
        mirrored[i] = mixL;              // left side (CW from bottom)
        mirrored[NUM_BARS - 1 - i] = mixR; // right side (CCW from bottom)
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

      // ROYGBV trail colors
      const layerColors = [
        'rgba(255,30,30,0.7)', 'rgba(255,160,0,0.7)', 'rgba(0,255,70,0.7)',
        'rgba(0,120,255,0.7)', 'rgba(160,0,255,0.7)'
      ];

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

      // Trail fills (skip shadow on large canvases — too expensive fullscreen)
      const useGlow = W < 600;
      for (let l = 0; l < CIRC_LAYERS; l++) {
        const radii = toRadii(circTrails[l]);
        if (useGlow) {
          ctx.save();
          ctx.shadowColor = layerColors[l];
          ctx.shadowBlur = 8;
        }
        ctx.fillStyle = layerColors[l];
        ctx.beginPath();
        smoothPath(radii);
        ctx.closePath();
        ctx.fill();
        if (useGlow) ctx.restore();
      }

      // Black fill inside current shape
      const currentRadii = toRadii(current);
      ctx.fillStyle = BG_COLOR;
      ctx.beginPath();
      smoothPath(currentRadii);
      ctx.closePath();
      ctx.fill();

      // White border (no shadow fullscreen — the stroke itself is enough)
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      smoothPath(currentRadii);
      ctx.closePath();
      ctx.stroke();

      // Core bright line
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      smoothPath(currentRadii);
      ctx.closePath();
      ctx.stroke();

      // Face
      const faceR = innerRadius * 0.55;
      const faceColor = 'rgba(255,255,255,0.7)';
      ctx.fillStyle = faceColor;
      ctx.strokeStyle = faceColor;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';

      // Bass energy for face reactions
      const bassCount = 8;
      let bassEnergy = 0;
      for (let i = 0; i < bassCount; i++) {
        bassEnergy += current[i];
        bassEnergy += current[NUM_BARS - 1 - i];
      }
      bassEnergy = Math.min(1, bassEnergy / (bassCount * 2 * 0.1));

      // Asymmetric baseline
      const baseRate = bassEnergy > circFaceBaseline ? 0.15 : 0.08;
      circFaceBaseline += (bassEnergy - circFaceBaseline) * baseRate;
      const bassSpike = bassEnergy - circFaceBaseline;

      // :o surprise detection
      if (bassEnergy > circRecentPeak) circRecentPeak = bassEnergy;
      else circRecentPeak *= 0.99;
      if (bassEnergy < 0.03) circSilenceTime += dt;
      else circSilenceTime = 0;
      if (circRecentPeak > 0.35 && circSilenceTime > 0.3 && circGrinTimer <= 0 && circSurpriseTimer <= 0) {
        circSurpriseTimer = 0.8;
        circRecentPeak = 0;
        circSilenceTime = 0;
      }

      // :D grin detection
      if (bassSpike > 0.75) {
        circGrinTimer = Math.max(circGrinTimer, 3.0);
        circSurpriseTimer = 0;
      }
      circGrinTimer = Math.max(0, circGrinTimer - dt);
      circSurpriseTimer = Math.max(0, circSurpriseTimer - dt);
      const grin = circGrinTimer > 1 ? 1 : circGrinTimer;
      const surprise = circSurpriseTimer > 0.5 ? 1 : circSurpriseTimer * 2;

      const isSmiling = grin <= 0.5 && surprise <= 0.5;
      const bobbleTarget = isSmiling ? Math.sin(Date.now() * 0.004) * 2 : 0;
      circBobble += (bobbleTarget - circBobble) * 0.1;
      const faceCy = cy + circBobble;

      // Eyes
      const eyeY = faceCy - faceR * 0.15;
      const eyeSpread = faceR * 0.35;
      const eyeR = faceR * 0.09;
      ctx.beginPath(); ctx.arc(cx - eyeSpread, eyeY, eyeR, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + eyeSpread, eyeY, eyeR, 0, Math.PI * 2); ctx.fill();

      // Mouth
      const mouthY = faceCy + faceR * 0.1;
      if (grin > 0.5) {
        const mR = faceR * 0.4;
        ctx.beginPath();
        ctx.arc(cx, mouthY, mR, 0.05 * Math.PI, 0.95 * Math.PI);
        ctx.closePath();
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.fill();
        ctx.fillStyle = faceColor;
      } else if (surprise > 0.5) {
        const mR = faceR * 0.15;
        ctx.beginPath();
        ctx.arc(cx, mouthY + faceR * 0.05, mR, 0, Math.PI * 2);
        ctx.stroke();
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
