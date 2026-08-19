const FFT_SIZE = 1024;
const KEEP_BINS = 40;
const START_BIN = 8;

function calcJsNationMultiplier(spectrum, loudness = 1.0) {
  let sum = 0;
  const count = spectrum.length || KEEP_BINS;
  for (let i = 0; i < count; i++) sum += (spectrum[i] || 0);
  const intermediate = sum / count / 256;
  const t = 1.2;
  const rawMult = (1 / (t - 1)) * (-Math.pow(intermediate, t) + t * intermediate);
  const mult = Math.pow(Math.max(0, rawMult), 0.8);
  return Math.round(mult * loudness * 100) / 100;
}

function computeJsNationFeatures(freqData) {
  const len = freqData.length;
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

  return {
    multiplier,
    spectrum
  };
}

class AudioAnalyzerNode {
  constructor(audioCtx) {
    this.audioCtx = audioCtx;
    this.analyser = null;
    this.freqData = null;
    this.listeners = new Set();
    this.animId = null;
    this.intervalId = null;
    this.latestFeatures = {
      multiplier: 0,
      spectrum: new Float32Array(KEEP_BINS)
    };
  }

  async init() {
    if (this.audioCtx && typeof this.audioCtx.createAnalyser === 'function') {
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0.1;
      this.analyser.minDecibels = -90;
      this.analyser.maxDecibels = -25;
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
      this._startLoop();
    }
    return this;
  }

  _startLoop() {
    const update = () => {
      if (!this.analyser || !this.freqData) return;
      this.analyser.getByteFrequencyData(this.freqData);
      this.latestFeatures = computeJsNationFeatures(this.freqData);
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
  module.exports = { AudioAnalyzerNode, computeJsNationFeatures, calcJsNationMultiplier };
}
