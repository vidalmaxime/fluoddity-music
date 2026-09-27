/**
 * AudioEngine — owns the AudioContext, the analysis worklet and the
 * currently active audio source (line-in / tab capture / files / demo).
 *
 * Graph:
 *   source ─► bus ─┬─► analysisNode ─► mute ─► destination   (analysis only)
 *                  ├─► recordDest                             (recording stream)
 *                  └─► monitor ─► destination                 (speakers, files/demo only)
 */

import { createDemoTrack } from './demo-track.js';

const REC_SIZE = 89;

export class AudioEngine {
    constructor() {
        this.ctx = null;
        this.sourceType = 'none';
        this.sourceLabel = 'No audio';
        this.onchange = null;
        this._queue = [];
        this._cleanup = null;
        this._stream = null;
        this._files = [];
        this._fileIndex = 0;
        this._objectUrl = null;
        this._audioEl = null;
        this._mediaSrc = null;
        this._demo = null;
        this._monitorWanted = true;
    }

    async init() {
        if (this.ctx) return;
        const ctx = new AudioContext({ latencyHint: 'interactive' });
        this.ctx = ctx;
        await ctx.audioWorklet.addModule(new URL('./analysis-worklet.js', import.meta.url));

        this.bus = ctx.createGain();
        this.master = this.bus; // alias
        this.analysisNode = new AudioWorkletNode(ctx, 'fluoddity-analysis', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 2,
            channelCountMode: 'explicit',
            channelInterpretation: 'speakers',
        });
        this.analysisNode.port.onmessage = (e) => {
            this._queue.push(e.data);
            // Safety valve if the page is backgrounded and nobody drains
            if (this._queue.length > 2000) this._queue.splice(0, this._queue.length - 2000);
        };
        const mute = ctx.createGain();
        mute.gain.value = 0;
        this.bus.connect(this.analysisNode);
        this.analysisNode.connect(mute).connect(ctx.destination);

        this.recordDest = ctx.createMediaStreamDestination();
        this.bus.connect(this.recordDest);

