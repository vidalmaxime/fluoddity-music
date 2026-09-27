// Fluoddity DJ — orchestrator.
//
// audio → MusicBrain (features, beats, sections) → Director (preset choices)
//       → Mixer (deck crossfade) → Reactor (modulation) → Engine (GPU physics + render)

import { FluoddityEngine } from './engine.js';
import { loadLibrary, Mixer, Director } from './decks.js';
import { Reactor, defaultRouting, defaultLook, TARGETS } from './reactor.js';
import { AudioEngine } from './audio/audio-engine.js';
import { MusicBrain } from './audio/music-brain.js';
import { cohortRules } from './rule.js';
import { UI } from './ui.js';
import { Midi } from './midi.js';
import { Output } from './output.js';

const STORE = 'fluoddity-dj.v1';

// Scale factors from normalised reactor outputs to world units per frame.
const K = {
    rippleUV: 0.02,     // screen refraction of a full-strength shockwave
    shockInk: 0.01,     // trail-field ink of a full-strength shockwave (natural trails: p90 ≈ 4e-3)
    shockWidth: 0.07,
    swirl: 0.012,       // radians per frame at the centre
    breathe: 0.006,
    jitter: 0.0025,
    specInk: 0.012,
    orbiter: 2.5,
};

class App {
    constructor() {
        this.canvas = document.getElementById('gl');
        this.settings = { worldSize: 1, steps: 4, sensitivity: 1, renderScale: 1 };
        this.cam = { pos: [0, 0], zoom: 1 };
        this.mouseMode = 'select';
        this.paused = false;
        this.fade = 1;
        this.fadeTarget = 1;
        this.stepAcc = 0;
        this.perfScale = 1;
        this.frameEMA = 1 / 60;
        this.undo = [];
        this.pointer = { down: false, x: 0, y: 0, px: 0, py: 0, moved: 0, button: 0 };
        this.orbitPrev = [];
        this.freePhase = 0;
        this.time = 0;
        this.simAspect = 1;
    }

    async boot() {
        const gl = this.canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
        if (!gl) throw new Error('WebGL 2 is not available in this browser.');
        this.gl = gl;
        this._resizeCanvas();

        this.engine = new FluoddityEngine(gl);
        this.engine.init();

        this.library = await loadLibrary();
        const byName = (n) => this.library.find((p) => p.name === n);
        this.mixer = new Mixer(byName('LavaLamp') || this.library[0], byName('HungryHungryHippos') || this.library[1]);
        this.director = new Director(this.mixer, this.library);
        this.reactor = new Reactor();

        this.audio = new AudioEngine();
        await this.audio.init();
        this.brain = new MusicBrain({ sampleRate: this.audio.sampleRate, hop: 512 });
        this.audio.onchange = () => this._onAudioChange();

        this._load();
        this.brain.setSensitivity(this.settings.sensitivity);

        this.output = new Output(this.canvas, {
            onRecordingChange: (on) => this.ui?.setRecording(on),
            onError: (m) => this.ui?.error(m),
        });
        this.ui = new UI(this);
        this.midi = new Midi({ toast: (m) => this.ui.toast(m) });
        this.director.onaction = (msg) => this.ui.toast(msg);
        this.mixer.onchange = () => { this.reactor.anchorHue(); this.save(); };

        this.simAspect = this.canvas.width / this.canvas.height;
        if (!this._loadedCalibration) await this._calibrate();
        else this.engine.configure(this.settings.worldSize, this.simAspect);
        this.ui.syncControls();
        this.ui.setGpuStatus(`GPU ready · ${this.engine.c.count.toLocaleString()} particles · ${this.settings.steps} steps/frame${this.engine.floatBlend ? '' : ' · half-float trails'}`);

        this._bindInput();
        this.last = performance.now();
        // A pending rAF never fires once hidden (and vice versa): reschedule on change.
        document.addEventListener('visibilitychange', () => this._schedule());
        this._schedule();
    }

