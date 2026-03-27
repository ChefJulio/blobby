# Blobby

A cute audio-reactive blob visualizer. Drop a song on him and watch him dance.

**[Try it live](https://chefjulio.github.io/blobby/)**

## Features

- Smooth bezier blob shape driven by frequency spectrum
- L/R stereo channel separation (panned elements show on their side)
- 5 neon trail layers (red, orange, green, blue, purple) with rotating prominence
- Dynamic per-bin threshold so only real peaks punch through
- Auto-normalization adapts to any track's loudness
- Drop detection triggers a :D grin on energy spikes
- Bass at bottom, highs at top
- Microphone input or audio file drag-and-drop

## Getting Started

```bash
npm install
npm run dev
```

Open http://localhost:5173, drop an audio file or click "Use Microphone".

## How It Works

Blobby reads real-time frequency data from the Web Audio API's AnalyserNode. The raw FFT bins are mapped to 64 logarithmic frequency bands, smoothed, and split by stereo channel (left channel drives the right side, right channel drives the left side — mirrored so panned elements appear on the listener's corresponding side). Bass frequencies blend at the bottom seam so both sides converge on kicks. The result is drawn as a smooth closed bezier curve around a central circle.

Five trail layers track peak amplitudes with different decay rates, creating neon afterglow rings when peaks recede. A rotating prominence cycle ensures each color takes turns being the most visible.

The smiley face tracks overall energy against a slow-moving baseline. When energy spikes well above the baseline (a "drop"), Blobby grins for a few seconds before relaxing back to a gentle smile.

## Origin

Extracted from [Overtooled](https://github.com/ChefJulio/overtooled)'s Audio Lab visualizer.

## License

MIT
