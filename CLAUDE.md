# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Blobby is an interactive audio-reactive blob visualizer built with React 19 + Vite 8 + Canvas 2D. A cute animated blob dances in response to audio from YouTube (via tab capture), microphone input, or drag-and-drop audio/video files. Extracted from [Overtooled](https://github.com/ChefJulio/overtooled)'s Audio Lab visualizer.

## Build Commands

```bash
npm install        # Install dependencies
npm run dev        # Vite dev server (http://localhost:5173)
npm run build      # Production build to dist/
npm run lint       # ESLint (React + Hooks plugins)
npm run preview    # Preview production build locally
```

No test suite exists. Validate manually: `npm run dev`, test mic input, drag-drop audio files, check face expressions on bass drops, verify playback controls.

## Architecture

### Audio Pipeline (App.jsx)

Three sources: mic via `getUserMedia()` (mono, voice-call processing disabled), local file via a `<video>` element, or pasted links (mode `'link'`: YouTube via the IFrame Player API, Spotify/SoundCloud via their official embed iframes) whose audio reaches the analysers through `getDisplayMedia()` tab capture on desktop Chromium, or the mic fallback elsewhere. Every source feeds Web Audio's `AudioContext`; a `ChannelSplitter` creates three `AnalyserNode` instances (mixed, left, right) passed as `audioSource` prop to Blobby.

```
File/Mic/TabCapture → AudioContext → ChannelSplitter → [analyserMixed, analyserL, analyserR]
```

Link-mode specifics: direct stream audio is impossible for all three services (no CORS; Web Audio outputs silence for tainted media) - tab capture is the only web-app path. Spotify embeds play full tracks only for logged-in Premium users (30s previews otherwise). All controls live in the bottom-center player card (`.player-card`), which stays mounted (visibility-hidden) in fullscreen/hidden states so embeds keep playing. Audius streaming existed before link support and was removed in July 2026 (git history has it).

### Visualization Engine (Blobby.jsx)

Single `requestAnimationFrame` loop in `draw()` processes audio and renders each frame:

1. **FFT extraction**: `getByteFrequencyData()` from L/R analysers (2048-bin FFT)
2. **Log bin mapping**: `buildLogBinMap()` maps raw FFT bins to 64 log-spaced frequency bands
3. **Smoothing**: 4-pass 3-point filter on both channels
4. **Stereo mirroring**: L channel → right semicircle, R → left semicircle, quadratic blend at bass frequencies
5. **Auto-normalization**: Dynamic peak tracking adapts to track loudness
6. **Per-bin thresholding**: Dynamic baselines prevent noise artifacts

### Trail System

5 neon trail layers (Red, Orange, Green, Blue, Purple) with independent amplitude arrays. Each decays at different rates (0.87-0.94). A rotating prominence cycle (~12.5s period) makes each color take turns being most visible.

### Face Expressions

Bass energy (bottom 8 bands) drives an asymmetric baseline tracker. Expressions:
- **Grin** (:D) — bass spike > 0.75, 3-second minimum hold
- **Surprise** (:o) — sudden silence after peak
- **Smile** (:) — default, gentle bobble when signal present

### Performance

- `useGlow` disabled when canvas > 600px width (skips `shadowBlur`)
- Reuses typed arrays in draw loop (no per-frame allocation)
- DPI-aware canvas scaling via `devicePixelRatio`

## Key Tuning Parameters (Blobby.jsx)

| Parameter | Value | Effect |
|-----------|-------|--------|
| `NUM_BARS` | 64 | Angular resolution of blob |
| `CIRC_LAYERS` | 5 | Number of trail layers |
| `circPeakTracker` decay | 0.992 | Auto-normalization speed |
| Smoothing passes | 4 | Shape smoothness vs reactivity |
| Trail decay range | 0.87-0.94 | Tail persistence |

## Deployment

Deployed to GitHub Pages. Vite base path is `/blobby/` (configured in `vite.config.js`).