    // rAF normally; when the page is hidden/occluded (e.g. the controls window
    // sits behind the projector window) browsers stop rAF and throttle timers,
    // so fall back to ticks from a Worker, whose timers keep running.
    _schedule() {
        const token = (this._schedToken = (this._schedToken || 0) + 1);
        if (!document.hidden) {
            requestAnimationFrame((t) => { if (token === this._schedToken) this._frame(t); });
            return;
        }
        if (!this._ticker) {
            const src = 'setInterval(() => postMessage(0), 1000 / 60);';
            this._ticker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
            this._ticker.onmessage = () => {
                // Leave the main thread breathing room between frames (UI, MIDI, audio messages)
                const now = performance.now();
                if (this._tickToken !== this._schedToken || now - (this._frameEnd || 0) < 8) return;
                this._tickToken = -1;
                this._frame(now);
            };
        }
        this._tickToken = token;
    }

    // ── calibration ────────────────────────────────────────────────────────
    // Measure settled, spatially-sorted physics cost per world size and pick
    // the densest world that still runs >= 4 steps per 60 Hz frame.
    async _calibrate() {
        this.ui.setGpuStatus('Calibrating GPU…');
        await new Promise((r) => setTimeout(r, 30));
        const e = this.engine;
        const u = this._simUniforms(this._idleFx(), 0);
        const measure = async (ws) => {
            e.configure(ws, this.simAspect);
            e.advance(u, 40);
            await e.sortNow();
            // Keep the GPU busy for a moment so it leaves its idle clocks
            const warm = performance.now();
            while (performance.now() - warm < 350) { e.advance(u, 2); e.sync(); }
            await e.sortNow();
            e.sync();
            const t0 = performance.now();
            e.advance(u, 20);
            e.sync();
            return (performance.now() - t0) / 20;
        };
        let best = 0.25, per = await measure(0.25);
        console.log(`[calibrate] world 0.25: ${per.toFixed(2)} ms/step`);
        for (const ws of [0.5, 1, 1.5]) {
            const t = await measure(ws);
            console.log(`[calibrate] world ${ws}: ${t.toFixed(2)} ms/step`);
            if (t <= 3.4) { best = ws; per = t; } else break;
        }
        this.settings.worldSize = best;
        this.settings.steps = Math.max(3, Math.min(8, Math.floor(13 / Math.max(per, 0.3))));
        e.configure(best, this.simAspect);
        console.log(`[calibrate] → world ${best}, ${this.settings.steps} steps/frame`);
        this.save();
    }

    setWorldSize(ws) {
        this.settings.worldSize = ws;
        this.simAspect = this.canvas.width / this.canvas.height;
        this.engine.configure(ws, this.simAspect);
        this.ui.toast(`World ${ws} · ${this.engine.c.count.toLocaleString()} particles`);
        this.save();
    }

    resetSim() {
        this.simAspect = this.canvas.width / this.canvas.height;
        this.engine.configure(this.settings.worldSize, this.simAspect);
    }

    // ── audio ──────────────────────────────────────────────────────────────
    async startSource(kind, deviceId) {
        try {
            if (kind === 'tab') await this.audio.useTabCapture();
            else if (kind === 'input') {
                await this.audio.useInput(deviceId);
                this.ui.fillDevices(await this.audio.listInputDevices(), deviceId);
            } else if (kind === 'demo') await this.audio.useDemo();
            this.ui.hideStart();
            this.ui.markSource(kind);
        } catch (e) {
            console.error(e);
            this.ui.error(e.message || String(e));
        }
    }

    async startFiles(files) {
        const audioFiles = files.filter((f) => f.type.startsWith('audio/') || /\.(mp3|wav|flac|m4a|aac|ogg|opus|aiff?)$/i.test(f.name));
        if (!audioFiles.length) { this.ui.error('No audio files found in that drop.'); return; }
        try {
            await this.audio.useFiles(audioFiles);
            this.ui.hideStart();
            this.ui.markSource('files');
        } catch (e) {
            this.ui.error(e.message || String(e));
        }
    }

