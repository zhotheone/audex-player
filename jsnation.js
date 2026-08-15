/**
 * JsNation Visualizer - Minimal Embeddable WebGL Visualizer Engine
 * Single-file standalone module. Requires Three.js (r85+).
 */
(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define(['three'], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('three'));
    } else {
        root.JsNationVisualizer = factory(root.THREE);
    }
}(typeof self !== 'undefined' ? self : this, function (THREE) {
    'use strict';

    if (!THREE) {
        throw new Error('JsNationVisualizer requires Three.js');
    }

    const SPECTRUM_COUNT = 8;
    const KEEP_BINS = 40;
    const START_BIN = 8;
    const FFT_SIZE = 16384;
    const EXPONENTS = [1, 1.12, 1.14, 1.30, 1.33, 1.36, 1.50, 1.52];
    const SMOOTH_MARGINS = [0, 2, 2, 3, 3, 3, 5, 5];
    const DELAYS = [0, 1, 2, 3, 4, 5, 6, 7];
    const MAX_DELAY = 7;
    const COLORS = [
        new THREE.Color(0xFFFFFF), new THREE.Color(0xFFFF00),
        new THREE.Color(0xFF0000), new THREE.Color(0xFF66FF),
        new THREE.Color(0x333399), new THREE.Color(0x0000FF),
        new THREE.Color(0x33CCFF), new THREE.Color(0x00FF00)
    ];

    const PARTICLE_COUNT = 2400;
    const VERTEX_SIZE = 3;
    const CAMERA_Z = 200;

    const SHADERS = {
        vertParticle: `
            attribute float size;
            attribute float alpha;
            uniform vec3 color;
            varying float vAlpha;
            varying vec3 vColor;
            void main() {
                vColor = color;
                vAlpha = alpha;
                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = 100.0 * size / length(mvPosition.xyz);
                gl_Position = projectionMatrix * mvPosition;
            }
        `,
        fragParticle: `
            uniform sampler2D texture;
            varying float vAlpha;
            varying vec3 vColor;
            void main() {
                gl_FragColor = vec4(vColor, vAlpha) * texture2D(texture, gl_PointCoord);
            }
        `,
        vertSpectrum: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = vec4(position.xy, 0.0, 1.0);
            }
        `,
        fragSpectrum: `
            precision mediump float;
            uniform vec2 uResolution;
            uniform vec2 uCenter;
            uniform float uCurRadius;
            uniform sampler2D uAudioTex;
            uniform vec3 uColors[8];
            uniform float uExponents[8];
            uniform float uSpectrumHeightScalar;
            uniform float uResMult;
            uniform float uGlowRadius;
            uniform float uGlowEnabled;

            float getSample(float idx, float v) {
                return texture2D(uAudioTex, vec2((clamp(idx, 0.0, 39.0) + 0.5) / 40.0, v)).r;
            }

            float sampleSpectrum(float u, float layer) {
                float v = (layer + 0.5) / 8.0;
                float x = u * 39.0;
                float i = floor(x);
                float t = fract(x);
                float p0 = getSample(i - 1.0, v);
                float p1 = getSample(i, v);
                float p2 = getSample(i + 1.0, v);
                float w0 = 0.5 * (1.0 - t) * (1.0 - t);
                float w1 = 0.5 + t * (1.0 - t);
                float w2 = 0.5 * t * t;
                return w0 * p0 + w1 * p1 + w2 * p2;
            }

            void main() {
                vec2 diff = vec2(gl_FragCoord.x - uCenter.x, (uResolution.y - uCenter.y) - gl_FragCoord.y);
                float dist = length(diff);
                float theta = atan(diff.y, abs(diff.x));
                float u = clamp((theta + 1.57079632679) / 3.14159265359, 0.0, 1.0);

                vec4 finalColor = vec4(0.0);
                vec3 totalGlow = vec3(0.0);

                for (int s = 7; s >= 0; s--) {
                    float amp = sampleSpectrum(u, float(s));
                    float r_s = uCurRadius + pow(amp * uSpectrumHeightScalar * uResMult, uExponents[s]);
                    float d_s = dist - r_s;
                    float fillAlpha = smoothstep(0.75, -0.75, d_s);
                    finalColor = mix(finalColor, vec4(uColors[s], 1.0), fillAlpha);
                    if (uGlowEnabled > 0.5) {
                        float glowDist = max(0.0, d_s);
                        float glow = exp(-glowDist / max(1.0, uGlowRadius * 0.45));
                        totalGlow += uColors[s] * glow * 0.5;
                    }
                }

                vec3 rgb = finalColor.rgb + totalGlow * (1.0 - finalColor.a * 0.4);
                float alpha = max(finalColor.a, clamp(length(totalGlow) * 0.8, 0.0, 1.0));
                gl_FragColor = vec4(rgb, alpha);
            }
        `
    };

    class JsNationVisualizer {
        constructor(options = {}) {
            this.container = typeof options.container === 'string'
                ? document.querySelector(options.container)
                : (options.container || document.body);

            this.options = Object.assign({
                glow: true,
                particles: true,
                spectrum: true,
                background: '#111111',
                emblem: null,
                minEmblemSize: 480,
                maxEmblemSize: 600,
                spectrumHeightScalar: 0.4,
                glowRadius: 25,
                loudness: 1.0,
                fovPunch: true,
                particleCount: 2400
            }, options);

            this.running = false;
            this.spectrumCache = [];
            this.currentDx = 0;
            this.currentDy = 0;
            this.waveFrameX = 0;
            this.waveFrameY = 0;
            this.waveSpeedX = 1;
            this.waveSpeedY = 1;
            this.waveAmpX = 1;
            this.waveAmpY = 1;
            this.trigX = 0;
            this.trigY = 0;

            this._initDOM();
            this._initAudio();
            this._initWebGL();
            this._initEmblem();
            this.setBackground(this.options.background);
            if (this.options.emblem) {
                this.setEmblem(this.options.emblem);
            }
            if (this.options.audio) {
                this.connect(this.options.audio);
            }

            this.resize();

            this._onResize = () => this.resize();
            window.addEventListener('resize', this._onResize);

            this.start();
        }

        _initDOM() {
            this.wrapper = document.createElement('div');
            this.wrapper.style.position = 'relative';
            this.wrapper.style.width = '100%';
            this.wrapper.style.height = '100%';
            this.wrapper.style.overflow = 'hidden';
            this.wrapper.style.background = this.options.background;

            this.canvasGl = document.createElement('canvas');
            this.canvasGl.style.position = 'absolute';
            this.canvasGl.style.left = '0';
            this.canvasGl.style.top = '0';
            this.canvasGl.style.width = '100%';
            this.canvasGl.style.height = '100%';
            this.canvasGl.style.zIndex = '1';

            this.canvas2d = document.createElement('canvas');
            this.canvas2d.style.position = 'absolute';
            this.canvas2d.style.left = '0';
            this.canvas2d.style.top = '0';
            this.canvas2d.style.width = '100%';
            this.canvas2d.style.height = '100%';
            this.canvas2d.style.zIndex = '2';
            this.canvas2d.style.pointerEvents = 'none';

            this.ctx2d = this.canvas2d.getContext('2d');

            this.wrapper.appendChild(this.canvasGl);
            this.wrapper.appendChild(this.canvas2d);
            this.container.appendChild(this.wrapper);
        }

        _initAudio() {
            this.audioCtx = null;
            this.analyser = null;
            this.sourceNode = null;
        }

        connect(source) {
            if (!this.audioCtx) {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                this.audioCtx = new AudioContextClass();
                this.analyser = this.audioCtx.createAnalyser();
                this.analyser.fftSize = FFT_SIZE;
                this.analyser.smoothingTimeConstant = 0.1;
                this.analyser.minDecibels = -40;
                this.analyser.maxDecibels = -30;
                this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
            }

            if (this.audioCtx.state === 'suspended') {
                const resume = () => {
                    this.audioCtx.resume();
                    window.removeEventListener('click', resume);
                    window.removeEventListener('keydown', resume);
                };
                window.addEventListener('click', resume);
                window.addEventListener('keydown', resume);
            }

            if (source instanceof HTMLMediaElement) {
                if (!this.sourceNode) {
                    this.sourceNode = this.audioCtx.createMediaElementSource(source);
                    this.sourceNode.connect(this.analyser);
                    this.analyser.connect(this.audioCtx.destination);
                }
            } else if (source instanceof AudioNode) {
                source.connect(this.analyser);
            }
        }

        _initWebGL() {
            const width = this.wrapper.clientWidth || window.innerWidth;
            const height = this.wrapper.clientHeight || window.innerHeight;

            this.canvas2d.width = width;
            this.canvas2d.height = height;

            this.renderer = new THREE.WebGLRenderer({ canvas: this.canvasGl, alpha: true, antialias: true });
            this.renderer.setSize(width, height, false);

            this.scene = new THREE.Scene();
            this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
            this.camera.position.z = CAMERA_Z;

            // Spectrum Mesh
            this.texData = new Float32Array(KEEP_BINS * SPECTRUM_COUNT);
            this.audioTex = new THREE.DataTexture(this.texData, KEEP_BINS, SPECTRUM_COUNT, THREE.LuminanceFormat, THREE.FloatType);
            this.audioTex.minFilter = THREE.LinearFilter;
            this.audioTex.magFilter = THREE.LinearFilter;

            this.spectrumUniforms = {
                uResolution: { type: 'v2', value: new THREE.Vector2(width, height) },
                uCenter: { type: 'v2', value: new THREE.Vector2(width / 2, height / 2) },
                uCurRadius: { type: 'f', value: 0.0 },
                uAudioTex: { type: 't', value: this.audioTex },
                uColors: { type: 'v3v', value: COLORS },
                uExponents: { type: 'fv1', value: EXPONENTS },
                uSpectrumHeightScalar: { type: 'f', value: this.options.spectrumHeightScalar },
                uResMult: { type: 'f', value: this._getResMult() },
                uGlowRadius: { type: 'f', value: this.options.glowRadius * this._getResMult() },
                uGlowEnabled: { type: 'f', value: this.options.glow ? 1.0 : 0.0 }
            };

            this.spectrumMaterial = new THREE.ShaderMaterial({
                uniforms: this.spectrumUniforms,
                vertexShader: SHADERS.vertSpectrum,
                fragmentShader: SHADERS.fragSpectrum,
                transparent: true,
                depthTest: false,
                depthWrite: false
            });

            this.spectrumMesh = new THREE.Mesh(new THREE.PlaneBufferGeometry(2, 2), this.spectrumMaterial);
            this.spectrumMesh.frustumCulled = false;
            this.scene.add(this.spectrumMesh);

            // Particles System
            this._initParticles();
        }

        _initParticles() {
            this.maxParticles = this.options.maxParticles || 10000;
            this.particleCount = Math.min(this.options.particleCount || 2400, this.maxParticles);
            
            if (this.particleSystem && this.scene) {
                this.scene.remove(this.particleSystem);
            }
            
            this.particlesGeom = new THREE.BufferGeometry();
            const max = this.maxParticles;
            const posArr = new Float32Array(max * VERTEX_SIZE);
            const sizeArr = new Float32Array(max);
            const alphaArr = new Float32Array(max);
            this.particleData = [];
            this.baseSizes = [];

            for (let i = 0; i < max / 2; i++) {
                this.baseSizes[i] = 8 + Math.random() * 5;
                let alpha = 0.9 + Math.random() * 0.1;
                alphaArr[i] = alpha;
                alphaArr[i + max / 2] = alpha;
                this._resetParticleVelocity(i);
            }

            this.particlesGeom.addAttribute('position', new THREE.BufferAttribute(posArr, 3));
            this.particlesGeom.addAttribute('size', new THREE.BufferAttribute(sizeArr, 1));
            this.particlesGeom.addAttribute('alpha', new THREE.BufferAttribute(alphaArr, 1));
            this.particlesGeom.setDrawRange(0, this.particleCount);

            let texLoader = new THREE.TextureLoader();
            texLoader.crossOrigin = "";
            let texLoc = this.options.particleTexture || (location.protocol === 'file:' && /Chrome/.test(navigator.userAgent) ? 'https://i.imgur.com/Qz4ftah.png' : './img/particle.png');
            this.particleTexture = texLoader.load(texLoc);
            this.particleTexture.minFilter = THREE.LinearFilter;

            this.particleMaterial = new THREE.ShaderMaterial({
                uniforms: {
                    color: { type: 'c', value: new THREE.Color(0xFFFFFF) },
                    texture: { type: 't', value: this.particleTexture }
                },
                vertexShader: SHADERS.vertParticle,
                fragmentShader: SHADERS.fragParticle,
                blending: THREE.NormalBlending,
                transparent: true,
                depthWrite: false
            });

            this.particleSystem = new THREE.Points(this.particlesGeom, this.particleMaterial);
            this.scene.add(this.particleSystem);

            this._updateParticleSizes();

            for (let i = 0; i < max / 2; i++) {
                this._updateParticle(i, Math.random() * CAMERA_Z, true);
            }
        }

        setParticleCount(count) {
            this.particleCount = Math.min(Math.max(2, Math.floor(count)), this.maxParticles);
            this.options.particleCount = this.particleCount;
            if (this.particlesGeom) {
                this.particlesGeom.setDrawRange(0, this.particleCount);
            }
        }

        _resetParticleVelocity(i) {
            let r = 10 + Math.random() * 110;
            let theta = Math.PI * Math.random() - Math.PI / 2;
            this.particleData[i] = {
                traj: { x: (r * Math.cos(theta)) / CAMERA_Z, y: (r * Math.sin(theta)) / CAMERA_Z },
                speed: 1.1 + Math.random() * 0.35,
                phase: { x: Math.random(), y: Math.random() },
                phaseAmp: { x: 0.05 + Math.random() * 0.35, y: 0.05 + Math.random() * 0.35 },
                phaseSpeed: { x: 0.1 + Math.random() * 0.15, y: 0.1 + Math.random() * 0.15 }
            };
        }

        _updateParticle(i, multiplier, ignoreSpeed) {
            let data = this.particleData[i];
            if (!data) return;

            let speed = ignoreSpeed ? 1 : data.speed;
            let adjustedSpeed = Math.max(speed * multiplier, 0.035);
            let ampMult = (1.0 - 0.1) * multiplier + 0.1;
            let phaseX = Math.sin(Math.PI * 2 * data.phase.x) * data.phaseAmp.x * ampMult;
            let phaseY = Math.sin(Math.PI * 2 * data.phase.y) * data.phaseAmp.y * ampMult;

            let idx = VERTEX_SIZE * i;
            let pos = this.particlesGeom.attributes.position.array;
            let x = pos[idx + 0] + data.traj.x * adjustedSpeed + phaseX;
            let y = pos[idx + 1] + data.traj.y * adjustedSpeed + phaseY;
            let z = pos[idx + 2] + adjustedSpeed;

            let half = this.particleCount / 2;
            if (z > CAMERA_Z) {
                pos[idx + 0] = 0; pos[idx + 1] = 0; pos[idx + 2] = 0;
                let mIdx = idx + half * VERTEX_SIZE;
                pos[mIdx + 0] = 0; pos[mIdx + 1] = 0; pos[mIdx + 2] = 0;
                this._resetParticleVelocity(i);
            } else {
                pos[idx + 0] = x; pos[idx + 1] = y; pos[idx + 2] = z;
                let mIdx = idx + half * VERTEX_SIZE;
                pos[mIdx + 0] = -x; pos[mIdx + 1] = y; pos[mIdx + 2] = z;
            }

            let speedMult = (0.4 - 0.025) * multiplier + 0.025;
            data.phase.x += data.phaseSpeed.x * speedMult;
            data.phase.y += data.phaseSpeed.y * speedMult;
        }

        _updateParticleSizes() {
            let res = this._getResMult();
            let arr = this.particlesGeom.attributes.size.array;
            let half = this.particleCount / 2;
            for (let i = 0; i < half; i++) {
                arr[i] = this.baseSizes[i] * res;
                arr[i + half] = arr[i];
            }
            this.particlesGeom.attributes.size.needsUpdate = true;
        }

        _initEmblem() {
            this.emblemImg = null;
            this.emblemLoaded = false;
        }

        setBackground(bg) {
            this.options.background = bg;
            if (!this.wrapper) return;
            if (!bg) {
                this.wrapper.style.background = 'transparent';
            } else if (bg.startsWith('#') || bg.startsWith('rgb') || bg.startsWith('hsl')) {
                this.wrapper.style.background = bg;
            } else {
                this.wrapper.style.background = `url("${bg}") center/cover no-repeat`;
            }
        }

        setEmblem(emblem) {
            this.options.emblem = emblem;
            if (!emblem) {
                this.emblemImg = null;
                this.emblemLoaded = false;
                return;
            }
            this.emblemImg = new Image();
            this.emblemImg.crossOrigin = 'anonymous';
            this.emblemImg.onload = () => { this.emblemLoaded = true; };
            this.emblemImg.src = emblem;
        }

        setGlow(enabled) {
            this.options.glow = !!enabled;
            if (this.spectrumUniforms) {
                this.spectrumUniforms.uGlowEnabled.value = this.options.glow ? 1.0 : 0.0;
            }
        }

        setParticles(enabled) {
            this.options.particles = !!enabled;
            if (this.particleSystem) this.particleSystem.visible = this.options.particles;
        }

        setSpectrum(enabled) {
            this.options.spectrum = !!enabled;
            if (this.spectrumMesh) this.spectrumMesh.visible = this.options.spectrum;
        }

        _getResMult() {
            const w = this.wrapper ? (this.wrapper.clientWidth || window.innerWidth) : window.innerWidth;
            const h = this.wrapper ? (this.wrapper.clientHeight || window.innerHeight) : window.innerHeight;
            return w >= h ? w / 1920 : h / 1080;
        }

        _smooth(points, margin) {
            if (margin === 0) return points;
            let res = [];
            for (let i = 0; i < points.length; i++) {
                let sum = 0, denom = 0;
                for (let j = 0; j <= margin; j++) {
                    if (i - j < 0 || i + j > points.length - 1) break;
                    sum += points[i - j] + points[i + j];
                    denom += (margin - j + 1) * 2;
                }
                res[i] = sum / denom;
            }
            return res;
        }

        setLoudness(val) {
            this.options.loudness = Math.max(0, val);
            if (this.spectrumUniforms) {
                this.spectrumUniforms.uSpectrumHeightScalar.value = this.options.spectrumHeightScalar * this.options.loudness;
            }
        }

        _calcMultiplier(spectrum) {
            let sum = 0;
            for (let i = 0; i < spectrum.length; i++) sum += spectrum[i];
            let intermediate = sum / KEEP_BINS / 256;
            let t = 1.2;
            let raw = (1 / (t - 1)) * (-Math.pow(intermediate, t) + t * intermediate) * this.options.loudness;
            return Math.pow(Math.max(0, raw), 0.8);
        }

        _updateShake(multiplier) {
            const WAVE_DUR = Math.PI / 8;
            let step = (Math.PI / 3) * multiplier;
            this.waveFrameX += step * this.waveSpeedX;
            if (this.waveFrameX > WAVE_DUR) {
                this.waveFrameX = 0;
                this.waveAmpX = 0.9 + Math.random() * 0.7;
                this.waveSpeedX = (0.9 + Math.random() * 0.7) * (Math.random() < 0.5 ? -1 : 1);
                this.trigX = Math.round(Math.random());
            }
            this.waveFrameY += step * this.waveSpeedY;
            if (this.waveFrameY > WAVE_DUR) {
                this.waveFrameY = 0;
                this.waveAmpY = 0.9 + Math.random() * 0.7;
                this.waveSpeedY = (0.9 + Math.random() * 0.7) * (Math.random() < 0.5 ? -1 : 1);
                this.trigY = Math.round(Math.random());
            }
            let fx = this.trigX === 0 ? Math.cos : Math.sin;
            let fy = this.trigY === 0 ? Math.cos : Math.sin;
            this.currentDx = fx(this.waveFrameX) * 8 * this.waveAmpX * multiplier;
            this.currentDy = fy(this.waveFrameY) * 8 * this.waveAmpY * multiplier;
        }

        render() {
            if (!this.running) return;
            requestAnimationFrame(() => this.render());

            let multiplier = 0;
            let spectrum = new Array(KEEP_BINS).fill(0);

            if (this.analyser && this.freqData) {
                this.analyser.getByteFrequencyData(this.freqData);
                let raw = Array.from(this.freqData.subarray(START_BIN, START_BIN + KEEP_BINS));
                // Savitzky-Golay 3-point smoothing
                spectrum = raw.slice();
                for (let i = 1; i < raw.length - 1; i++) {
                    spectrum[i] = (raw[i - 1] + raw[i] + raw[i + 1]) / 3;
                }
                multiplier = this._calcMultiplier(spectrum);
            }

            this._updateShake(multiplier);

            // Audio Spectrum update
            if (this.options.spectrum) {
                if (this.spectrumCache.length >= MAX_DELAY + 1) {
                    this.spectrumCache.shift();
                }
                this.spectrumCache.push(spectrum);

                for (let s = 0; s < SPECTRUM_COUNT; s++) {
                    let past = this.spectrumCache[Math.max(this.spectrumCache.length - DELAYS[s] - 1, 0)] || spectrum;
                    let smoothed = this._smooth(past, SMOOTH_MARGINS[s]);
                    for (let i = 0; i < KEEP_BINS; i++) {
                        this.texData[s * KEEP_BINS + i] = smoothed[i] || 0;
                    }
                }
                this.audioTex.needsUpdate = true;

                let curRad = this._getResMult() * (multiplier * (this.options.maxEmblemSize - this.options.minEmblemSize) + this.options.minEmblemSize) / 2;
                let w = this.wrapper.clientWidth;
                let h = this.wrapper.clientHeight;

                this.spectrumUniforms.uCurRadius.value = curRad;
                this.spectrumUniforms.uCenter.value.set(w / 2 + this.currentDx, h / 2 + this.currentDy);
                this.spectrumUniforms.uResMult.value = this._getResMult();
                this.spectrumUniforms.uGlowRadius.value = this.options.glowRadius * this._getResMult();
            }

            // Particles update
            if (this.options.particles) {
                for (let i = 0; i < PARTICLE_COUNT / 2; i++) {
                    this._updateParticle(i, multiplier);
                }
                this.particlesGeom.attributes.position.needsUpdate = true;
            }

            if (this.options.fovPunch && this.camera) {
                this.camera.fov = 45 - (multiplier * 3.5);
                this.camera.updateProjectionMatrix();
            }

            // Render WebGL
            this.renderer.render(this.scene, this.camera);

            // Render Emblem on 2D Overlay
            this._drawEmblem(multiplier);
        }

        _drawEmblem(multiplier) {
            let w = this.canvas2d.width;
            let h = this.canvas2d.height;
            this.ctx2d.clearRect(0, 0, w, h);

            let rad = this._getResMult() * (multiplier * (this.options.maxEmblemSize - this.options.minEmblemSize) + this.options.minEmblemSize) / 2;
            let cx = w / 2 + this.currentDx;
            let cy = h / 2 + this.currentDy;

            if (this.emblemLoaded && this.emblemImg) {
                this.ctx2d.save();
                this.ctx2d.drawImage(this.emblemImg, cx - rad, cy - rad, rad * 2, rad * 2);
                this.ctx2d.restore();
            } else if (!this.options.emblem) {
                // Fallback default dark center circle
                this.ctx2d.save();
                this.ctx2d.beginPath();
                this.ctx2d.arc(cx, cy, rad, 0, Math.PI * 2);
                this.ctx2d.fillStyle = '#0a0a0a';
                this.ctx2d.fill();
                this.ctx2d.restore();
            }
        }

        start() {
            if (!this.running) {
                this.running = true;
                this.render();
            }
        }

        stop() {
            this.running = false;
        }

        resize() {
            const w = this.wrapper.clientWidth || window.innerWidth;
            const h = this.wrapper.clientHeight || window.innerHeight;

            this.canvas2d.width = w;
            this.canvas2d.height = h;

            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();

            this.renderer.setSize(w, h);
            if (this.spectrumUniforms) {
                this.spectrumUniforms.uResolution.value.set(w, h);
                this.spectrumUniforms.uResMult.value = this._getResMult();
                this.spectrumUniforms.uGlowRadius.value = this.options.glowRadius * this._getResMult();
            }
            this._updateParticleSizes();
        }

        destroy() {
            this.stop();
            window.removeEventListener('resize', this._onResize);
            if (this.renderer) {
                this.renderer.dispose();
            }
            if (this.wrapper && this.wrapper.parentNode) {
                this.wrapper.parentNode.removeChild(this.wrapper);
            }
            if (this.audioCtx && this.audioCtx.state !== 'closed') {
                this.audioCtx.close();
            }
        }
    }

    return JsNationVisualizer;
}));
