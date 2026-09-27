/**
 * MusicBrain — turns per-hop audio features into musical state:
 * AGC'd band levels, drum transients, a beat/bar clock, song-section
 * cues (build / breakdown / drop), timbre and harmony.
 *
 * Everything runs at the fixed analysis hop rate (sampleRate / 512),
 * so behaviour is independent of the display frame rate.
 */

const TAU = Math.PI * 2;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const dbPow = (p) => 10 * Math.log10(p + 1e-12);
const wrapHalf = (x) => x - Math.round(x); // → [-0.5, 0.5]
const smoothstep = (a, b, x) => {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
};

/** Exponential moving average with mean + variance, time constant in seconds. */
class Stat {
    constructor(tau, init = 0, initVar = 1) {
        this.tau = tau;
        this.mean = init;
        this.var = initVar;
        this.primed = false;
        this.age = 0;
    }
    update(x, dt, tau = this.tau) {
        if (!this.primed) {
            this.mean = x;
            this.primed = true;
            this.age = dt;
            return;
        }
        // bias-corrected start: behaves like a running average until `tau` has elapsed
        this.age += dt;
        const a = 1 - Math.exp(-dt / Math.min(tau, this.age));
        const d = x - this.mean;
        this.mean += a * d;
        this.var = (1 - a) * (this.var + a * d * d);
    }
    get std() {
        return Math.sqrt(Math.max(0, this.var));
    }
}

const alpha = (dt, tau) => 1 - Math.exp(-dt / tau);

const LEVEL_KEYS = ['bass', 'lowMid', 'mid', 'highMid', 'high'];

export class MusicBrain {
    constructor({ sampleRate = 48000, hop = 512 } = {}) {
        this.dt = hop / sampleRate;
        this.hopRate = sampleRate / hop;
        this.sensitivity = 1;
        this.latencyComp = 0.02; // seconds: beats fire this much early

        this.state = {
            levels: { bass: 0, lowMid: 0, mid: 0, highMid: 0, high: 0, loudness: 0 },
            kick: 0, snare: 0, hat: 0,
            beatPulse: 0, barPulse: 0,
            bpm: 120, bpmConfidence: 0, phaseConfidence: 0,
            beatPhase: 0, beatCount: 0, beatInBar: 0, barPhase: 0, barCount: 0, phrasePhase: 0,
            manual: false,
            intensity: 0.5, build: 0, dropEnv: 0, calm: 0,
            brightness: 0.5, flatness: 0,
            chroma: new Float32Array(12), keyHue: 0, tonalClarity: 0,
            spectrum: new Float32Array(64),
            silent: true,
        };
        this.events = [];

        // ── Levels / AGC ──
        this.bandStats = LEVEL_KEYS.map(() => new Stat(7, -60, 36));
        this.loudStat = new Stat(7, -40, 36);
        this.levelSmooth = new Float32Array(6);

        // ── Onsets ──
        // flux index: 1 low → kick, 2 mid → snare, 3 high → hat
        this.onset = [
            { key: 'kick', flux: 1, stat: new Stat(1.2, 0, 0), prev: 0, prev2: 0, last: -1e9, refr: 0.11, decay: 0.18, k: 1.4 },
            { key: 'snare', flux: 2, stat: new Stat(1.2, 0, 0), prev: 0, prev2: 0, last: -1e9, refr: 0.1, decay: 0.22, k: 1.6 },
            { key: 'hat', flux: 3, stat: new Stat(0.8, 0, 0), prev: 0, prev2: 0, last: -1e9, refr: 0.055, decay: 0.09, k: 1.5 },
        ];
        this.time = 0; // brain time in seconds (hop count * dt)

        // ── Tempo ──
        this.envLen = Math.ceil(8 * this.hopRate);
        this.env = new Float32Array(this.envLen); // raw onset envelope ring
        this.envPos = 0;
        this.envFill = 0;
        this.envLin = new Float32Array(this.envLen);
        this.fluxMean = new Float32Array([1e-3, 1e-3, 1e-3, 1e-3]);
        this.envDet = new Float32Array(this.envLen);
        this.maxLag = Math.ceil((this.hopRate * 60) / 70) * 4 + 4;
        this.ac = new Float32Array(this.maxLag + 2);
        this.sinceTempo = 0;
        this.tempoInterval = 0.5;
        this.bpm = 0; // 0 = unknown
        this.candBpm = 0;
        this.candSince = 0;

        // Beat clock (in beats)
        this.clockBeats = 0;
        this.periodHops = (this.hopRate * 60) / 120;
        this.lastFiredBeat = 0;
        this.pendingCorr = 0;
        this.manual = false;
        this.taps = [];

        // Downbeat
        this.slots = new Float32Array(4);
        this.barOffset = 0;
        this.lastRotateBar = -100;
        this.manualDownbeatUntilBar = -1;
        this.phraseOffset = 0; // bar index (mod 8) where phrases start; re-anchored on drops / resync
        this.lowAccSlots = new Float32Array(4); // low-band flux near each beat (by beat mod 4)
        this.fastChroma = new Float32Array(12);
        this.prevChordSnap = new Float32Array(12);
        this.snapDone = -1; // last beat whose chord snapshot was taken
        this.emaBeatLow = 1e-3;
        this.emaBeatNov = 0.05;
        this.activeTime = 0; // seconds of non-silent audio (warm-up gating)

        // ── Sections ──
        // Section tracking averages POWER (not dB) so sparse hits vs dense rolls don't skew levels.
        this.pLoudS = new Stat(0.5, 1e-4);
        this.pLoudM = new Stat(3, 1e-4);
        this.pLoudL = new Stat(20, 1e-4);
        this.pBassS = new Stat(0.35, 1e-5);
        this.pBassM = new Stat(3, 1e-5);
        this.pBassL = new Stat(30, 1e-5);
        this.pBassC = new Stat(1.5, 1e-5); // faster mid-term bass for breakdown detection
        this.pTotS = new Stat(0.35, 1e-4);
        this.pTotM = new Stat(3, 1e-4);
        this.pHiM = new Stat(3, 1e-6);
        this.flatMid = new Stat(3, 0.1);
        this.snareAcc = 0;
        this.lastKickT = -1e9;
        // mid-term feature history sampled every 0.25 s (8 s) for slopes
        this.HIST = 32;
        this.histLoud = new Float32Array(this.HIST);
        this.histFlat = new Float32Array(this.HIST);
        this.histHr = new Float32Array(this.HIST);
        this.histPos = 0;
        this.histFill = 0;
        this.histTimer = 0;
        this.lowTime = 0;
        this.dropCooldown = 0;
        this.buildArmed = true;
        this.calmArmed = true;

        // ── Timbre / harmony / spectrum ──
        this.keyU = 0;
        this.specMax = -40;
        this.chromaTmp = new Float32Array(12);
    }

