function calcJsNationMultiplier(spectrum) {
  let sum = 0;
  const count = spectrum.length || 40;
  for (let i = 0; i < count; i++) sum += (spectrum[i] || 0);
  const intermediate = sum / count / 256;
  const t = 1.2;
  const rawMult = (1 / (t - 1)) * (-Math.pow(intermediate, t) + t * intermediate);
  return Math.pow(Math.max(0, rawMult), 0.8);
}

function computeJsNationFeatures(freqData, sampleRate = 48000, currentTime = 0, state = {}) {
  const len = freqData.length;
  const START_BIN = 8;
  const KEEP_BINS = 40;
  const isLarge = len >= 2048;
  const start = isLarge ? START_BIN : Math.min(1, len - 1);
  const count = Math.min(KEEP_BINS, len - start);

  const raw = new Float32Array(count);
  for (let i = 0; i < count; i++) raw[i] = freqData[start + i];

  // Savitzky-Golay 3-point moving average smoothing
  const spectrum = new Float32Array(count);
  spectrum[0] = raw[0];
  for (let i = 1; i < count - 1; i++) {
    spectrum[i] = (raw[i - 1] + raw[i] + raw[i + 1]) / 3;
  }
  if (count > 1) spectrum[count - 1] = raw[count - 1];

  const multiplier = calcJsNationMultiplier(spectrum);

  // Band calculations
  const getSlice = (sFrac, eFrac) => {
    let s = 0, max = 0;
    const sIdx = Math.floor(sFrac * len);
    const eIdx = Math.min(len - 1, Math.floor(eFrac * len));
    const span = eIdx - sIdx + 1;
    for (let i = sIdx; i <= eIdx; i++) {
      const v = freqData[i];
      s += v;
      if (v > max) max = v;
    }
    return span > 0 ? Math.min(1.0, Math.max(max / 255, (s / (span * 255)) * 4.0)) : 0;
  };

  // Frequency bands (bass: ~20-250Hz, lowMid: ~250-500Hz, mid: ~500-2000Hz, highMid: ~2-6kHz, high: ~6-20kHz)
  const bass = isLarge ? getSlice(0.0005, 0.015) : getSlice(0.001, 0.015);
  const lowMid = isLarge ? getSlice(0.015, 0.035) : getSlice(0.015, 0.035);
  const mid = isLarge ? getSlice(0.035, 0.12) : getSlice(0.035, 0.12);
  const highMid = isLarge ? getSlice(0.12, 0.35) : getSlice(0.12, 0.35);
  const high = isLarge ? getSlice(0.35, 0.95) : getSlice(0.35, 0.95);

  let sum = 0, maxVal = 0;
  for (let i = 0; i < len; i++) {
    const v = freqData[i];
    sum += v;
    if (v > maxVal) maxVal = v;
  }
  const peakNorm = maxVal / 255;
  const avgLevel = sum / (len * 255);
  const energy = Math.min(1.0, Math.max(peakNorm, avgLevel * 2.5, multiplier));

  const prevBass = state.prevBass || 0;
  const bassFlux = Math.max(0, bass - prevBass);
  state.prevBass = bass;

  return {
    energy: Math.round(energy * 100) / 100,
    multiplier: Math.round(multiplier * 100) / 100,
    bass: Math.round(bass * 100) / 100,
    lowMid: Math.round(lowMid * 100) / 100,
    mid: Math.round(mid * 100) / 100,
    highMid: Math.round(highMid * 100) / 100,
    high: Math.round(high * 100) / 100,
    onset: Math.round(bassFlux * 100) / 100,
    beat: bass > 0.35,
    bpm: 120,
    spectrum
  };
}

const PROCESSOR_CODE = `
${calcJsNationMultiplier.toString()}
${computeJsNationFeatures.toString()}

class AudioAnalyzerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fftSize = 1024;
    this.halfSize = 512;
    this.ringBuffer = new Float32Array(this.fftSize);
    this.ringIndex = 0;
    this.real = new Float32Array(this.fftSize);
    this.imag = new Float32Array(this.fftSize);
    this.hann = new Float32Array(this.fftSize);
    for (let i = 0; i < this.fftSize; i++) {
      this.hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (this.fftSize - 1)));
    }
    this.state = {};
  }

  process(inputs, outputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channelData = input[0];
    const len = channelData.length;

    for (let i = 0; i < len; i++) {
      this.ringBuffer[this.ringIndex] = channelData[i];
      this.ringIndex = (this.ringIndex + 1) % this.fftSize;
    }

    // Direct FFT on ringBuffer
    const freqData = new Uint8Array(this.halfSize);
    for (let k = 0; k < this.halfSize; k++) {
      let real = 0, imag = 0;
      const step = 2;
      const angle = (k * 2 * Math.PI) / this.fftSize;
      for (let n = 0; n < this.fftSize; n += step) {
        const val = this.ringBuffer[n] * this.hann[n];
        real += val * Math.cos(angle * n);
        imag -= val * Math.sin(angle * n);
      }
      const mag = Math.sqrt(real * real + imag * imag) * (2 / (this.fftSize / step));
      freqData[k] = Math.min(255, Math.floor(mag * 255 * 1.5));
    }

    const features = computeJsNationFeatures(freqData, 48000, 0, this.state);
    this.port?.postMessage({ type: 'features', data: features });
    return true;
  }
}
registerProcessor('analyzer-processor', AudioAnalyzerProcessor);
`;

class AudioAnalyzerNode {
  constructor(audioCtx) {
    this.audioCtx = audioCtx;
    this.analyser = null;
    this.freqData = null;
    this.listeners = new Set();
    this.animId = null;
    this.state = {};
    this.latestFeatures = {
      energy: 0,
      multiplier: 0,
      bass: 0,
      lowMid: 0,
      mid: 0,
      highMid: 0,
      high: 0,
      onset: 0,
      beat: false,
      bpm: 120
    };
  }

  async init() {
    if (this.audioCtx && typeof this.audioCtx.createAnalyser === 'function') {
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0.1;
      this.analyser.minDecibels = -40;
      this.analyser.maxDecibels = -30;
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
      this._startLoop();
    }
    return this;
  }

  _startLoop() {
    const update = () => {
      if (!this.analyser || !this.freqData) return;
      this.analyser.getByteFrequencyData(this.freqData);
      this.latestFeatures = computeJsNationFeatures(this.freqData, this.audioCtx?.sampleRate || 48000, this.audioCtx?.currentTime || 0, this.state);
      for (const cb of this.listeners) cb(this.latestFeatures);

      if (typeof requestAnimationFrame !== 'undefined') {
        this.animId = requestAnimationFrame(update);
      }
    };

    if (typeof requestAnimationFrame !== 'undefined') {
      this.animId = requestAnimationFrame(update);
    } else {
      this.intervalId = setInterval(update, 16);
    }
  }

  connectSource(sourceNode) {
    if (this.analyser && sourceNode) {
      sourceNode.connect(this.analyser);
    }
  }

  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  getFeatures() {
    return this.latestFeatures;
  }

  destroy() {
    this.listeners.clear();
    if (this.animId && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AudioAnalyzerNode, PROCESSOR_CODE, computeJsNationFeatures, calcJsNationMultiplier };
}