        this.monitor = ctx.createGain();
        this.monitor.gain.value = 0;
        this.bus.connect(this.monitor).connect(ctx.destination);
    }

    get sampleRate() {
        return this.ctx ? this.ctx.sampleRate : 48000;
    }

    get recordStream() {
        return this.recordDest ? this.recordDest.stream : null;
    }

    /** Toggle speaker monitoring for sources that are normally monitored (files/demo). */
    setMonitor(on) {
        this._monitorWanted = !!on;
        this._applyMonitor();
    }

    _applyMonitor() {
        if (!this.monitor) return;
        const monitored = this.sourceType === 'files' || this.sourceType === 'demo';
        const g = monitored && this._monitorWanted ? 1 : 0;
        this.monitor.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02);
    }

    drainHops() {
        const q = this._queue;
        if (q.length === 0) return EMPTY;
        const out = new Array(q.length);
        for (let i = 0; i < q.length; i++) {
            const a = q[i];
            if (a.length < REC_SIZE) continue;
            out[i] = {
                t: a[0],
                rms: a[1],
                bands: a.subarray(2, 7),
                flux: a.subarray(7, 11),
                centroid: a[11],
                flatness: a[12],
                chroma: a.subarray(13, 25),
                spectrum: a.subarray(25, 89),
            };
        }
        q.length = 0;
        return out.filter(Boolean);
    }

    async _begin() {
        await this.init();
        this.stop(false);
        if (this.ctx.state !== 'running') {
            try { await this.ctx.resume(); } catch { /* ignore */ }
        }
    }

    _set(type, label) {
        this.sourceType = type;
        this.sourceLabel = label;
        this._applyMonitor();
        this._changed();
    }

    _changed() {
        if (typeof this.onchange === 'function') {
            try { this.onchange(this); } catch (e) { console.error(e); }
        }
    }

    /** Stop and disconnect the current source. */
    stop(notify = true) {
        if (this._cleanup) {
            const fn = this._cleanup;
            this._cleanup = null;
            try { fn(); } catch (e) { console.warn(e); }
        }
        this.sourceType = 'none';
        this.sourceLabel = 'No audio';
        this._applyMonitor();
        if (notify) this._changed();
    }

    // ─────────────────────────────────────────── line-in / mic ──

    async listInputDevices() {
        if (!navigator.mediaDevices?.enumerateDevices) return [];
        const devs = await navigator.mediaDevices.enumerateDevices();
        return devs
            .filter((d) => d.kind === 'audioinput')
            .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Input ${i + 1}` }));
    }

    async useInput(deviceId) {
        await this._begin();
        const constraints = {
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: { ideal: 2 },
            },
        };
        if (deviceId) constraints.audio.deviceId = { exact: deviceId };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const src = this.ctx.createMediaStreamSource(stream);
        src.connect(this.bus);
        const track = stream.getAudioTracks()[0];
        const onEnded = () => { if (this._stream === stream) this.stop(); };
        track?.addEventListener('ended', onEnded);
        this._stream = stream;
        this._cleanup = () => {
            src.disconnect();
            stream.getTracks().forEach((t) => t.stop());
            if (this._stream === stream) this._stream = null;
        };
        this._set('input', track?.label || 'Audio input');
    }

    // ─────────────────────────────────────────── tab / system capture ──

    async useTabCapture() {
        await this._begin();
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            systemAudio: 'include',
            preferCurrentTab: false,
            selfBrowserSurface: 'exclude',
        });
        stream.getVideoTracks().forEach((t) => t.stop());
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
            stream.getTracks().forEach((t) => t.stop());
            throw new Error('No audio was shared. Pick a tab and tick "Share tab audio" (or "Share system audio") in the share dialog.');
        }
        const src = this.ctx.createMediaStreamSource(new MediaStream(audioTracks));
        src.connect(this.bus);
        const onEnded = () => { if (this._stream === stream) this.stop(); };
        audioTracks[0].addEventListener('ended', onEnded);
        this._stream = stream;
        this._cleanup = () => {
            src.disconnect();
            stream.getTracks().forEach((t) => t.stop());
            if (this._stream === stream) this._stream = null;
        };
        this._set('tab', audioTracks[0].label || 'Shared tab audio');
    }

    // ─────────────────────────────────────────── files / playlist ──

    async useFiles(files) {
        const list = Array.from(files || []).filter((f) => f && (f.type?.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac|aiff?|opus|webm)$/i.test(f.name)));
        if (list.length === 0) throw new Error('No playable audio files.');
        await this._begin();
        if (!this._audioEl) {
            const el = new Audio();
            el.preload = 'auto';
            el.crossOrigin = 'anonymous';
            this._audioEl = el;
            this._mediaSrc = this.ctx.createMediaElementSource(el);
            el.addEventListener('ended', () => {
                if (this.sourceType !== 'files') return;
                if (this._fileIndex < this._files.length - 1) this._loadTrack(this._fileIndex + 1, true);
                else { this._changed(); }
            });
            el.addEventListener('play', () => this._changed());
            el.addEventListener('pause', () => this._changed());
            el.addEventListener('loadedmetadata', () => this._changed());
        }
        this._files = list;
        this._mediaSrc.connect(this.bus);
        this._cleanup = () => {
            this._audioEl.pause();
            try { this._mediaSrc.disconnect(); } catch { /* ignore */ }
        };
        this.sourceType = 'files';
        this._applyMonitor();
        await this._loadTrack(0, true);
    }

    async _loadTrack(i, autoplay) {
        if (!this._files.length) return;
        i = Math.max(0, Math.min(this._files.length - 1, i));
        this._fileIndex = i;
        if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
        this._objectUrl = URL.createObjectURL(this._files[i]);
        this._audioEl.src = this._objectUrl;
        this.sourceLabel = this.trackName;
        this._changed();
        if (autoplay) {
            try { await this._audioEl.play(); } catch (e) { console.warn('play() failed', e); }
        }
    }

    play() { if (this.sourceType === 'files') return this._audioEl.play(); }
    pause() { if (this.sourceType === 'files') this._audioEl.pause(); }
    togglePlay() { if (this.sourceType === 'files') { if (this._audioEl.paused) this.play(); else this.pause(); } }
    next() { if (this.sourceType === 'files' && this._fileIndex < this._files.length - 1) this._loadTrack(this._fileIndex + 1, true); }
    prev() {
        if (this.sourceType !== 'files') return;
        if (this._audioEl.currentTime > 3 || this._fileIndex === 0) this._audioEl.currentTime = 0;
        else this._loadTrack(this._fileIndex - 1, true);
    }
    seek(seconds) {
        if (this.sourceType !== 'files') return;
        const d = this._audioEl.duration;
        this._audioEl.currentTime = Math.max(0, Number.isFinite(d) ? Math.min(d, seconds) : seconds);
    }
    get playing() { return this.sourceType === 'files' ? !this._audioEl.paused : this.sourceType !== 'none'; }
    get currentTime() { return this.sourceType === 'files' ? this._audioEl.currentTime : 0; }
    get duration() { return this.sourceType === 'files' && Number.isFinite(this._audioEl.duration) ? this._audioEl.duration : 0; }
    get trackName() { return this._files[this._fileIndex]?.name.replace(/\.[^.]+$/, '') ?? ''; }
    get trackIndex() { return this._fileIndex; }
    get trackCount() { return this.sourceType === 'files' ? this._files.length : 0; }

    // ─────────────────────────────────────────── demo ──

    async useDemo() {
        await this._begin();
        const out = this.ctx.createGain();
        out.connect(this.bus);
        const demo = createDemoTrack(this.ctx, out);
        demo.start();
        this._demo = demo;
        this._cleanup = () => {
            demo.stop();
            out.disconnect();
            if (this._demo === demo) this._demo = null;
        };
        this._set('demo', `Demo track · ${demo.bpm} BPM`);
    }
}

const EMPTY = Object.freeze([]);