    _onAudioChange() {
        this.ui?.setSourceLabel(this.audio.sourceLabel || '');
        if (this.audio.sourceType === 'none') this.ui?.markSource(null);
    }

    toggleRecording() {
        if (this.output.recording) this.output.stopRecording();
        else {
            this.output.startRecording(this.audio.recordStream);
            this.ui.toast('Recording… (press again to stop and download)');
        }
    }

    toggleFullscreen() {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen().catch(() => {});
    }

    // ── deck actions ───────────────────────────────────────────────────────
    _pushUndo() {
        this.undo.push(this.mixer.dominant);
        if (this.undo.length > 50) this.undo.shift();
    }

    play(preset, cut = false) {
        this._pushUndo();
        if (cut) this.mixer.cut(preset);
        else this.mixer.mixTo(preset, this.director.settings.mixBeats);
        this.director.barsSinceChange = 0;
        this.director._remember(preset);
    }

    next(cut = false) {
        const p = this.director.next({ cut });
        if (p) this.ui.toast(`${cut ? 'Cut' : 'Mixing'} → ${p.name}`);
    }

    drop() {
        this.reactor.triggerDrop();
        const s = this.director.settings;
        if (s.enabled && s.onDrop !== 'none') {
            const p = this.director.next({ cut: s.onDrop === 'cut', beats: 2 });
            if (p) this.ui.toast(`DROP → ${p.name}`);
        }
    }

    evolve() {
        const c = this.director.evolve(this.engine.c.count);
        this.ui.toast(`Evolving → ${c.name}`);
    }

    toggleFavorite(name) {
        const f = this.director.favorites;
        if (f.has(name)) f.delete(name); else f.add(name);
        this.ui.renderLibrary();
        this.save();
    }

    pickParticle(x01, y01) {
        const [wx, wy] = this.engine.screenToWorld(x01, y01, this.cam.pos, this.cam.zoom);
        const { state, aux } = this.engine.readState();
        const n = this.engine.c.count;
        let slot = -1, bd = Infinity;
        for (let i = 0; i < n; i++) {
            const dx = state[i * 4] - wx, dy = state[i * 4 + 1] - wy;
            const d = dx * dx + dy * dy;
            if (d < bd) { bd = d; slot = i; }
        }
        if (slot < 0) return;
        const best = Math.round(aux[slot * 4 + 3]); // particle identity (slots are spatially sorted)
        const child = this.mixer.lineageOf(best, n);
        this._pushUndo();
        this.mixer.mixTo(child, 2);
        this.ui.toast(`Adopted particle #${best} → ${child.name}`);
    }

    // ── per-frame ──────────────────────────────────────────────────────────
    _idleFx() {
        const ph = this.mixer.blendedPhysics();
        return this.reactor.update(0, {}, [], ph);
    }

    // Per-tribe rules are rebuilt on the CPU only when a deck or its mutation changes.
    _deckUniforms(side, d, mutDelta) {
        const mut = Math.round((d.physics.mutation_scale + mutDelta) * 2000) / 2000;
        const cache = (this._ruleCache ||= [{}, {}])[side];
        if (cache.deck !== d || cache.mut !== mut) {
            this.engine.setDeckRules(side, cohortRules(d.rule, d.rule_seed, d.gen, mut, d.cohorts), d.cohorts);
            cache.deck = d;
            cache.mut = mut;
        }
        return { cohorts: d.cohorts, orient: [d.absolute_orientation, d.orientation_mix], hue: [d.color_by_cohort ? 1 : 0, d.hue_sensitivity] };
    }

