const assert = require('assert');
const { computeJsNationFeatures, calcJsNationMultiplier } = require('../analyzer.js');

// 1. Test multiplier calculation
const silence = new Float32Array(40);
assert.strictEqual(calcJsNationMultiplier(silence), 0, 'Silence multiplier should be 0');

const activeSpectrum = new Float32Array(40).fill(150);
const mult = calcJsNationMultiplier(activeSpectrum);
assert(mult > 0 && mult <= 1.0, `Multiplier should be in range (0, 1], got ${mult}`);

// 2. Test feature computation from frequency data
const freqData = new Uint8Array(512);
for (let i = 8; i < 48; i++) freqData[i] = 128;

const features = computeJsNationFeatures(freqData);
assert(features !== null, 'Features should not be null');
assert('multiplier' in features, 'Missing multiplier');
assert('spectrum' in features, 'Missing spectrum');
assert.strictEqual(features.spectrum.length, 40, 'Spectrum must be 40 bins');
assert(features.multiplier > 0, 'Multiplier should reflect active spectrum');

console.log('JsNation Analyzer tests passed! Sample output:', features);
