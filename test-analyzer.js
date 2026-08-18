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
assert(typeof lastFeatures.beat === 'boolean', 'Beat must be boolean');
assert(typeof lastFeatures.bpm === 'number', 'BPM must be number');

console.log('Analyzer self-test passed! Output sample:', lastFeatures);