    _simUniforms(fx, dt) {
        const m = this.mixer;
        const dom = m.dominant;
        const edge = this.engine.c ? this.engine.c.edge : [1, 1];
        const shockInk = new Float32Array(16);
        (fx.shocks || []).forEach((s, i) => {
            const env = Math.max(0, s.life);
            shockInk.set([s.x, s.y, s.r, s.ink * env * K.shockInk], i * 4);
        });

        // Strokes: mouse drawing + beat-locked orbiters
        const strokes = new Float32Array(24), strokeP = new Float32Array(12);
        let n = 0;
        if (this.mouseMode === 'draw' && this.pointer.down && this.pointer.button === 0 && this.engine.c) {
            const r = this.canvas.getBoundingClientRect();
            const p = this.engine.screenToWorld(this.pointer.x / r.width, this.pointer.y / r.height, this.cam.pos, this.cam.zoom);
            const q = this.engine.screenToWorld(this.pointer.px / r.width, this.pointer.py / r.height, this.cam.pos, this.cam.zoom);
            strokes.set([p[0], p[1], q[0], q[1]], 0);
            strokeP.set([0.035 / this.cam.zoom, 4], 0);
            n = 1;
        }
        const orb = fx.orbiters || 0;
        if (orb > 0.01 && dt > 0) {
            const s = this.brain?.state || {};
            if (!(s.bpm > 0)) this.freePhase = (this.freePhase + dt * 0.25) % 1;
            const ph = s.bpm > 0 ? s.barPhase : this.freePhase;
            const count = 3;
            for (let i = 0; i < count; i++) {
                const a = 2 * Math.PI * (ph + i / count);
                const rad = edge[1] * (0.55 + 0.15 * Math.sin(2 * Math.PI * (ph * 2 + i / count)));
                const p = [Math.cos(a) * rad * 1.2, Math.sin(a) * rad];
                const prev = this.orbitPrev[i] || p;
                strokes.set([p[0], p[1], prev[0], prev[1]], n * 4);
                strokeP.set([0.05, orb * K.orbiter], n * 2);
                this.orbitPrev[i] = p;
                n++;
            }
        } else this.orbitPrev = [];

        return {
            sensorGain: fx.sensorGain, sensorAngle: fx.sensorAngle, sensorDist: fx.sensorDist, forceMult: fx.forceMult,
            drag: fx.drag, strafe: fx.strafe, axial: fx.axial, lateral: fx.lateral, hazard: fx.hazard, symmetry: fx.symmetry,
            boundary: dom.boundary, resetMode: dom.initial_conditions, resetCohorts: dom.cohorts,
            deckA: this._deckUniforms(0, m.decks[0], fx.mutationDelta || 0),
            deckB: this._deckUniforms(1, m.decks[1], fx.mutationDelta || 0),
            xfade: m.xf,
            shockInk, shockWidth: K.shockWidth,
            swirl: (fx.swirl || 0) * K.swirl, breathe: (fx.breathe || 0) * K.breathe, jitter: (fx.jitter || 0) * K.jitter,
            rebirth: fx.rebirth || 0, swirlCenter: [0, 0],
            persist: fx.persist, diffusion: fx.diffusion,
            strokes, strokeP, strokeCount: n,
            specInk: (fx.specInk || 0) * K.specInk, specRadius: 0.5 * edge[1], specRot: 0, specMode: 0,
        };
    }

    // Shockwaves in screen space (centre uv, radius and amplitude in screen heights)
    _rippleUniforms(fx) {
        const out = this._rippleBuf || (this._rippleBuf = new Float32Array(16));
        out.fill(0);
        const c = this.engine.c;
        const fit = this.engine.fitScale();
        const zoom = this.cam.zoom * fx.zoom;
        (fx.shocks || []).forEach((s, i) => {
            if (i > 3 || !(s.amp > 0)) return;
            const ndc = [((s.x - this.cam.pos[0]) / c.edge[0]) * zoom * fit[0], ((s.y - this.cam.pos[1]) / c.edge[1]) * zoom * fit[1]];
            const r = (s.r / c.edge[1]) * zoom * fit[1] * 0.5;
            out.set([ndc[0] * 0.5 + 0.5, ndc[1] * 0.5 + 0.5, r, s.amp * Math.max(0, s.life) * K.rippleUV], i * 4);
        });
        return out;
    }