    setSensitivity(x) {
        this.sensitivity = clamp(x, 0.5, 2);
    }

    get beatSec() {
        return this.periodHops * this.dt;
    }

    // ───────────────────────────────── public controls ──

    tap() {
        const now = performance.now() / 1000;
        const taps = this.taps;
        if (taps.length && now - taps[taps.length - 1] > 2) taps.length = 0;
        taps.push(now);
        if (taps.length > 12) taps.shift();
        if (taps.length >= 4) {
            const iv = [];
            for (let i = 1; i < taps.length; i++) iv.push(taps[i] - taps[i - 1]);
            iv.sort((a, b) => a - b);
            const med = iv[Math.floor(iv.length / 2)];
            const bpm = clamp(60 / med, 40, 240);
            this.manual = true;
            this.bpm = bpm;
            this.periodHops = (this.hopRate * 60) / bpm;
            this.state.bpmConfidence = 1;
        }
        if (this.manual) {
            // The tap is a beat: snap the clock's fractional phase to 0.
            this.pendingCorr = 0;
            this.clockBeats = Math.round(this.clockBeats);
        }
    }

    clearManual() {
        this.manual = false;
        this.taps.length = 0;
    }

    nudge(ms) {
        this.clockBeats += ms / 1000 / Math.max(1e-3, this.beatSec);
    }

    resyncDownbeat() {
        this.barOffset = ((this.lastFiredBeat % 4) + 4) % 4;
        const bar = Math.floor((this.lastFiredBeat - this.barOffset) / 4);
        this.manualDownbeatUntilBar = bar + 32;
        this.phraseOffset = ((bar % 8) + 8) % 8;
        this.state.beatInBar = 0;
        this.state.barCount = bar;
        this.slots.fill(0);
    }

    // ───────────────────────────────── main update ──

    update(hops) {
        this.events.length = 0;
        for (let i = 0; i < hops.length; i++) this._hop(hops[i]);
    }

