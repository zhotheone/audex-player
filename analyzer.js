/**
 * AudioAnalyzer - Self-contained AudioWorklet Analyzer for Electron / Browser.
 * Bundles processor and main-thread node in one file (uses Blob URL for worklet).
 */

const PROCESSOR_CODE = `
class AudioAnalyzerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sampleRate = 48000;
    this.fftSize = 1024;
    this.halfSize = 512;
    this.hopSize = 256;

    this.ringBuffer = new Float32Array(this.fftSize);
    this.ringIndex = 0;
    this.samplesSinceHop = 0;

    this.hannWindow = new Float32Array(this.fftSize);
    for (let i = 0; i < this.fftSize; i++) {
      this.hannWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (this.fftSize - 1)));
    }

    this.real = new Float32Array(this.fftSize);
    this.imag = new Float32Array(this.fftSize);
    this.prevMag = new Float32Array(this.halfSize);
    this.mag = new Float32Array(this.halfSize);

    this.bitRev = new Uint16Array(this.fftSize);
    for (let i = 0; i < this.fftSize; i++) {
      let rev = 0;
      for (let j = 0; j < 10; j++) rev = (rev << 1) | ((i >> j) & 1);
      this.bitRev[i] = rev;
    }

    this.bands = {
      bass: { start: 1, end: 5, val: 0 },
      lowMid: { start: 6, end: 10, val: 0 },
      mid: { start: 11, end: 42, val: 0 },
      highMid: { start: 43, end: 128, val: 0 },
      high: { start: 129, end: 426, val: 0 }
    };

    this.fluxHistory = new Float32Array(43);
    this.fluxIdx = 0;
    this.lastBeatTime = 0;
    this.currentTime = 0;
    this.beatIntervals = [];
    this.currentBpm = 120;
    this.smoothedEnergy = 0;
    this.smoothedOnset = 0;

    this.dispatchCounter = 0;
    this.dispatchEvery = 3;
  }

  fft() {
    const n = this.fftSize;
    const real = this.real;
    const imag = this.imag;

    for (let i = 0; i < n; i++) {
      const j = this.bitRev[i];
      if (j > i) {
        let t = real[i]; real[i] = real[j]; real[j] = t;
        t = imag[i]; imag[i] = imag[j]; imag[j] = t;
      }
    }

    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = (2 * Math.PI) / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0; j < half; j++) {
          const angle = -j * step;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const k = i + j;
          const match = k + half;
          const tr = real[match] * cos - imag[match] * sin;
          const ti = real[match] * sin + imag[match] * cos;

          real[match] = real[k] - tr;
          imag[match] = imag[k] - ti;
          real[k] += tr;
          imag[k] += ti;
        }
      }
    }
  }

  computeFeatures() {
    let sumSq = 0;
    for (let i = 0; i < this.fftSize; i++) {
      const sample = this.ringBuffer[(this.ringIndex + i) % this.fftSize];
      this.real[i] = sample * this.hannWindow[i];
      this.imag[i] = 0;
      sumSq += sample * sample;
    }

    const rms = Math.sqrt(sumSq / this.fftSize);
    const rmsDb = 20 * Math.log10(rms + 1e-5);
    const targetEnergy = Math.max(0, Math.min(1.0, (rmsDb + 50) / 45));
    this.smoothedEnergy += (targetEnergy - this.smoothedEnergy) * (targetEnergy > this.smoothedEnergy ? 0.3 : 0.1);

    this.fft();
    const normFactor = 2.0 / this.fftSize;
    for (let i = 0; i < this.halfSize; i++) {
      this.mag[i] = Math.sqrt(this.real[i] * this.real[i] + this.imag[i] * this.imag[i]) * normFactor;
    }

    const bandResults = {};
    for (const [key, b] of Object.entries(this.bands)) {
      let sumSq = 0;
      for (let k = b.start; k <= b.end; k++) sumSq += this.mag[k] * this.mag[k];
      const energy = Math.sqrt(sumSq);

      const db = 20 * Math.log10(energy + 1e-5);
      const norm = Math.max(0, Math.min(1.0, (db + 45) / 45));
      const alpha = norm > b.val ? 0.25 : 0.75;
      b.val = b.val * alpha + norm * (1 - alpha);
      bandResults[key] = Math.round(b.val * 100) / 100;
    }

    let flux = 0;
    for (let i = 1; i < this.halfSize; i++) {
      const diff = this.mag[i] - this.prevMag[i];
      if (diff > 0) flux += diff * (i < 15 ? 1.5 : 1.0);
      this.prevMag[i] = this.mag[i];
    }

    const normFlux = Math.min(1.0, flux * 12.0);
    this.smoothedOnset += (normFlux - this.smoothedOnset) * 0.3;

    this.fluxHistory[this.fluxIdx] = normFlux;
    this.fluxIdx = (this.fluxIdx + 1) % this.fluxHistory.length;

    let fluxSum = 0;
    for (let i = 0; i < this.fluxHistory.length; i++) fluxSum += this.fluxHistory[i];
    const fluxMean = fluxSum / this.fluxHistory.length;

    let varSum = 0;
    for (let i = 0; i < this.fluxHistory.length; i++) {
      const d = this.fluxHistory[i] - fluxMean;
      varSum += d * d;
    }
    const fluxStd = Math.sqrt(varSum / this.fluxHistory.length);
    const threshold = fluxMean + 1.35 * fluxStd;

    const time = this.currentTime;
    let isBeat = false;
    if (normFlux > threshold && (time - this.lastBeatTime) > 0.20 && normFlux > 0.15) {
      isBeat = true;
      const interval = time - this.lastBeatTime;
      if (interval >= 0.25 && interval <= 1.5) {
        this.beatIntervals.push(interval);
        if (this.beatIntervals.length > 12) this.beatIntervals.shift();
        this.estimateBpm();
      }
      this.lastBeatTime = time;
    }

    return {
      energy: Math.round(this.smoothedEnergy * 100) / 100,
      bass: bandResults.bass,
      lowMid: bandResults.lowMid,
      mid: bandResults.mid,
      highMid: bandResults.highMid,
      high: bandResults.high,
      onset: Math.round(this.smoothedOnset * 100) / 100,
      beat: isBeat,
      bpm: this.currentBpm
    };
  }

  estimateBpm() {
    if (this.beatIntervals.length < 4) return;
    let bestScore = -1;
    let bestBpm = this.currentBpm;

    for (let candidate = 65; candidate <= 190; candidate++) {
      const candidatePeriod = 60 / candidate;
      let score = 0;

      for (const interval of this.beatIntervals) {
        let minDiff = Math.abs(interval - candidatePeriod);
        minDiff = Math.min(minDiff, Math.abs(interval - 2 * candidatePeriod));
        minDiff = Math.min(minDiff, Math.abs(interval - 0.5 * candidatePeriod));
        score += Math.exp(-(minDiff * minDiff) / 0.005);
      }

      const prior = Math.exp(-Math.pow(candidate - 120, 2) / 4050);
      score *= (1 + 0.15 * prior);

      if (score > bestScore) {
        bestScore = score;
        bestBpm = candidate;
      }
    }
    this.currentBpm = bestBpm;
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

    this.currentTime += len / 48000;
    this.samplesSinceHop += len;

    if (this.samplesSinceHop >= this.hopSize) {
      this.samplesSinceHop = 0;
      const features = this.computeFeatures();

      this.dispatchCounter++;
      if (this.dispatchCounter >= this.dispatchEvery || features.beat) {
        this.dispatchCounter = 0;
        this.port?.postMessage({ type: 'features', data: features });
      }
    }

    return true;
  }
}

registerProcessor('analyzer-processor', AudioAnalyzerProcessor);
`;

class AudioAnalyzerNode {
  constructor(audioCtx) {
    this.audioCtx = audioCtx;
    this.workletNode = null;
    this.listeners = new Set();
    this.blobUrl = null;
    this.latestFeatures = {
      energy: 0,
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

  async init(customUrl = null) {
    let url = customUrl;
    if (!url) {
      const blob = new Blob([PROCESSOR_CODE], { type: 'application/javascript' });
      this.blobUrl = URL.createObjectURL(blob);
      url = this.blobUrl;
    }

    await this.audioCtx.audioWorklet.addModule(url);
    this.workletNode = new AudioWorkletNode(this.audioCtx, 'analyzer-processor');

    this.workletNode.port.onmessage = (event) => {
      if (event.data?.type === 'features') {
        this.latestFeatures = event.data.data;
        for (const cb of this.listeners) cb(this.latestFeatures);
      }
    };

    return this.workletNode;
  }

  connectSource(sourceNode) {
    if (this.workletNode) sourceNode.connect(this.workletNode);
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
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AudioAnalyzerNode, PROCESSOR_CODE };
}