    _frame(now) {
        this._schedule();
        const dt = Math.min(0.1, Math.max(0.001, (now - this.last) / 1000));
        this.last = now;
        this.time += dt;
        this._resizeCanvas();

        // Music analysis
        const hops = this.audio.drainHops();
        this.brain.update(hops);
        const s = this.brain.state;
        const events = this.brain.events;

        // Decisions & mixing
        this.director.update(events, this.engine.c.count);
        this.mixer.update(dt, s.bpm);

        // Modulation
        this.reactor.edge = this.engine.c.edge;
        const fx = this.reactor.update(dt, s, events, this.mixer.blendedPhysics());

        // Physics
        this.engine.setSpectrum(s.spectrum || new Float32Array(64));
        const u = this._simUniforms(fx, dt);
        if (!this.paused) {
            this.stepAcc += dt * 60 * this.settings.steps * fx.speed * this.perfScale;
            let steps = Math.floor(this.stepAcc);
            this.stepAcc -= steps;
            steps = Math.min(steps, Math.ceil(this.settings.steps * 3));
            this.engine.advance(u, steps);
        }

        // Render
        this.fade += (this.fadeTarget - this.fade) * Math.min(1, dt * 6);
        const look = this.reactor.look;
        this.engine.render({
            camPos: this.cam.pos, camZoom: this.cam.zoom * fx.zoom, xfade: this.mixer.xf, hueShift: fx.hueShift,
            palette: look.palette, satur: look.satur, colorMode: look.colorMode, size: fx.size, spawnGlow: 0.3 + 0.5 * Math.min(1, fx.flash * 2),
            brightness: fx.brightness, flow: fx.flow, boundary: this.mixer.dominant.boundary,
            echo: { decay: fx.echo, zoom: 1 + 0.012 * fx.echoZoom, rot: 0.004 * fx.echoZoom * Math.sin(this.time * 0.3) },
            bloom: { threshold: look.bloomThreshold, strength: fx.bloom },
            ripple: this._rippleUniforms(fx),
            final: { ca: fx.ca, flash: fx.flash, exposure: look.exposure, vignette: look.vignette, fade: this.fade, kaleido: look.kaleido, kaleidoRot: fx.spin },
            time: this.time,
        });

        // Performance governor: back off physics when frames run long, and if
        // even that isn't enough for a while, drop to a smaller world.
        this.frameEMA += (dt - this.frameEMA) * 0.05;
        if (this.frameEMA > 1 / 45) this.perfScale = Math.max(0.35, this.perfScale * 0.985);
        else if (this.frameEMA < 1 / 58) this.perfScale = Math.min(1, this.perfScale * 1.01);
        this.struggle = !document.hidden && this.perfScale <= 0.36 && this.frameEMA > 1 / 30 ? (this.struggle || 0) + dt : 0;
        if (this.struggle > 6 && this.settings.worldSize > 0.25) {
            const sizes = [0.08, 0.25, 0.5, 1, 1.5];
            const next = sizes[Math.max(0, sizes.indexOf(this.settings.worldSize) - 1)];
            this.struggle = 0;
            this.setWorldSize(next);
            this.ui.toast(`GPU struggling — world reduced to ${next}`);
            this.ui.syncControls();
        }

        this.ui.setAccent(fx.hueShift + 0.55);
        const perf = `${(1 / this.frameEMA).toFixed(0)} fps · ${this.engine.c.count.toLocaleString()} particles · ${(this.settings.steps * fx.speed * this.perfScale).toFixed(1)} steps`;
        this.ui.update(dt, s, fx, perf);
        this._frameEnd = performance.now();
    }