    _emit(type, strength = 1) {
        this.events.push({ type, strength });
    }

    _hop(h) {
        const dt = this.dt;
        const s = this.state;
        this.time += dt;

        const rmsDb = 20 * Math.log10(h.rms + 1e-9);
        const silent = rmsDb < -65;
        s.silent = silent;

        let totalPow = 0;
        for (let b = 0; b < 5; b++) totalPow += h.bands[b];
        const totalDb = dbPow(totalPow);

        // ── Levels (AGC) ──
        const aAtk = alpha(dt, 0.01);
        const aRel = alpha(dt, 0.12);
        for (let b = 0; b < 6; b++) {
            let target = 0;
            if (!silent) {
                let db, st;
                if (b < 5) {
                    // Floor each band relative to the whole mix so a missing band can't be AGC'd into noise.
                    db = Math.max(dbPow(h.bands[b]), totalDb - 45);
                    st = this.bandStats[b];
                    const gated = dbPow(h.bands[b]) < totalDb - 40;
                    // asymmetric: adapt up faster than down so breakdowns stay "quiet"
                    st.update(db, dt, db > st.mean ? 5 : 14);
                    const z = (db - st.mean) / Math.max(3, st.std);
                    target = gated ? 0 : sigmoid(1.5 * (z - 0.1));
                } else {
                    db = rmsDb;
                    st = this.loudStat;
                    st.update(db, dt, db > st.mean ? 5 : 14);
                    const z = (db - st.mean) / Math.max(3, st.std);
                    target = sigmoid(1.5 * (z - 0.1));
                }
            }
            const cur = this.levelSmooth[b];
            this.levelSmooth[b] = cur + (target > cur ? aAtk : aRel) * (target - cur);
        }
        for (let b = 0; b < 5; b++) s.levels[LEVEL_KEYS[b]] = this.levelSmooth[b];
        s.levels.loudness = this.levelSmooth[5];

        // ── Onsets / transients ──
        for (const o of this.onset) {
            const x = h.flux[o.flux];
            const env = s[o.key];
            s[o.key] = env * Math.exp((-dt * 2) / o.decay);
            // Peak pick one hop late: prev is a local max above threshold
            const st = o.stat;
            const thr = st.mean + (o.k / this.sensitivity) * Math.max(st.std, st.mean * 0.3 + 1e-4);
            if (
                !silent && st.primed &&
                o.prev > thr && o.prev >= x && o.prev > o.prev2 &&
                this.time - o.last > o.refr
            ) {
                const strength = 0.35 + 0.65 * clamp01((o.prev - thr) / (3 * Math.max(st.std, 1e-4)));
                o.last = this.time;
                s[o.key] = Math.max(s[o.key], strength);
                this._emit(o.key, strength);
                if (o.key === 'snare') this.snareAcc += 1;
                if (o.key === 'kick') this.lastKickT = this.time;
            }
            if (!silent) st.update(x, dt);
            o.prev2 = o.prev;
            o.prev = x;
        }
        // snare onset rate (events/s ≈ acc / tau) as a leaky integrator
        this.snareAcc *= Math.exp(-dt / 2);

        // ── Tempo envelope ──
        // Each band normalised by its own running mean so dense hi-hats can't drown the kick pulse.
        let envVal = 0;
        if (!silent) {
            const fm = this.fluxMean;
            const a3 = alpha(dt, 3);
            for (let i = 1; i < 4; i++) fm[i] += a3 * (h.flux[i] - fm[i]);
            envVal = 1.5 * h.flux[1] / (fm[1] + 1e-6) + h.flux[2] / (fm[2] + 1e-6) + 0.6 * h.flux[3] / (fm[3] + 1e-6);
        }
        this.env[this.envPos] = envVal;
        this.envPos = (this.envPos + 1) % this.envLen;
        if (this.envFill < this.envLen) this.envFill++;
        // downbeat evidence: attribute low-band flux to the nearest beat
        {
            const frac0 = this.clockBeats - Math.floor(this.clockBeats);
            if (frac0 < 0.2 || frac0 > 0.85) {
                const nb = Math.round(this.clockBeats);
                this.lowAccSlots[((nb % 4) + 4) % 4] += silent ? 0 : h.flux[1];
            }
            // chord of each beat = chroma averaged over the beat body (skipping the transient head)
            if (!silent && frac0 >= 0.2) {
                let cs = 0;
                for (let i = 0; i < 12; i++) cs += h.chroma[i];
                if (cs > 1e-10) for (let i = 0; i < 12; i++) this.fastChroma[i] += h.chroma[i] / cs;
            }
            // finalise the previous beat's evidence early in the next beat
            if (frac0 >= 0.2 && this.snapDone !== this.lastFiredBeat) {
                this.snapDone = this.lastFiredBeat;
                this._downbeatEvidence(this.lastFiredBeat - 1);
            }
        }
        if (!silent) this.activeTime += dt;

        this.sinceTempo += dt;
        if (this.sinceTempo >= this.tempoInterval) {
            this.sinceTempo = 0;
            if (!this.manual && this.envFill >= this.hopRate * 3) this._estimateTempo();
        }
        if (silent) s.bpmConfidence *= Math.exp(-dt / 4);

        // ── Beat clock ──
        if (this.pendingCorr !== 0) {
            // spread corrections (≤ ~0.2 beat/s) so the beat clock never visibly lurches
            const step = Math.sign(this.pendingCorr) * Math.min(Math.abs(this.pendingCorr), 0.002);
            this.clockBeats += step;
            this.pendingCorr -= step;
        }
        this.clockBeats += 1 / this.periodHops;
        const beatFloor = Math.floor(this.clockBeats);
        if (beatFloor > this.lastFiredBeat) {
            this.lastFiredBeat = beatFloor;
            this._onBeat(beatFloor);
        }
        const frac = this.clockBeats - Math.floor(this.clockBeats);
        s.beatPhase = frac;
        s.beatCount = this.lastFiredBeat;
        s.bpm = (this.hopRate * 60) / this.periodHops;
        s.manual = this.manual;
        const rel = this.lastFiredBeat - this.barOffset;
        s.beatInBar = ((rel % 4) + 4) % 4;
        s.barCount = Math.floor(rel / 4);
        s.barPhase = (s.beatInBar + frac) / 4;
        s.phrasePhase = ((((s.barCount - this.phraseOffset) % 8) + 8) % 8 + s.barPhase) / 8;
        const p = 1 - Math.min(1, frac * 4);
        s.beatPulse = p * p;
        s.barPulse = s.beatInBar === 0 ? s.beatPulse : 0;

        // ── Sections ──
        this._sections(h, rmsDb, totalDb, silent);

        // ── Timbre ──
        if (!silent) {
            const c = Math.max(1, h.centroid);
            const bT = clamp01((Math.log(c) - Math.log(300)) / (Math.log(6000) - Math.log(300)));
            s.brightness += alpha(dt, 0.3) * (bT - s.brightness);
            s.flatness += alpha(dt, 0.3) * (clamp01(h.flatness) - s.flatness);
        }

        // ── Harmony ──
        if (!silent) this._harmony(h);

        // ── Spectrum display ──
        this._spectrum(h);
    }

