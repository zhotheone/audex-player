# AudioAnalyzer Specification

## 1. Overview

`AudioAnalyzer` is a lightweight audio analysis wrapper implementing **pure JsNation feature extraction** for visualizers. It operates on Web Audio frequency data without custom or speculative band estimations.

```
┌────────────────────────────────────────────────────────┐
│                   Web Audio Pipeline                   │
│                                                        │
│   AudioSource (MediaElement / AudioNode)               │
│             │                                          │
│             ▼                                          │
│   AnalyserNode (FFT Size = 1024, minDb = -90, maxDb = -25)
│             │                                          │
│             ▼ ByteFrequencyData (Uint8Array[512])      │
│   ┌────────────────────────────────────────────────┐   │
│   │ JsNation Feature Extraction                    │   │
│   │  • 40 Frequency Bins (Bins 8–48)               │   │
│   │  • Savitzky-Golay 3-point Smoothing            │   │
│   │  • Polynomial Non-linear Multiplier            │   │
│   └────────────────────────┬───────────────────────┘   │
└────────────────────────────┼───────────────────────────┘
                             │
                             ▼ requestAnimationFrame Loop (~60 Hz)
┌────────────────────────────────────────────────────────┐
│             AudioAnalyzerNode Subscribers              │
│                                                        │
│   features = {                                         │
│       multiplier: 0.65,                                │
│       spectrum: Float32Array(40)                       │
│   }                                                    │
└────────────────────────────────────────────────────────┘
```

---

## 2. Output Data Contract

```javascript
audioFeatures = {
  multiplier: 0.65,          // [0.0 - 1.0] JsNation non-linear visualizer curve multiplier
  spectrum: Float32Array(40) // 40-bin smoothed lower spectrum
};
```

---

## 3. Core Algorithm (JsNation)

### 3.1 Spectrum Extraction & 3-Point Smoothing
The lower 40 bins (starting at bin 8) represent the active visual spectrum:

$$\text{spectrum}[i] = \frac{\text{raw}[i-1] + \text{raw}[i] + \text{raw}[i+1]}{3}$$

### 3.2 Non-Linear Multiplier
Calculated from the mean of the 40 smoothed bins with polynomial curve expansion ($t = 1.2$):

$$\text{intermediate} = \frac{1}{40} \sum_{i=0}^{39} \frac{\text{spectrum}[i]}{256}$$
$$\text{rawMult} = \frac{1}{t - 1} \left( -\text{intermediate}^t + t \cdot \text{intermediate} \right)$$
$$\text{multiplier} = \max(0, \text{rawMult})^{0.8}$$

---

## 4. API Reference (`analyzer.js`)

### `AudioAnalyzerNode`
- `constructor(audioCtx)`: Creates instance with an `AudioContext`.
- `async init()`: Instantiates `AnalyserNode` and begins RAF update loop.
- `connectSource(sourceNode)`: Connects an audio source node to the analyser.
- `subscribe(callback)`: Registers listener for `{ multiplier, spectrum }`. Returns unsubscribe function.
- `getFeatures()`: Returns latest features synchronously.
- `destroy()`: Cleans up listeners and cancels animation frames.
