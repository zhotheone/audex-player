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
    const COLORS_JSNATION = [
        new THREE.Color(0xFFFFFF), new THREE.Color(0xFFFF00),
        new THREE.Color(0xFF0000), new THREE.Color(0xFF66FF),
        new THREE.Color(0x333399), new THREE.Color(0x0000FF),
        new THREE.Color(0x33CCFF), new THREE.Color(0x00FF00)
    ];
    const COLORS_LAVALAMP = [
        new THREE.Color(0xFFFFFF), new THREE.Color(0xFFCC00),
        new THREE.Color(0xFF6600), new THREE.Color(0xFF1744),
        new THREE.Color(0xD500F9), new THREE.Color(0xFF007F),
        new THREE.Color(0xFF9100), new THREE.Color(0xFF4500)
    ];

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
            uniform sampler2D pointTexture;
            varying float vAlpha;
            varying vec3 vColor;
            void main() {
                gl_FragColor = vec4(vColor, vAlpha) * texture2D(pointTexture, gl_PointCoord);
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
        `,
        fragLava: `
            precision highp float;
            uniform vec2 uResolution;
            uniform vec3 uBlobs[3];
            uniform vec3 uBlobColors[3];
            uniform float uAudioMultiplier;

            void main() {
                vec2 st = gl_FragCoord.xy / uResolution.xy;
                float aspect = uResolution.x / max(1.0, uResolution.y);
                vec2 p = vec2(st.x * aspect, st.y);

                float totalField = 0.0;
                vec3 colSum = vec3(0.0);

                for (int i = 0; i < 3; i++) {
                    vec2 bPos = vec2(uBlobs[i].x * aspect, uBlobs[i].y);
                    float r = uBlobs[i].z;
                    float d = length(p - bPos);
                    float f = (r * r) / (d * d + 0.002);
                    totalField += f;
                    colSum += uBlobColors[i] * f;
                }

                vec3 blobColor = colSum / max(0.001, totalField);

                float edge = smoothstep(0.7, 1.25, totalField);
                float inner = smoothstep(1.25, 2.4, totalField);
                float glow = smoothstep(0.35, 0.9, totalField) * 0.18;

                vec3 finalCol = mix(blobColor * 0.85, min(blobColor * 1.35 + vec3(0.1), vec3(1.0)), inner * 0.4);
                float alpha = clamp(edge * 0.95 + glow * 0.6, 0.0, 0.95);

                gl_FragColor = vec4(finalCol, alpha);
            }
        `
    };

    class JsNationVisualizer {
        constructor(options = {}) {
            this.container = typeof options.container === 'string'
                ? document.querySelector(options.container)
                : (options.container || document.body);

            this.options = Object.assign({
                mode: 'jsnation',
                glow: true,
                particles: true,
                spectrum: true,
                background: '#111111',
                emblem: null,
                minEmblemSize: 320,
                maxEmblemSize: 400,
                spectrumHeightScalar: 0.4,
                glowRadius: 25,
                loudness: 1.0,
                fovPunch: true,
                particleCount: 7200
            }, options);

            this.defaultParticleCount = options.particleCount || 7200;
            this.isLavaLamp = this.options.mode === 'lavalamp';
            this.options.particleCount = this.isLavaLamp ? 140 : this.defaultParticleCount;

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
                this.audioCtx = (source && source.context) || new AudioContextClass();
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
            const format = THREE.RedFormat || THREE.LuminanceFormat || 1028;
            this.audioTex = new THREE.DataTexture(this.texData, KEEP_BINS, SPECTRUM_COUNT, format, THREE.FloatType);
            this.audioTex.minFilter = THREE.LinearFilter;
            this.audioTex.magFilter = THREE.LinearFilter;

            const spectrumColors = this.isLavaLamp ? COLORS_LAVALAMP : COLORS_JSNATION;
            this.spectrumUniforms = {
                uResolution: { type: 'v2', value: new THREE.Vector2(width, height) },
                uCenter: { type: 'v2', value: new THREE.Vector2(width / 2, height / 2) },
                uCurRadius: { type: 'f', value: 0.0 },
                uAudioTex: { type: 't', value: this.audioTex },
                uColors: { type: 'v3v', value: spectrumColors },
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

            const GeomClass = THREE.PlaneGeometry || THREE.PlaneBufferGeometry;
            this.spectrumMesh = new THREE.Mesh(new GeomClass(2, 2), this.spectrumMaterial);
            this.spectrumMesh.frustumCulled = false;
            this.spectrumMesh.visible = !this.isLavaLamp;
            this.scene.add(this.spectrumMesh);

            // Particles System
            this._initParticles();

            // Lava Lamp Mesh
            this._initLavaLamp();
        }

        _initLavaLamp() {
            this.blobCount = 3;
            this.lastMultiplier = 0;
            this.blobs = [
                { baseRadius: 0.28, phaseX: 0.0, phaseY: 1.8, freqX: 0.28, freqY: 0.22, ampX: 0.44, ampY: 0.36, deltaReact: 1.6, inertia: 0 },
                { baseRadius: 0.32, phaseX: 2.4, phaseY: 4.1, freqX: 0.20, freqY: 0.30, ampX: 0.46, ampY: 0.38, deltaReact: 0.9, inertia: 0 },
                { baseRadius: 0.25, phaseX: 4.8, phaseY: 0.6, freqX: 0.34, freqY: 0.26, ampX: 0.40, ampY: 0.44, deltaReact: 2.2, inertia: 0 }
            ];
            this.blobUniformData = [
                new THREE.Vector3(0.5, 0.5, 0.28),
                new THREE.Vector3(0.3, 0.7, 0.32),
                new THREE.Vector3(0.7, 0.3, 0.25)
            ];

            const DEFAULT_PALETTE = [
                new THREE.Vector3(1.0, 0.28, 0.15),
                new THREE.Vector3(0.95, 0.65, 0.1),
                new THREE.Vector3(0.65, 0.1, 0.9)
            ];
            this.blobColorUniformData = DEFAULT_PALETTE.map(c => c.clone());
            this.targetLavaColors = DEFAULT_PALETTE.map(c => c.clone());

            const w = this.wrapper ? (this.wrapper.clientWidth || window.innerWidth) : window.innerWidth;
            const h = this.wrapper ? (this.wrapper.clientHeight || window.innerHeight) : window.innerHeight;

            this.lavaUniforms = {
                uResolution: { type: 'v2', value: new THREE.Vector2(w, h) },
                uBlobs: { type: 'v3v', value: this.blobUniformData },
                uBlobColors: { type: 'v3v', value: this.blobColorUniformData },
                uAudioMultiplier: { type: 'f', value: 0.0 }
            };

            this.lavaMaterial = new THREE.ShaderMaterial({
                uniforms: this.lavaUniforms,
                vertexShader: SHADERS.vertSpectrum,
                fragmentShader: SHADERS.fragLava,
                transparent: true,
                depthTest: false,
                depthWrite: false
            });

            const GeomClass = THREE.PlaneGeometry || THREE.PlaneBufferGeometry;
            this.lavaMesh = new THREE.Mesh(new GeomClass(2, 2), this.lavaMaterial);
            this.lavaMesh.frustumCulled = false;
            this.lavaMesh.visible = this.isLavaLamp;
            this.scene.add(this.lavaMesh);
        }

        _initParticles() {
            this.maxParticles = this.options.maxParticles || 30000;
            this.particleCount = Math.min(this.options.particleCount || 7200, this.maxParticles);
            
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

            for (let i = 0; i < max; i++) {
                this.baseSizes[i] = 8 + Math.random() * 5;
                alphaArr[i] = 0.9 + Math.random() * 0.1;
                this._resetParticleVelocity(i);
            }

            const setAttr = (geom, name, attr) => (geom.setAttribute || geom.addAttribute).call(geom, name, attr);
            setAttr(this.particlesGeom, 'position', new THREE.BufferAttribute(posArr, 3));
            setAttr(this.particlesGeom, 'size', new THREE.BufferAttribute(sizeArr, 1));
            setAttr(this.particlesGeom, 'alpha', new THREE.BufferAttribute(alphaArr, 1));
            this.particlesGeom.setDrawRange(0, this.particleCount);

            if (this.options.particleTexture && typeof this.options.particleTexture === 'object') {
                this.particleTexture = this.options.particleTexture;
            } else {
                const c = document.createElement('canvas');
                c.width = 64; c.height = 64;
                const ctx = c.getContext('2d');
                const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
                g.addColorStop(0, 'rgba(255,255,255,1)');
                g.addColorStop(0.3, 'rgba(255,255,255,0.7)');
                g.addColorStop(1, 'rgba(255,255,255,0)');
                ctx.fillStyle = g;
                ctx.fillRect(0, 0, 64, 64);
                this.particleTexture = new THREE.CanvasTexture(c);
                this.particleTexture.minFilter = THREE.LinearFilter;
            }

            this.particleMaterial = new THREE.ShaderMaterial({
                uniforms: {
                    color: { type: 'c', value: new THREE.Color(0xFFFFFF) },
                    pointTexture: { type: 't', value: this.particleTexture }
                },
                vertexShader: SHADERS.vertParticle,
                fragmentShader: SHADERS.fragParticle,
                blending: THREE.NormalBlending,
                transparent: true,
                depthWrite: false
            });

            this.particleSystem = new THREE.Points(this.particlesGeom, this.particleMaterial);
            this.particleSystem.visible = !this.isLavaLamp;
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
                this._updateParticleSizes();
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

        _updateLavaLamp(multiplier) {
            if (!this.blobs || !this.lavaMesh || !this.lavaMesh.visible) return;
            const delta = Math.max(0, multiplier - (this.lastMultiplier || 0));
            this.lastMultiplier = multiplier;

            const speed = 0.18 + multiplier * 3.6;
            const dt = 1.0 / 60.0;
            for (let i = 0; i < this.blobCount; i++) {
                const b = this.blobs[i];
                if (delta > 0.015) {
                    b.inertia = Math.min(0.6, (b.inertia || 0) + delta * b.deltaReact);
                }
                b.inertia = (b.inertia || 0) * 0.88;

                b.phaseX += b.freqX * dt * speed;
                b.phaseY += b.freqY * dt * speed;

                const x = 0.5 + b.ampX * Math.sin(b.phaseX) + 0.03 * Math.sin(b.phaseX * 2.1);
                const y = 0.5 + b.ampY * Math.cos(b.phaseY) + 0.03 * Math.cos(b.phaseY * 1.8);
                const r = b.baseRadius * (1.0 + b.inertia * 0.5 + multiplier * 0.15 + 0.03 * Math.sin(b.phaseX * 1.4));

                this.blobUniformData[i].set(x, y, r);

                if (this.targetLavaColors && this.targetLavaColors[i]) {
                    this.blobColorUniformData[i].lerp(this.targetLavaColors[i], 0.06);
                }
            }
            if (this.lavaUniforms) {
                this.lavaUniforms.uAudioMultiplier.value = multiplier;
            }
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

        setMode(mode) {
            this.options.mode = mode;
            this.isLavaLamp = mode === 'lavalamp';
            this.isBars = mode === 'bars';
            this.setParticleCount(this.isLavaLamp || this.isBars ? 140 : (this.defaultParticleCount || 7200));
            if (this.spectrumMesh) this.spectrumMesh.visible = !this.isLavaLamp && !this.isBars;
            if (this.particleSystem) this.particleSystem.visible = !this.isLavaLamp && !this.isBars;
            if (this.lavaMesh) this.lavaMesh.visible = this.isLavaLamp;
            if ((this.isLavaLamp || this.isBars) && this.ctx2d) {
                this.ctx2d.clearRect(0, 0, this.canvas2d.width, this.canvas2d.height);
            }
        }

        _initEmblem() {
            this.emblemImg = null;
            this.emblemLoaded = false;
        }

        setBackground(bg) {
            this.options.background = bg;
            if (!this.wrapper) return;
            if (!bg || bg === 'transparent' || bg === 'none') {
                this.wrapper.style.background = 'transparent';
            } else if (bg.startsWith('#') || bg.startsWith('rgb') || bg.startsWith('hsl')) {
                this.wrapper.style.background = bg;
            } else {
                this.wrapper.style.background = `url("${bg}") center/cover no-repeat`;
            }
        }

        _extractThumbnailColors(img) {
            if (!img || !img.width || !img.height) return;
            try {
                const cvs = document.createElement('canvas');
                cvs.width = 32;
                cvs.height = 32;
                const ctx = cvs.getContext('2d');
                ctx.drawImage(img, 0, 0, 32, 32);
                const data = ctx.getImageData(0, 0, 32, 32).data;
                const sampled = [];
                let totalLum = 0, count = 0;

                for (let i = 0; i < data.length; i += 16) {
                    const r = data[i] / 255;
                    const g = data[i + 1] / 255;
                    const b = data[i + 2] / 255;
                    if (data[i + 3] < 128) continue;

                    const max = Math.max(r, g, b);
                    const min = Math.min(r, g, b);
                    const lum = (max + min) / 2;
                    const sat = max === 0 ? 0 : (max - min) / max;
                    totalLum += lum;
                    count++;

                    if (lum > 0.05 && lum < 0.95) {
                        sampled.push({ r, g, b, sat, lum });
                    }
                }

                if (sampled.length === 0) return;
                const isLightBg = count > 0 && (totalLum / count) > 0.55;

                sampled.sort((a, b) => b.sat - a.sat);

                const picked = [sampled[0]];
                for (let i = 1; i < sampled.length && picked.length < 3; i++) {
                    const c = sampled[i];
                    const distinct = picked.every(p => {
                        const dr = p.r - c.r, dg = p.g - c.g, db = p.b - c.b;
                        return (dr * dr + dg * dg + db * db) > 0.07;
                    });
                    if (distinct) picked.push(c);
                }

                while (picked.length < 3) {
                    const base = picked[0];
                    picked.push({ r: base.g, g: base.b, b: base.r, lum: base.lum });
                }

                // Ensure contrast against background
                this.targetLavaColors = picked.slice(0, 3).map(c => {
                    let { r, g, b, lum } = c;
                    if (isLightBg && lum > 0.42) {
                        const s = 0.38 / Math.max(0.01, lum);
                        r *= s; g *= s; b *= s;
                    } else if (!isLightBg && lum < 0.48) {
                        const s = 0.72 / Math.max(0.01, lum);
                        r = Math.min(1, r * s);
                        g = Math.min(1, g * s);
                        b = Math.min(1, b * s);
                    }
                    return new THREE.Vector3(r, g, b);
                });

                if (this.particleMaterial && this.particleMaterial.uniforms && this.particleMaterial.uniforms.color) {
                    this.particleMaterial.uniforms.color.value.setHex(isLightBg ? 0x111625 : 0xFFFFFF);
                }
            } catch (_) {
                // Ignore cross-origin canvas security errors
            }
        }

        setEmblem(emblem) {
            this.options.emblem = emblem;
            if (!emblem) {
                this.emblemImg = null;
                this.emblemLoaded = false;
                const DEFAULT_PALETTE = [
                    new THREE.Vector3(1.0, 0.28, 0.15),
                    new THREE.Vector3(0.95, 0.65, 0.1),
                    new THREE.Vector3(0.65, 0.1, 0.9)
                ];
                this.targetLavaColors = DEFAULT_PALETTE.map(c => c.clone());
                return;
            }
            this.emblemImg = new Image();
            this.emblemImg.crossOrigin = 'anonymous';
            this.emblemImg.onload = () => {
                this.emblemLoaded = true;
                this._extractThumbnailColors(this.emblemImg);
            };
            this.emblemImg.src = emblem;
            if (this.emblemImg.complete && this.emblemImg.naturalWidth) {
                this.emblemLoaded = true;
                this._extractThumbnailColors(this.emblemImg);
            }
        }

        setGlow(enabled) {
            this.options.glow = !!enabled;
            if (this.spectrumUniforms) {
                this.spectrumUniforms.uGlowEnabled.value = this.options.glow ? 1.0 : 0.0;
            }
        }

        setParticles(enabled) {
            this.options.particles = !!enabled;
            if (this.particleSystem) this.particleSystem.visible = this.options.particles && !this.isLavaLamp;
        }

        setSpectrum(enabled) {
            this.options.spectrum = !!enabled;
            if (this.spectrumMesh) this.spectrumMesh.visible = this.options.spectrum && !this.isLavaLamp;
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

            if (this.isLavaLamp) {
                this._updateLavaLamp(multiplier);
            } else {
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
                    const count = Math.floor(this.particleCount / 2);
                    for (let i = 0; i < count; i++) {
                        this._updateParticle(i, multiplier);
                    }
                    this.particlesGeom.attributes.position.needsUpdate = true;
                }

                if (this.options.fovPunch && this.camera) {
                    this.camera.fov = 45 - (multiplier * 3.5);
                    this.camera.updateProjectionMatrix();
                }
            }

            // Render WebGL
            this.renderer.render(this.scene, this.camera);

            // Render Emblem or 48 Bars on 2D Overlay
            if (this.isBars) {
                this._drawBars();
            } else {
                this._drawEmblem(multiplier);
            }
        }

        _drawBars() {
            let w = this.canvas2d.width;
            let h = this.canvas2d.height;
            this.ctx2d.clearRect(0, 0, w, h);

            if (!this.barHeights) this.barHeights = new Float32Array(48);
            if (!this.barVelocities) this.barVelocities = new Float32Array(48);

            const BARS = 48;
            const freq = this.freqData;
            const len = freq ? freq.length : 0;

            for (let i = 0; i < BARS; i++) {
                let target = 0;
                if (len > 0) {
                    const logMin = Math.log(2);
                    const logMax = Math.log(Math.min(len * 0.75, 450));
                    const startIdx = Math.floor(Math.exp(logMin + (i / BARS) * (logMax - logMin)));
                    const endIdx = Math.max(startIdx + 1, Math.floor(Math.exp(logMin + ((i + 1) / BARS) * (logMax - logMin))));
                    let sum = 0, count = 0;
                    for (let j = startIdx; j < endIdx && j < len; j++) {
                        sum += freq[j];
                        count++;
                    }
                    target = count > 0 ? (sum / count) / 255 : 0;
                    target *= (1 + (i / BARS) * 0.75);
                    target = Math.min(1.0, target);
                }
                const diff = target - this.barHeights[i];
                this.barVelocities[i] = this.barVelocities[i] * 0.74 + diff * 0.26;
                this.barHeights[i] = Math.max(0, this.barHeights[i] + this.barVelocities[i]);
            }

            const totalWidth = Math.min(w * 0.85, 780);
            const gap = Math.max(2, Math.min(5, (totalWidth / BARS) * 0.22));
            const barWidth = (totalWidth - (BARS - 1) * gap) / BARS;
            const startX = (w - totalWidth) / 2;
            const maxBarH = Math.min(h * 0.35, 200);
            const bottomY = h * 0.58;
            const rad = barWidth / 2;
            const ctx = this.ctx2d;

            for (let i = 0; i < BARS; i++) {
                const val = this.barHeights[i];
                const barH = Math.max(3, val * maxBarH);
                const x = startX + i * (barWidth + gap);
                const y = bottomY - barH;

                const grad = ctx.createLinearGradient(x, y, x, bottomY);
                grad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
                grad.addColorStop(0.5, 'rgba(230, 230, 255, 0.70)');
                grad.addColorStop(1, 'rgba(180, 190, 255, 0.25)');

                ctx.fillStyle = grad;
                ctx.beginPath();
                if (ctx.roundRect) {
                    ctx.roundRect(x, y, barWidth, barH, rad);
                } else {
                    ctx.rect(x, y, barWidth, barH);
                }
                ctx.fill();
            }
        }

        _drawEmblem(multiplier) {
            let w = this.canvas2d.width;
            let h = this.canvas2d.height;
            this.ctx2d.clearRect(0, 0, w, h);

            if (this.isLavaLamp) return;

            let rad = this._getResMult() * (multiplier * (this.options.maxEmblemSize - this.options.minEmblemSize) + this.options.minEmblemSize) / 2;
            let cx = w / 2 + this.currentDx;
            let cy = h / 2 + this.currentDy;

            if (rad <= 0) return;

            this.ctx2d.save();
            this.ctx2d.beginPath();
            this.ctx2d.arc(cx, cy, rad, 0, Math.PI * 2);
            this.ctx2d.closePath();
            this.ctx2d.clip();

            if (this.emblemLoaded && this.emblemImg) {
                const img = this.emblemImg;
                const iw = img.naturalWidth || img.width || 1;
                const ih = img.naturalHeight || img.height || 1;
                let sx = 0, sy = 0, sw = iw, sh = ih;
                if (iw > ih) {
                    sw = ih;
                    sx = (iw - ih) / 2;
                } else if (ih > iw) {
                    sh = iw;
                    sy = (ih - iw) / 2;
                }
                this.ctx2d.drawImage(img, sx, sy, sw, sh, cx - rad, cy - rad, rad * 2, rad * 2);
            } else if (!this.options.emblem) {
                this.ctx2d.fillStyle = '#0a0a0a';
                this.ctx2d.fill();
            }
            this.ctx2d.restore();
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
            if (this.lavaUniforms) {
                this.lavaUniforms.uResolution.value.set(w, h);
            }
            this._updateParticleSizes();
        }

        destroy() {
            this.stop();
            window.removeEventListener('resize', this._onResize);
            if (this.renderer) {
                this.renderer.dispose();
            }
            if (this.lavaMaterial) {
                this.lavaMaterial.dispose();
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