    _onBeat(beat) {
        const s = this.state;
        const conf = s.bpmConfidence;
        this._emit('beat', 0.5 + 0.5 * conf);

        const rel = beat - this.barOffset;
        const bar = Math.floor(rel / 4);
        if (bar > this.manualDownbeatUntilBar && bar - this.lastRotateBar >= 8) {
            let best = 0;
            for (let i = 1; i < 4; i++) if (this.slots[i] > this.slots[best]) best = i;
            if (best !== this.barOffset && this.slots[best] > 1.3 * this.slots[this.barOffset] + 1e-6) {
                this.barOffset = best;
                this.lastRotateBar = bar;
            }
        }
        const rel2 = beat - this.barOffset;
        if (((rel2 % 4) + 4) % 4 === 0) {
            this._emit('bar', 1);
            const bar2 = Math.floor(rel2 / 4);
            if ((((bar2 - this.phraseOffset) % 8) + 8) % 8 === 0) this._emit('phrase', 1);
        }
    }

    _downbeatEvidence(beat) {
        const slot = ((beat % 4) + 4) % 4;
        const low = this.lowAccSlots[slot];
        this.lowAccSlots[slot] = 0;
        // fastChroma holds the summed chroma of the beat that just ended (beat)
        let cs = 0;
        for (let i = 0; i < 12; i++) cs += this.fastChroma[i];
        let nov = 0;
        if (cs > 1e-9) {
            for (let i = 0; i < 12; i++) {
                const v = this.fastChroma[i] / cs;
                nov += Math.abs(v - this.prevChordSnap[i]);
                this.prevChordSnap[i] = v;
            }
        }
        this.fastChroma.fill(0);
        this.emaBeatLow += 0.05 * (low - this.emaBeatLow);
        this.emaBeatNov += 0.05 * (nov - this.emaBeatNov);
        if (this.state.silent) return;
        for (let i = 0; i < 4; i++) this.slots[i] *= 0.985;
        this.slots[slot] += 0.5 * low / (this.emaBeatLow + 1e-6) + 1.5 * nov / (this.emaBeatNov + 1e-6);
    }

