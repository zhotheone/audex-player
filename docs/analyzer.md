# AudioAnalyzer Specification

## 1. Overview & Architecture

`AudioAnalyzer` is a real-time audio analysis module designed for reactive visualizers (such as JS骨 / JSNation visualizer shaders and Three.js scenes). It operates directly on Web Audio frequency data to extract normalized spectral bands, energy scores, visualizer curve multipliers, and rhythmic bass transients.

```
┌────────────────────────────────────────────────────────┐
│                   Web Audio Pipeline                   │
│                                                        │
│   AudioSource (MediaElement / Buffer)                  │
│             │                                          │
│             ▼                                          │
│   AnalyserNode (FFT Size = 1024, minDb = -40, maxDb = -30)
│             │                                          │
│             ▼ ByteFrequencyData (Uint8Array[512])      │
│   ┌────────────────────────────────────────────────┐   │
│   │ Feature Extraction Engine (computeJsNationFeatures)│
│   │  • Savitzky-Golay 3-point smoothing            │   │
│   │  • JSNation Non-linear Multiplier Curve        │   │
│   │  • 5 Logarithmic Frequency Slice Bands         │   │
│   │  • Perceptual Frequency-Weighted Energy        │   │
│   │  • Bass Flux / Transient Onset Detection       │   │
│   └────────────────────────┬───────────────────────┘   │
└────────────────────────────┼───────────────────────────┘
                             │
                             ▼ requestAnimationFrame Loop (~60 Hz)
┌────────────────────────────────────────────────────────┐
│             AudioAnalyzerNode Subscribers              │
│                                                        │
│   audioFeatures = {                                    │
│       energy, multiplier, bass, lowMid, mid,           │
│       highMid, high, onset, beat, bpm, spectrum        │
│   }                                                    │
└────────────────────────────────────────────────────────┘
```

---

## 2. Output Data Contract

`AudioAnalyzerNode` emits real-time audio feature objects to all registered subscribers on every frame:

```javascript
audioFeatures = {
  energy: 0.72,       // [0.0 - 1.0] Perceptually weighted total audio energy score
  multiplier: 0.65,   // [0.0 - 1.0] JSNation non-linear visualizer curve multiplier
  bass: 0.91,         // [0.0 - 1.0] Sub-bass & Bass range (~20 Hz - 250 Hz)
  lowMid: 0.63,       // [0.0 - 1.0] Low-mid frequencies (~250 Hz - 500 Hz)
  mid: 0.48,          // [0.0 - 1.0] Mid-range vocals & fundamentals (~500 Hz - 2,000 Hz)
  highMid: 0.35,      // [0.0 - 1.0] High-mids & presence (~2,000 Hz - 6,000 Hz)
  high: 0.21,         // [0.0 - 1.0] Treble & harmonics (~6,000 Hz - 20,000 Hz)
  onset: 0.45,        // [0.0 - 1.0] Instantaneous positive bass energy delta (transient)
  beat: true,         // Boolean: True when bass energy exceeds peak threshold (0.35)
  bpm: 120,           // Nominal tempo placeholder (120 BPM)
  spectrum: Float32Array(40) // 40-bin smoothed lower spectrum for visualizer geometry
};
```

---

## 3. Core Algorithms & Signal Processing

### 3.1 Spectrum Smoothing & JSNation Multiplier
The lower 40 bins (starting at bin 8 for large FFT sizes) represent the musical foundation. A 3-point moving average (Savitzky-Golay smoothing) is applied to eliminate spectral jitter:

$$\text{spectrum}[i] = \frac{\text{raw}[i-1] + \text{raw}[i] + \text{raw}[i+1]}{3}$$

The dynamic `multiplier` uses a polynomial expansion ($t = 1.2$) for exponential visual scaling:

$$\text{intermediate} = \frac{1}{40} \sum_{i=0}^{39} \frac{\text{spectrum}[i]}{256}$$
$$\text{rawMult} = \frac{1}{t - 1} \left( -\text{intermediate}^t + t \cdot \text{intermediate} \right)$$
$$\text{multiplier} = \max(0, \text{rawMult})^{0.8}$$

---

### 3.2 5-Band Logarithmic Slicing
Normalized frequency slices are extracted across the 512 FFT bins:

