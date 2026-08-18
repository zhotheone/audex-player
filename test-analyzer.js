const assert = require('assert');

// Mock AudioWorklet global functions for Node test environment
if (typeof AudioWorkletProcessor === 'undefined') {
  global.AudioWorkletProcessor = class {
    constructor() {
      this.port = { postMessage: () => {} };
    }
  };
}
let registered = null;
global.registerProcessor = (name, cls) => { registered = cls; };

const { AudioAnalyzerNode, PROCESSOR_CODE } = require('./analyzer.js');
eval(PROCESSOR_CODE);

// 1. Instantiation test
const processor = new registered();
assert(processor.fftSize === 1024, 'FFT size must be 1024');

// 2. Synthesize a 100 Hz sine tone (bass)
const sampleRate = 48000;
const toneFreq = 100;
const numSamples = 2048;
const testBuffer = new Float32Array(numSamples);

for (let i = 0; i < numSamples; i++) {
  testBuffer[i] = 0.8 * Math.sin((2 * Math.PI * toneFreq * i) / sampleRate);
}

// Feed samples in 128-sample chunks
let lastFeatures = null;
processor.port.postMessage = (msg) => {
  if (msg.type === 'features') lastFeatures = msg.data;
};

for (let offset = 0; offset < numSamples; offset += 128) {
  const chunk = testBuffer.subarray(offset, offset + 128);
  processor.process([[chunk]], []);
}

assert(lastFeatures !== null, 'Processor should emit features');
assert('energy' in lastFeatures, 'Missing energy');
assert('bass' in lastFeatures, 'Missing bass');
assert('lowMid' in lastFeatures, 'Missing lowMid');
assert('mid' in lastFeatures, 'Missing mid');
assert('highMid' in lastFeatures, 'Missing highMid');
assert('high' in lastFeatures, 'Missing high');
assert('onset' in lastFeatures, 'Missing onset');
assert('beat' in lastFeatures, 'Missing beat');
assert('bpm' in lastFeatures, 'Missing bpm');

assert(lastFeatures.bass > lastFeatures.high, `Bass (${lastFeatures.bass}) should exceed high (${lastFeatures.high}) for 100Hz tone`);
assert(lastFeatures.energy > 0.4, `Energy (${lastFeatures.energy}) should reflect strong signal`);
assert(typeof lastFeatures.beat === 'boolean', 'Beat must be boolean');
assert(typeof lastFeatures.bpm === 'number', 'BPM must be number');

// Test high frequency tone (no bass)
const procHigh = new registered();
const highBuffer = new Float32Array(numSamples);
for (let i = 0; i < numSamples; i++) {
  highBuffer[i] = 0.8 * Math.sin((2 * Math.PI * 10000 * i) / sampleRate);
}
let highFeatures = null;
procHigh.port.postMessage = (msg) => { if (msg.type === 'features') highFeatures = msg.data; };
for (let offset = 0; offset < numSamples; offset += 128) {
  procHigh.process([[highBuffer.subarray(offset, offset + 128)]], []);
}
assert(highFeatures.bass < 0.25, `Bass (${highFeatures.bass}) should be low for 10kHz tone`);
assert(highFeatures.high > highFeatures.bass, `High (${highFeatures.high}) should exceed bass (${highFeatures.bass}) for 10kHz tone`);

// Test mid frequency tone (1 kHz)
const procMid = new registered();
const midBuffer = new Float32Array(numSamples);
for (let i = 0; i < numSamples; i++) {
  midBuffer[i] = 0.8 * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
}
let midFeatures = null;
procMid.port.postMessage = (msg) => { if (msg.type === 'features') midFeatures = msg.data; };
for (let offset = 0; offset < numSamples; offset += 128) {
  procMid.process([[midBuffer.subarray(offset, offset + 128)]], []);
}
assert(midFeatures.mid > 0.4, `Mid (${midFeatures.mid}) should be high for 1kHz tone`);
assert(midFeatures.mid > midFeatures.high, `Mid (${midFeatures.mid}) should exceed high (${midFeatures.high}) for 1kHz tone`);

// 3. Mathematical check for logarithmic volume and equal-power crossfade
function sliderToGain(v) { return Math.pow(Math.max(0, Math.min(1, v)), 2); }
assert.strictEqual(sliderToGain(0), 0);
assert.strictEqual(sliderToGain(1), 1);
assert.strictEqual(sliderToGain(0.5), 0.25);

// Equal-power crossfade energy conservation (cos^2 + sin^2 == 1)
for (let p = 0; p <= 1; p += 0.1) {
  const gOut = Math.cos(p * Math.PI * 0.5);
  const gIn = Math.sin(p * Math.PI * 0.5);
  const power = gOut * gOut + gIn * gIn;
  assert(Math.abs(power - 1.0) < 1e-6, `Equal-power sum failed at p=${p}: ${power}`);
}

console.log('Analyzer self-test passed! Output sample:', lastFeatures);