    // ───────────────────────────────── tempo estimation ──

    _estimateTempo() {
        const L = this.envFill;
        const lin = this.envLin;
        const det = this.envDet;
        // unroll ring, oldest first
        let p = (this.envPos - L + this.envLen) % this.envLen;
        for (let i = 0; i < L; i++) {
            lin[i] = this.env[p];
            p = (p + 1) % this.envLen;
        }
        // detrend with a centred moving average (~0.25 s) and half-wave rectify
        const w = Math.max(2, Math.round(this.hopRate * 0.125));
        // prefix sums for speed
        const pre = this._pre || (this._pre = new Float64Array(this.envLen + 1));
        pre[0] = 0;
        for (let i = 0; i < L; i++) pre[i + 1] = pre[i] + lin[i];
        let energy = 0;
        for (let i = 0; i < L; i++) {
            const a = Math.max(0, i - w), b = Math.min(L, i + w + 1);
            const m = (pre[b] - pre[a]) / (b - a);
            const v = lin[i] - m;
            det[i] = v > 0 ? v : 0;
            energy += det[i] * det[i];
        }
        if (energy < 1e-10) return;
        // light [1 2 1] smoothing widens onset peaks (robust to hop quantisation),
        // then remove the DC of the rectified envelope so noise doesn't look periodic
        let prevV = det[0], dm = 0;
        for (let i = 0; i < L; i++) {
            const cur = det[i];
            const nxt = i + 1 < L ? det[i + 1] : cur;
            det[i] = 0.25 * prevV + 0.5 * cur + 0.25 * nxt;
            prevV = cur;
            dm += det[i];
        }
        dm /= L;
        for (let i = 0; i < L; i++) det[i] -= dm;

        // autocorrelation
        const ac = this.ac;
        const maxLag = Math.min(this.maxLag, L - 2);
        for (let lag = 0; lag <= maxLag; lag++) {
            let sum = 0;
            for (let i = lag; i < L; i++) sum += det[i] * det[i - lag];
            ac[lag] = sum / (L - lag);
        }
        const ac0 = ac[0] || 1e-12;
        const acAt = (x) => {
            if (x < 0 || x >= maxLag) return 0;
            const i = Math.floor(x), f = x - i;
            return ac[i] * (1 - f) + ac[i + 1] * f;
        };

        const lagMin = Math.floor((this.hopRate * 60) / 180);
        const lagMax = Math.ceil((this.hopRate * 60) / 70);
        // coarse search with harmonic support + prior
        let bestLag = -1, bestScore = -Infinity;
        const score = (lag) => {
            const bpm = (this.hopRate * 60) / lag;
            const oct = Math.log2(bpm / 124);
            const prior = Math.exp(-0.5 * (oct / 0.7) ** 2);
            // harmonic support; the lag/2 term favours binary subdivision so "1.5-beat"
            // lags (which only line up with an 8th-note grid) lose to the real beat.
            return prior * (acAt(lag) + 0.5 * acAt(lag / 2) + 0.5 * acAt(2 * lag) + 0.4 * acAt(3 * lag) + 0.25 * acAt(4 * lag));
        };
        // fractional lags: onset peaks are sharp, so harmonics of an integer lag would miss them
        for (let lag = lagMin; lag <= lagMax; lag += 0.25) {
            const sc = score(lag);
            if (sc > bestScore) { bestScore = sc; bestLag = lag; }
        }
        if (bestLag < 0) return;

        // refine: parabolic peak position at each multiple k*lag → period estimates,
        // weighted toward longer lags (more precise) and stronger peaks.
        let bestP = bestLag;
        {
            let wSum = 0, pSum = 0, P = bestLag;
            for (let k = 1; k * P + 3 < maxLag; k++) {
                const c = Math.round(k * P);
                let m = c;
                for (let j = c - 2; j <= c + 2; j++) if (j > 0 && ac[j] > ac[m]) m = j;
                // only trust genuine local peaks close to the expected multiple
                if (!(ac[m] >= ac[m - 1] && ac[m] >= ac[m + 1]) || Math.abs(m - k * P) > 1.5) continue;
                const y0 = ac[m - 1], y1 = ac[m], y2 = ac[m + 1];
                const den = y0 - 2 * y1 + y2;
                const off = den < 0 ? clamp((0.5 * (y0 - y2)) / den, -0.5, 0.5) : 0;
                if (y1 <= 0) continue;
                const pk = (m + off) / k;
                const w = y1 * k;
                pSum += pk * w;
                wSum += w;
                P = pSum / wSum; // progressively refined guess for the next multiple
            }
            if (wSum > 0) bestP = pSum / wSum;
        }

        let bpm = (this.hopRate * 60) / bestP;
        // octave correction toward ~85..178 (keeps 174 DnB at full time)
        if (bpm < 85 && acAt(bestP / 2) > 0.5 * acAt(bestP)) { bpm *= 2; bestP /= 2; }
        else if (bpm > 178 && acAt(bestP * 2) > 0.5 * acAt(bestP)) { bpm /= 2; bestP *= 2; }

        const ratio = acAt(bestP) / ac0;
        const conf = clamp01((ratio - 0.08) / 0.4);
        const s = this.state;
        s.bpmConfidence += 0.35 * (conf - s.bpmConfidence);
        if (conf < 0.2) return; // free-run

        // hysteresis
        if (this.bpm === 0) {
            this.bpm = bpm;
        } else if (Math.abs(bpm - this.bpm) / this.bpm < 0.02) {
            this.bpm += 0.3 * (bpm - this.bpm);
            this.candBpm = 0;
        } else {
            if (this.candBpm && Math.abs(bpm - this.candBpm) / this.candBpm < 0.02) {
                this.candSince += this.tempoInterval;
            } else {
                this.candBpm = bpm;
                this.candSince = 0;
            }
            const curScore = score((this.hopRate * 60) / this.bpm);
            // metrical-level changes (×2, ×1.5 …) are usually ambiguity, not a new song: be stubborn
            const r = bpm / this.bpm;
            const metrical = [2, 0.5, 1.5, 2 / 3, 4 / 3, 0.75, 3, 1 / 3].some((m) => Math.abs(r / m - 1) < 0.03);
            const ok = metrical
                ? this.candSince >= 8 && bestScore > 1.25 * curScore
                : this.candSince >= 2 || bestScore > 1.6 * curScore;
            if (ok) {
                this.bpm = bpm;
                this.candBpm = 0;
            }
        }
        const targetPeriod = (this.hopRate * 60) / this.bpm;
        this.periodHops += 0.5 * (targetPeriod - this.periodHops);

        // phase: comb template over recent envelope
        const P = this.periodHops;
        let bestPhi = 0, bestPhiScore = -Infinity;
        const phiScores = this._phiScores || (this._phiScores = new Float32Array(1024));
        let phiN = 0;
        const last = L - 1;
        const detAt = (x) => {
            if (x < 0) return 0;
            const i = Math.floor(x), f = x - i;
            if (i + 1 >= L) return det[i] || 0;
            return det[i] * (1 - f) + det[i + 1] * f;
        };
        for (let phi = 0; phi < P; phi += 0.5) {
            let sc = 0, wgt = 1;
            for (let k = 0; last - phi - k * P >= 0; k++) {
                const x = last - phi - k * P;
                // small window tolerance
                sc += wgt * Math.max(detAt(x), 0.6 * detAt(x - 1), 0.6 * detAt(x + 1));
                wgt *= 0.9;
            }
            if (sc > bestPhiScore) { bestPhiScore = sc; bestPhi = phi; }
            if (phiN < phiScores.length) phiScores[phiN++] = sc;
        }
        // Phase is ambiguous when another offset ≥ 0.2 beat away scores almost as well
        // (e.g. straight 16th rolls): then keep free-running instead of chasing noise.
        let second = 0;
        for (let i = 0; i < phiN; i++) {
            const d = Math.abs(wrapHalf((i * 0.5 - bestPhi) / P));
            if (d >= 0.2 && phiScores[i] > second) second = phiScores[i];
        }
        const phaseConf = bestPhiScore > 1e-9 ? clamp01((1 - second / bestPhiScore) / 0.3) : 0;
        this.state.phaseConfidence = phaseConf;
        if (phaseConf < 0.35) return;
        // measured fractional phase = hops since last beat / P
        // +0.5 hop: a transient lands somewhere inside its hop (on average half a hop earlier);
        // latencyComp lets the host fire beats early to hide render/display latency.
        const measured = (bestPhi + 0.5 + this.latencyComp / this.dt) / P;
        const cur = this.clockBeats - Math.floor(this.clockBeats);
        const err = wrapHalf(measured - cur);
        const gain = (0.15 + 0.35 * conf) * phaseConf;
        this.pendingCorr = clamp(err * gain, -0.15, 0.15);
    }