    _resizeCanvas() {
        const w = Math.round(window.innerWidth * this.settings.renderScale);
        const h = Math.round(window.innerHeight * this.settings.renderScale);
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
            // Only rebuild the world (which restarts it) if the shape changed a lot.
            if (this.engine?.c) {
                const a = w / h;
                if (Math.abs(Math.log(a / this.simAspect)) > 0.25) {
                    clearTimeout(this._reconf);
                    this._reconf = setTimeout(() => this.resetSim(), 400);
                }
            }
        }
    }

    // ── input ──────────────────────────────────────────────────────────────
    _bindInput() {
        const c = this.canvas;
        c.addEventListener('contextmenu', (e) => e.preventDefault());
        c.addEventListener('pointerdown', (e) => {
            document.activeElement?.blur?.();
            const r = c.getBoundingClientRect();
            Object.assign(this.pointer, { down: true, button: e.button, x: e.clientX - r.left, y: e.clientY - r.top, moved: 0, alt: e.altKey });
            this.pointer.px = this.pointer.x;
            this.pointer.py = this.pointer.y;
            c.setPointerCapture(e.pointerId);
        });
        c.addEventListener('pointermove', (e) => {
            const r = c.getBoundingClientRect();
            const p = this.pointer;
            const x = e.clientX - r.left, y = e.clientY - r.top;
            if (p.down) {
                p.moved += Math.hypot(x - p.x, y - p.y);
                if (p.alt || p.button === 1) {
                    this.cam.pos[0] -= ((x - p.x) / r.width) * 2 * this.engine.c.edge[0] / this.cam.zoom;
                    this.cam.pos[1] += ((y - p.y) / r.height) * 2 * this.engine.c.edge[1] / this.cam.zoom;
                }
            }
            p.px = p.x; p.py = p.y; p.x = x; p.y = y;
        });
        c.addEventListener('pointerup', (e) => {
            const p = this.pointer;
            p.down = false;
            if (p.moved > 6 || p.alt) return;
            const r = c.getBoundingClientRect();
            if (e.button === 2) {
                const prev = this.undo.pop();
                if (prev) { this.mixer.mixTo(prev, 2); this.ui.toast(`Back → ${prev.name}`); }
            } else if (e.button === 0 && this.mouseMode === 'select') {
                this.pickParticle((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
            }
        });
        c.addEventListener('dblclick', () => { this.cam.pos = [0, 0]; this.cam.zoom = 1; });
        c.addEventListener('wheel', (e) => {
            e.preventDefault();
            const r = c.getBoundingClientRect();
            const before = this.engine.screenToWorld((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, this.cam.pos, this.cam.zoom);
            this.cam.zoom = Math.min(12, Math.max(1, this.cam.zoom * Math.exp(-e.deltaY * 0.0015)));
            const after = this.engine.screenToWorld((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, this.cam.pos, this.cam.zoom);
            this.cam.pos[0] += before[0] - after[0];
            this.cam.pos[1] += before[1] - after[1];
            if (this.cam.zoom === 1) this.cam.pos = [0, 0];
        }, { passive: false });

        // Drag & drop audio files
        let dragDepth = 0;
        const hint = document.getElementById('drop-hint');
        window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; hint.classList.remove('hidden'); });
        window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; hint.classList.add('hidden'); } });
        window.addEventListener('dragover', (e) => e.preventDefault());
        window.addEventListener('drop', (e) => {
            e.preventDefault();
            dragDepth = 0;
            hint.classList.add('hidden');
            this.startFiles([...e.dataTransfer.files]);
        });

        window.addEventListener('keydown', (e) => this._key(e));
    }

    _key(e) {
        const t = e.target;
        if (t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox')) return;
        if (e.metaKey || e.ctrlKey) return;
        const k = e.key;
        const look = this.reactor.look;
        const act = {
            h: () => this.ui.toggleHud(),
            f: () => this.toggleFullscreen(),
            ' ': () => { this.paused = !this.paused; this.ui.toast(this.paused ? 'Frozen' : 'Running'); },
            t: () => this.brain.tap(),
            y: () => this.brain.resyncDownbeat(),
            n: () => this.next(false),
            N: () => this.next(true),
            d: () => this.drop(),
            e: () => this.evolve(),
            a: () => {
                const d = this.director.settings;
                d.enabled = !d.enabled;
                document.getElementById('auto-enabled').checked = d.enabled;
                this.ui.toast(`Autopilot ${d.enabled ? 'on' : 'off'}`);
                this.save();
            },
            k: () => {
                const opts = [0, 2, 3, 4, 6, 8, 12];
                look.kaleido = opts[(opts.indexOf(look.kaleido) + 1) % opts.length];
                document.getElementById('kaleido').value = look.kaleido;
                this.ui.toast(look.kaleido ? `Kaleidoscope ×${look.kaleido}` : 'Kaleidoscope off');
            },
            c: () => {
                look.palette = (look.palette + 1) % 6;
                document.getElementById('palette').value = look.palette;
                this.ui.toast(`Palette: ${document.getElementById('palette').selectedOptions[0].text}`);
            },
            r: () => this.resetSim(),
            b: () => { this.fadeTarget = this.fadeTarget > 0.5 ? 0 : 1; },
            m: () => {
                this.mouseMode = this.mouseMode === 'select' ? 'draw' : 'select';
                document.getElementById('mouse-mode').value = this.mouseMode;
                this.ui.toast(`Mouse: ${this.mouseMode === 'draw' ? 'draw flow' : 'select particle'}`);
            },
            '?': () => this.ui.toggleHelp(document.getElementById('help').classList.contains('hidden')),
            Escape: () => { this.ui.toggleHelp(false); if (this.ui.hud.classList.contains('hidden')) this.ui.toggleHud(false); },
            ArrowLeft: () => this.mixer.setCrossfader(this.mixer.xf - 0.05),
            ArrowRight: () => this.mixer.setCrossfader(this.mixer.xf + 0.05),
        };
        const fn = act[k] || (k.length === 1 && act[k.toLowerCase()]);
        if (k >= '1' && k <= '9') {
            const fav = [...this.director.favorites][+k - 1];
            const p = fav && this.library.find((x) => x.name === fav);
            if (p) { this.play(p, e.shiftKey); this.ui.toast(`${e.shiftKey ? 'Cut' : 'Mixing'} → ${p.name}`); }
            else this.ui.toast(`No favourite #${k} — star presets in the library`);
            e.preventDefault();
            return;
        }
        if (fn) {
            e.preventDefault();
            fn();
        }
    }

    // ── persistence ────────────────────────────────────────────────────────
    save() {
        clearTimeout(this._saveT);
        this._saveT = setTimeout(() => {
            try {
                const r = this.reactor;
                localStorage.setItem(STORE, JSON.stringify({
                    settings: this.settings, calibrated: true,
                    reactor: { profile: r.profile, routing: r.routing, master: r.master, look: r.look, harmonic: r.harmonicColor },
                    director: { settings: this.director.settings, favorites: [...this.director.favorites] },
                    decks: this.mixer.decks.map((d) => (d.lineage ? null : d.name)),
                }));
            } catch { /* storage unavailable */ }
        }, 300);
    }

    _load() {
        let data;
        try { data = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { data = null; }
        if (!data) return;
        const r = this.reactor;
        if (data.settings) {
            Object.assign(this.settings, data.settings);
            this._loadedCalibration = !!data.calibrated;
        }
        if (data.reactor) {
            r.profile = data.reactor.profile || 'Pulse';
            const def = defaultRouting(r.profile === 'Custom' ? 'Off' : r.profile);
            r.routing = def;
            for (const t of TARGETS) if (data.reactor.routing?.[t.id]) r.routing[t.id] = { ...def[t.id], ...data.reactor.routing[t.id] };
            r.master = data.reactor.master ?? 1;
            r.look = { ...defaultLook(), ...data.reactor.look };
            r.harmonicColor = data.reactor.harmonic ?? true;
        }
        if (data.director) {
            Object.assign(this.director.settings, data.director.settings);
            this.director.favorites = new Set(data.director.favorites || []);
        }
        if (data.decks) {
            data.decks.forEach((n, i) => {
                const p = n && this.library.find((x) => x.name === n);
                if (p) this.mixer.decks[i] = p;
            });
        }
    }
}

const app = new App();
window.fluoddity = app; // handy for console tinkering
app.boot().catch((e) => {
    console.error(e);
    const el = document.getElementById('error');
    el.textContent = `Could not start: ${e.message}`;
    el.hidden = false;
    document.getElementById('gpu-status').textContent = e.message;
});

