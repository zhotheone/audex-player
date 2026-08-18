// Evaluates renderer.js under a minimal browser mock to catch ReferenceErrors,
// undefined functions, and initialization crashes at test time.
// Run: node test-renderer.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

// Extract all element IDs from index.html to populate the mock DOM
const idMatches = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
const elements = {};

function createMockElement(id = '') {
  return {
    id,
    tagName: 'DIV',
    style: {
      _styles: {},
      setProperty(k, v) { this._styles[k] = v; },
      removeProperty(k) { delete this._styles[k]; },
      getPropertyValue(k) { return this._styles[k] || ''; },
    },
    classList: {
      _classes: new Set(),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      toggle(c) { this._classes.has(c) ? this._classes.delete(c) : this._classes.add(c); },
      contains(c) { return this._classes.has(c); },
    },
    children: [],
    dataset: {},
    value: '',
    textContent: '',
    innerHTML: '',
    closest() { return createMockElement(); },
    animate() { return { finished: Promise.resolve(), cancel() {} }; },
    hidden: false,
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    remove() {},
    getBoundingClientRect() { return { width: 100, height: 100, left: 0, top: 0, right: 100, bottom: 100 }; },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return createMockElement(); },
    querySelectorAll() { return []; },
    appendChild(child) { this.children.push(child); return child; },
    removeChild() {},
    focus() {},
    blur() {},
    play() { return Promise.resolve(); },
    pause() {},
    getContext() {
      return {
        createShader() { return {}; },
        shaderSource() {},
        compileShader() {},
        createProgram() { return {}; },
        attachShader() {},
        linkProgram() {},
        useProgram() {},
        createBuffer() { return {}; },
        bindBuffer() {},
        bufferData() {},
        getAttribLocation() { return 0; },
        enableVertexAttribArray() {},
        vertexAttribPointer() {},
        getUniformLocation() { return {}; },
        createTexture() { return {}; },
        bindTexture() {},
        texParameteri() {},
        texImage2D() {},
        viewport() {},
        uniform1f() {},
        uniform2f() {},
        uniform3f() {},
        drawArrays() {},
        TRIANGLES: 4,
        VERTEX_SHADER: 35633,
        FRAGMENT_SHADER: 35632,
        ARRAY_BUFFER: 34962,
        STATIC_DRAW: 35044,
        FLOAT: 5126,
        TEXTURE_2D: 3553,
        TEXTURE_WRAP_S: 10242,
        TEXTURE_WRAP_T: 10243,
        CLAMP_TO_EDGE: 33071,
        LINEAR: 9729,
        TEXTURE_MIN_FILTER: 10240,
        TEXTURE_MAG_FILTER: 10241,
        RGBA: 6408,
        UNSIGNED_BYTE: 5121,
      };
    },
  };
}

for (const id of idMatches) {
  elements[id] = createMockElement(id);
}

const mockDoc = {
  documentElement: createMockElement('html'),
  body: createMockElement('body'),
  getElementById(id) {
    if (!elements[id]) elements[id] = createMockElement(id);
    return elements[id];
  },
  querySelector(sel) { return createMockElement(); },
  querySelectorAll() { return []; },
  createElement(tag) {
    const el = createMockElement();
    el.tagName = tag.toUpperCase();
    return el;
  },
  addEventListener() {},
  removeEventListener() {},
  activeElement: null,
};

const mockWindow = {
  document: mockDoc,
  location: { reload() {} },
  addEventListener() {},
  removeEventListener() {},
  localStorage: {
    _data: {},
    getItem(k) { return this._data[k] || null; },
    setItem(k, v) { this._data[k] = String(v); },
    removeItem(k) { delete this._data[k]; },
  },
  navigator: { language: 'en-US', mediaSession: { setActionHandler() {} } },
  requestAnimationFrame(cb) { return setTimeout(cb, 0); },
  cancelAnimationFrame(id) { clearTimeout(id); },
  matchMedia() { return { matches: false, addEventListener() {} }; },
  devicePixelRatio: 1,
  api: {
    getPaths: () => Promise.resolve({}),
    loadSettings: () => Promise.resolve({}),
    loadPlayLog: () => Promise.resolve([]),
    loadRecents: () => Promise.resolve([]),
    getLibrary: () => Promise.resolve([]),
    getTrackCovers: () => Promise.resolve({}),
    getThemeSettings: () => Promise.resolve({}),
    getBuildInfo: () => Promise.resolve({}),
    on: () => {},
    send: () => {},
  },
};

const sandbox = {
  window: mockWindow,
  document: mockDoc,
  navigator: mockWindow.navigator,
  localStorage: mockWindow.localStorage,
  requestAnimationFrame: mockWindow.requestAnimationFrame,
  cancelAnimationFrame: mockWindow.cancelAnimationFrame,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  performance: { now: () => Date.now() },
  console,
  Image: class { constructor() { this.crossOrigin = ''; } },
  Audio: class { constructor() { this.volume = 1; this.src = ''; } },
  AudioContext: class {
    constructor() {
      this.currentTime = 0;
      this.state = 'running';
      this.destination = {};
    }
    createGain() { return { gain: { value: 1, setTargetAtTime() {}, cancelScheduledValues() {}, setValueCurveAtTime() {} }, connect() { return this; } }; }
    createMediaElementSource() { return { connect() { return this; } }; }
    createBiquadFilter() { return { frequency: { value: 0 }, Q: { value: 1 }, gain: { value: 0, setTargetAtTime() {} }, connect() { return this; } }; }
    resume() { return Promise.resolve(); }
  },
  Float32Array,
  Uint8Array,
  Math,
  JSON,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Date,
  RegExp,
  Set,
  Map,
  Promise,
  api: mockWindow.api,
};

vm.createContext(sandbox);

try {
  vm.runInContext(rendererSrc, sandbox);
} catch (e) {
  console.error('Failed to evaluate renderer.js:', e);
  process.exit(1);
}

// Check key critical functions exist and run without errors
assert.strictEqual(typeof sandbox.renderSettings, 'function', 'renderSettings must be defined');
assert.strictEqual(typeof sandbox.sliderToGain, 'function', 'sliderToGain must be defined');
assert.strictEqual(typeof sandbox.setVolume, 'function', 'setVolume must be defined');
assert.strictEqual(typeof sandbox.updateVolumeUI, 'function', 'updateVolumeUI must be defined');
assert.strictEqual(typeof sandbox.triggerCrossfade, 'function', 'triggerCrossfade must be defined');

// Run settings rendering cycle to ensure no missing variables (e.g. crossfadeMs)
try {
  sandbox.renderSettings();
  sandbox.setVolume(0.5);
  sandbox.updateVolumeUI();
} catch (e) {
  console.error('Runtime error in renderer.js functions:', e);
  process.exit(1);
}

console.log('renderer.js evaluation test passed cleanly (0 errors)');