| Band Key | Fractional Range | Equivalent Frequencies ($f_s = 48\text{ kHz}$) | Musical Range |
|:---|:---|:---|:---|
| `bass` | `0.0005 - 0.015` | $\approx 20\text{ Hz} - 250\text{ Hz}$ | Kick, 808s, sub-bass |
| `lowMid` | `0.015 - 0.035` | $\approx 250\text{ Hz} - 500\text{ Hz}$ | Bass guitar body, snare warmth |
| `mid` | `0.035 - 0.12` | $\approx 500\text{ Hz} - 2,000\text{ Hz}$ | Vocals, lead instruments |
| `highMid` | `0.12 - 0.35` | $\approx 2,000\text{ Hz} - 6,000\text{ Hz}$ | Snare attack, presence, guitars |
| `high` | `0.35 - 0.95` | $\approx 6,000\text{ Hz} - 20,000\text{ Hz}$ | Hi-hats, cymbals, air, sibilance |

Each band's value is calculated from the mean and peak in the range:
$$\text{band} = \min\left(1.0, \max\left(\frac{\text{peak}}{255}, \frac{\text{mean}}{255} \cdot 4.0\right)\right)$$

---

### 3.3 Perceptual Energy Score
Total energy combines raw peak/average loudness with weighted perceptual band energy:

- **Band Weights**: $W_{\text{low}} = 0.8$, $W_{\text{mid}} = 1.3$, $W_{\text{high}} = 1.0$
- **Weighted Energy**:
  $$\text{weightedEnergy} = \frac{(\text{bass} \cdot 0.8) + \left(\frac{\text{lowMid} + \text{mid}}{2} \cdot 1.3\right) + \left(\frac{\text{highMid} + \text{high}}{2} \cdot 1.0\right)}{3}$$
- **Final Energy**:
  $$\text{overallLevel} = \max(\text{peakNorm}, \text{avgLevel} \cdot 2.5)$$
  $$\text{rawEnergy} = (\text{overallLevel} \cdot 0.4) + (\text{weightedEnergy} \cdot 0.6)$$
  $$\text{energy} = \min(1.0, \max(\text{rawEnergy} \cdot 2.0, \text{multiplier}))$$

---

### 3.4 Transient & Beat Detection
- **Onset (Bass Flux)**: Measures positive rate-of-change in bass energy between consecutive frames:
  $$\text{onset} = \max(0, \text{bass}_t - \text{bass}_{t-1})$$
- **Beat Trigger**: Simple dynamic comparator:
  $$\text{beat} = \text{bass}_t > 0.35$$

---

## 4. Offline Track Energy Calculation

`calculateTrackEnergy(audioBuffer)` calculates an overall loudness rating ($0.0 - 1.0$) for a full audio track using `OfflineAudioContext` with 3 parallel Biquad filters:
1. **Lowpass** ($250\text{ Hz}$) $\rightarrow$ Bass RMS
2. **Bandpass** ($1500\text{ Hz}, Q = 0.5$) $\rightarrow$ Mid RMS
3. **Highpass** ($4000\text{ Hz}$) $\rightarrow$ High RMS

Calculates the weighted RMS across the rendered buffer:
$$\text{TrackEnergy} = \text{clamp}\Big( \big(0.4 \cdot \text{overallRMS} + 0.6 \cdot \text{weightedRMS}\big) \cdot 4.0, \; 0.0, \; 1.0 \Big)$$

---

## 5. API Reference (`analyzer.js`)

### `AudioAnalyzerNode`

#### Methods
- `constructor(audioCtx)`: Initializes the analyzer instance with an existing `AudioContext`.
- `async init()`: Creates the underlying `AnalyserNode` (`fftSize = 1024`, `smoothingTimeConstant = 0.1`, `minDecibels = -40`, `maxDecibels = -30`) and starts the frame loop.
- `connectSource(sourceNode)`: Connects an `AudioNode` (e.g. `MediaElementAudioSourceNode`) to the analyzer.
- `subscribe(callback)`: Registers a listener callback `(features) => void`. Returns an unsubscribe function.
- `getFeatures()`: Returns the latest cached `audioFeatures` object synchronously.
- `destroy()`: Cleans up listeners and cancels active animation frame / interval timers.

---

## 6. Usage Example

```javascript
import { AudioAnalyzerNode } from './analyzer.js';

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const analyzer = new AudioAnalyzerNode(audioCtx);
await analyzer.init();

const audioElement = document.querySelector('audio');
const sourceNode = audioCtx.createMediaElementSource(audioElement);

analyzer.connectSource(sourceNode);
sourceNode.connect(audioCtx.destination);

// Subscribe to real-time audio features
const unsubscribe = analyzer.subscribe((features) => {
  const { energy, multiplier, bass, beat, spectrum } = features;
  
  // Drive visualizer uniforms / meshes
  visualizer.update({
    intensity: energy,
    scale: 1.0 + multiplier * 0.5,
    kick: beat ? 1.0 : 0.0,
    spectrum
  });
});
```