    // ───────────────────────────────── sections ──

    _sections(h, rmsDb, totalDb, silent) {
        const s = this.state;
        const dt = this.dt;
        const beatSec = this.beatSec;

        s.dropEnv *= Math.exp(-dt / ((2 * 4 * beatSec) / 3));
        if (this.dropCooldown > 0) this.dropCooldown -= dt;

        if (silent) {
            s.build *= Math.exp(-dt / 0.6);
            return;
        }
        let totP = 0;
        for (let i = 0; i < 5; i++) totP += h.bands[i];
        this.pLoudS.update(h.rms * h.rms, dt);
        this.pLoudM.update(h.rms * h.rms, dt);
        this.pLoudL.update(h.rms * h.rms, dt);
        this.pBassS.update(h.bands[0], dt);
        this.pBassM.update(h.bands[0], dt);
        this.pBassL.update(h.bands[0], dt);
        this.pBassC.update(h.bands[0], dt);
        this.pTotS.update(totP, dt);
        this.pTotM.update(totP, dt);
        this.pHiM.update(h.bands[3] + h.bands[4], dt);
        this.flatMid.update(h.flatness, dt);

        const loudS = dbPow(this.pLoudS.mean), loudM = dbPow(this.pLoudM.mean), loudL = dbPow(this.pLoudL.mean);
        const bassS = dbPow(this.pBassS.mean), bassM = dbPow(this.pBassM.mean), bassL = dbPow(this.pBassL.mean);
        const brS = bassS - dbPow(this.pTotS.mean); // bass share of the mix
        const brM = bassM - dbPow(this.pTotM.mean);
        const hrM = dbPow(this.pHiM.mean) - dbPow(this.pTotM.mean);
        const warm = smoothstep(4, 8, this.activeTime);

        // intensity: short vs long loudness
        s.intensity += alpha(dt, 0.2) * (sigmoid((loudS - loudL) / 3) - s.intensity);

        // calm (breakdown-ness): mid-term bass well below its long-term level
        const calmT = smoothstep(3, 12, bassL - dbPow(this.pBassC.mean)) * warm;
        s.calm += alpha(dt, calmT > s.calm ? 0.8 : 0.4) * (calmT - s.calm);

        // build: sustained rises over the last ~6 s (both halves must rise, so a
        // single step — e.g. a new instrument entering — doesn't count), plus snare-roll density.
        this.histTimer += dt;
        if (this.histTimer >= 0.25) {
            this.histTimer = 0;
            this.histLoud[this.histPos] = loudM;
            this.histFlat[this.histPos] = this.flatMid.mean;
            this.histHr[this.histPos] = hrM;
            this.histPos = (this.histPos + 1) % this.HIST;
            if (this.histFill < this.HIST) this.histFill++;
        }
        let a = 0, b = 0;
        const W = 24, Hh = 12; // 6 s window, 3 s halves
        if (this.histFill > W) {
            const n = this.HIST;
            const at = (back) => (this.histPos - 1 - back + 2 * n) % n;
            const rise = (arr) => Math.min(arr[at(0)] - arr[at(Hh)], arr[at(Hh)] - arr[at(W)]) / (Hh * 0.25);
            a = smoothstep(0.1, 0.6, rise(this.histLoud));
            b = Math.max(smoothstep(0.002, 0.012, rise(this.histFlat)), smoothstep(0.1, 0.6, rise(this.histHr)));
        }
        const snareRate = this.snareAcc / 2;
        const c = smoothstep(4, 7.5, snareRate);
        // snare density only counts much when the low end has dropped out (dense grooves are full of mid transients)
        const buildT = clamp01(0.4 * a + 0.45 * b + 0.5 * c * (0.25 + 0.75 * s.calm) + 0.15 * s.calm) * (1 - 0.7 * s.dropEnv) * warm;
        s.build += alpha(dt, buildT > s.build ? 1.2 : 0.8) * (buildT - s.build);

        if (s.build > 0.6 && this.buildArmed) { this.buildArmed = false; this._emit('build', s.build); }
        else if (s.build < 0.4) this.buildArmed = true;
        if (s.calm > 0.6 && this.calmArmed) { this.calmArmed = false; this._emit('breakdown', s.calm); }
        else if (s.calm < 0.4) this.calmArmed = true;

        // drop detection
        if (s.calm > 0.5 || s.build > 0.5) this.lowTime += dt;
        else this.lowTime = Math.max(0, this.lowTime - dt * 0.5);
        // bass-share jump rejects snare rolls / risers that only make everything louder
        const jump = (brS - brM) + 0.5 * (bassS - bassM);
        if (
            this.dropCooldown <= 0 &&
            this.lowTime >= 2 * 4 * beatSec &&
            jump > 7 &&
            bassS > bassL - 3 &&
            this.time - this.lastKickT < 0.15
        ) {
            const strength = clamp01(0.5 + (jump - 7) / 12);
            s.dropEnv = 1;
            s.build *= 0.3;
            this.lowTime = 0;
            this.dropCooldown = 8 * 4 * beatSec;
            // drops start phrases: anchor the 8-bar phrase grid to this bar
            const beatsIn = Math.round(this.clockBeats) - this.barOffset;
            this.phraseOffset = ((Math.floor(beatsIn / 4) % 8) + 8) % 8;
            this._emit('drop', strength);
        }
    }

    // ───────────────────────────────── harmony ──

    _harmony(h) {
        const s = this.state;
        const dt = this.dt;
        let sum = 0;
        for (let i = 0; i < 12; i++) sum += h.chroma[i];
        if (sum < 1e-10) return;
        const a = alpha(dt, 1.5);
        let max = 0, tot = 0, vx = 0, vy = 0;
        for (let i = 0; i < 12; i++) {
            const v = s.chroma[i] + a * (h.chroma[i] / sum - s.chroma[i]);
            s.chroma[i] = v;
            if (v > max) max = v;
            tot += v;
            const ang = (((i * 7) % 12) / 12) * TAU;
            vx += v * Math.cos(ang);
            vy += v * Math.sin(ang);
        }
        const mean = tot / 12;
        const clarity = clamp01(((max - mean) / (max + 1e-9)) * 1.25);
        s.tonalClarity += alpha(dt, 0.5) * (clarity - s.tonalClarity);
        // circular mean on the circle of fifths ≈ key centre
        if (vx * vx + vy * vy > 1e-12) {
            let target = Math.atan2(vy, vx) / TAU;
            target -= Math.floor(target);
            const cur = this.keyU - Math.floor(this.keyU);
            const d = wrapHalf(target - cur);
            this.keyU += d * alpha(dt, 1.0) * (0.3 + 0.7 * s.tonalClarity);
            s.keyHue = this.keyU - Math.floor(this.keyU);
        }
    }

    // ───────────────────────────────── spectrum ──

    _spectrum(h) {
        const s = this.state;
        const dt = this.dt;
        const sp = h.spectrum;
        const n = sp.length;
        let frameMax = -100;
        for (let i = 0; i < n; i++) {
            // +3 dB/octave tilt relative to ~1 kHz so highs are visible
            const oct = Math.log2((30 * Math.pow(16000 / 30, (i + 0.5) / n)) / 1000);
            const v = sp[i] + 3 * oct;
            if (v > frameMax) frameMax = v;
        }
        if (frameMax > this.specMax) this.specMax = frameMax;
        else this.specMax += alpha(dt, 3) * (frameMax - this.specMax);
        const top = Math.max(this.specMax, -70);
        const floor = top - 60;
        const aRel = alpha(dt, 0.15);
        for (let i = 0; i < n; i++) {
            const oct = Math.log2((30 * Math.pow(16000 / 30, (i + 0.5) / n)) / 1000);
            const v = s.silent ? 0 : clamp01((sp[i] + 3 * oct - floor) / 60);
            const cur = s.spectrum[i];
            s.spectrum[i] = v > cur ? cur + 0.6 * (v - cur) : cur + aRel * (v - cur);
        }
    }
}
