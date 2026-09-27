/**
 * Procedural demo track — ~126 BPM minor-key techno, synthesised with Web Audio.
 * Loops a 64-bar arrangement (intro / groove / breakdown / build / drop / outro)
 * and changes key every loop, so every MusicBrain feature gets exercised.
 */

const BPM = 126;
const BARS = 64;
// minor-key roots per loop (pitch class): A, D, F, C
const KEYS = [9, 2, 5, 0];
// i – VI – III – VII in semitones from the minor root, as triads
const PROG = [
    [0, 3, 7],
    [8, 12, 15],
    [3, 7, 10],
    [10, 14, 17],
];

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function section(bar) {
    if (bar < 8) return 'intro';
    if (bar < 24) return 'groove';
    if (bar < 32) return 'breakdown';
    if (bar < 40) return 'build';
    if (bar < 56) return 'drop';
    return 'outro';
}

export function createDemoTrack(ctx, output) {
    const stepDur = 60 / BPM / 4;

    // ── Master chain ──
    const master = ctx.createGain();
    master.gain.value = 0.75;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 8;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;
    master.connect(comp).connect(output);

    // Reverb send
    const reverb = ctx.createConvolver();
    {
        const len = Math.floor(ctx.sampleRate * 2.4);
        const ir = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let c = 0; c < 2; c++) {
            const d = ir.getChannelData(c);
            for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
        }
        reverb.buffer = ir;
    }
    const revSend = ctx.createGain();
    revSend.gain.value = 0.25;
    revSend.connect(reverb).connect(master);

    // Shared noise buffer
    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    {
        const d = noise.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }

    const noiseSrc = (t, dur) => {
        const s = ctx.createBufferSource();
        s.buffer = noise;
        s.loop = true;
        s.start(t, Math.random() * 0.5);
        s.stop(t + dur + 0.05);
        return s;
    };

    // ── Instruments ──
    function kick(t, heavy) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(heavy ? 165 : 150, t);
        o.frequency.exponentialRampToValueAtTime(heavy ? 42 : 48, t + 0.09);
        const dec = heavy ? 0.5 : 0.36;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(heavy ? 1.15 : 0.95, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
        o.connect(g).connect(master);
        o.start(t);
        o.stop(t + dec + 0.05);
        // click
        const n = noiseSrc(t, 0.02);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 2500;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.25, t);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.015);
        n.connect(hp).connect(ng).connect(master);
    }

    function hat(t, open, vol) {
        const dur = open ? 0.24 : 0.045;
        const n = noiseSrc(t, dur);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = open ? 6500 : 8000;
        const g = ctx.createGain();
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        n.connect(hp).connect(g).connect(master);
    }

    function clap(t, vol, wet = 0.6) {
        const n = noiseSrc(t, 0.25);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1400;
        bp.Q.value = 0.9;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        // three quick bursts then a tail
        for (let k = 0; k < 3; k++) {
            const tk = t + k * 0.011;
            g.gain.setValueAtTime(vol, tk);
            g.gain.exponentialRampToValueAtTime(vol * 0.25, tk + 0.009);
        }
        g.gain.setValueAtTime(vol * 0.8, t + 0.033);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
        n.connect(bp).connect(g);
        g.connect(master);
        const s = ctx.createGain();
        s.gain.value = wet;
        g.connect(s).connect(revSend);
    }

    function snare(t, vol) {
        const n = noiseSrc(t, 0.12);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 2200;
        bp.Q.value = 0.7;
        const g = ctx.createGain();
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
        n.connect(bp).connect(g).connect(master);
        const o = ctx.createOscillator();
        o.frequency.setValueAtTime(240, t);
        o.frequency.exponentialRampToValueAtTime(160, t + 0.05);
        const og = ctx.createGain();
        og.gain.setValueAtTime(vol * 0.6, t);
        og.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
        o.connect(og).connect(master);
        o.start(t);
        o.stop(t + 0.1);
    }

    function bass(t, midi, dur, heavy) {
        const f = mtof(midi);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.Q.value = heavy ? 6 : 4;
        lp.frequency.setValueAtTime(heavy ? 1400 : 700, t);
        lp.frequency.exponentialRampToValueAtTime(heavy ? 160 : 140, t + dur);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(heavy ? 0.5 : 0.42, t + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        lp.connect(g).connect(master);
        const detunes = heavy ? [-9, 9] : [0];
        for (const dt of detunes) {
            const o = ctx.createOscillator();
            o.type = 'sawtooth';
            o.frequency.value = f;
            o.detune.value = dt;
            o.connect(lp);
            o.start(t);
            o.stop(t + dur + 0.02);
        }
        if (heavy) {
            const sub = ctx.createOscillator();
            sub.frequency.value = f / 2;
            const sg = ctx.createGain();
            sg.gain.setValueAtTime(0.0001, t);
            sg.gain.exponentialRampToValueAtTime(0.45, t + 0.01);
            sg.gain.exponentialRampToValueAtTime(0.0001, t + dur);
            sub.connect(sg).connect(master);
            sub.start(t);
            sub.stop(t + dur + 0.02);
        }
    }

    function pad(t, midis, dur, cutoff, vol) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.Q.value = 2;
        lp.frequency.setValueAtTime(cutoff * 0.6, t);
        lp.frequency.linearRampToValueAtTime(cutoff, t + dur * 0.6);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(vol, t + Math.min(0.8, dur * 0.3));
        g.gain.setValueAtTime(vol, t + dur * 0.75);
        g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.4);
        lp.connect(g);
        g.connect(master);
        const s = ctx.createGain();
        s.gain.value = 0.9;
        g.connect(s).connect(revSend);
        for (const m of midis) {
            for (const d of [-7, 7]) {
                const o = ctx.createOscillator();
                o.type = 'sawtooth';
                o.frequency.value = mtof(m);
                o.detune.value = d;
                o.connect(lp);
                o.start(t);
                o.stop(t + dur + 0.5);
            }
        }
    }

    function pluck(t, midi, vol) {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = mtof(midi);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(3500, t);
        lp.frequency.exponentialRampToValueAtTime(400, t + 0.15);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        o.connect(lp).connect(g);
        g.connect(master);
        const s = ctx.createGain();
        s.gain.value = 0.7;
        g.connect(s).connect(revSend);
        o.start(t);
        o.stop(t + 0.2);
    }

    function riser(t, dur) {
        const n = noiseSrc(t, dur);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 1.2;
        bp.frequency.setValueAtTime(300, t);
        bp.frequency.exponentialRampToValueAtTime(9000, t + dur);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.35, t + dur);
        g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.05);
        n.connect(bp).connect(g).connect(master);
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(180, t);
        o.frequency.exponentialRampToValueAtTime(1800, t + dur);
        const og = ctx.createGain();
        og.gain.setValueAtTime(0.0001, t);
        og.gain.exponentialRampToValueAtTime(0.06, t + dur);
        og.gain.linearRampToValueAtTime(0.0001, t + dur + 0.05);
        const olp = ctx.createBiquadFilter();
        olp.type = 'lowpass';
        olp.frequency.value = 3000;
        o.connect(olp).connect(og).connect(master);
        o.start(t);
        o.stop(t + dur + 0.1);
    }

    function crash(t, vol) {
        const n = noiseSrc(t, 2.2);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 4000;
        const g = ctx.createGain();
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 2.1);
        n.connect(hp).connect(g);
        g.connect(master);
        g.connect(revSend);
    }

    // ── Sequencer ──
    function scheduleStep(step, t) {
        const s16 = step % 16;
        const barAbs = Math.floor(step / 16);
        const bar = barAbs % BARS;
        const loop = Math.floor(barAbs / BARS);
        const key = KEYS[loop % KEYS.length];
        const chord = PROG[bar % 4];
        const root = 36 + key; // bass octave (C2 + key)
        const sec = section(bar);
        const beat = s16 % 4 === 0;
        const offbeat = s16 % 4 === 2;

        // Kick
        if (beat && (sec === 'intro' || sec === 'groove' || sec === 'drop' || (sec === 'outro' && bar < 62))) {
            kick(t, sec === 'drop');
        }
        // Hats
        if (sec === 'intro' || sec === 'groove' || sec === 'drop' || sec === 'outro') {
            if (offbeat && sec !== 'intro') hat(t, true, sec === 'drop' ? 0.2 : 0.16);
            else hat(t, false, offbeat ? 0.2 : sec === 'drop' ? 0.1 : 0.07);
        }
        // Clap on 2 & 4
        if ((s16 === 4 || s16 === 12) && (sec === 'groove' || sec === 'drop' || sec === 'outro')) {
            clap(t, sec === 'drop' ? 0.75 : 0.6);
        }
        // Bass
        if (sec === 'groove' && offbeat) bass(t, root + chord[0], stepDur * 1.8, false);
        if (sec === 'drop' && !beat) {
            const n = s16 % 8 === 6 ? root + chord[0] + 12 : root + chord[0];
            bass(t, n, stepDur * 0.9, true);
        }
        // Pads
        if (s16 === 0 && (sec === 'breakdown' || sec === 'build' || sec === 'drop')) {
            const barDur = stepDur * 16;
            const midis = chord.map((c) => 60 + key + c - (key > 6 ? 12 : 0));
            const cutoff = sec === 'breakdown' ? 900 + (bar - 24) * 250 : sec === 'build' ? 2200 + (bar - 32) * 400 : 2600;
            pad(t, midis, barDur, cutoff, sec === 'drop' ? 0.018 : 0.03);
        }
        // Arp
        if (sec === 'breakdown' || sec === 'build') {
            const tones = [chord[0], chord[1], chord[2], chord[1] + 12];
            const m = 72 + key - (key > 6 ? 12 : 0) + tones[s16 % 4];
            pluck(t, m, sec === 'build' ? 0.05 : 0.045);
        }
        // Build: riser + accelerating snare roll
        if (sec === 'build') {
            const b = bar - 32;
            if (b === 0 && s16 === 0) riser(t, stepDur * 16 * 8);
            const vol = 0.18 + 0.5 * ((b * 16 + s16) / 128);
            if (b < 3) { if (s16 % 2 === 0) snare(t, vol); }
            else if (b < 6) snare(t, vol);
            else { snare(t, vol); snare(t + stepDur / 2, vol); }
        }
        // Crashes
        if (s16 === 0 && (bar === 40 || bar === 8)) crash(t, bar === 40 ? 0.5 : 0.3);
    }

    let nextTime = 0;
    let step = 0;
    let timer = null;
    let running = false;

    function tick() {
        if (!running) return;
        const horizon = ctx.currentTime + 0.1;
        while (nextTime < horizon) {
            // skip steps that fell behind (tab throttled) rather than bunching them
            if (nextTime < ctx.currentTime - 0.05) {
                nextTime += stepDur;
                step++;
                continue;
            }
            scheduleStep(step, nextTime);
            nextTime += stepDur;
            step++;
        }
        timer = setTimeout(tick, 25);
    }

    return {
        bpm: BPM,
        /** Schedule a whole range of steps at once (offline rendering / tests). */
        renderRange(fromStep, toStep, t0 = 0) {
            for (let i = fromStep; i < toStep; i++) scheduleStep(i, t0 + (i - fromStep) * stepDur);
        },
        start() {
            if (running) return;
            running = true;
            step = 0;
            nextTime = ctx.currentTime + 0.08;
            tick();
        },
        stop() {
            running = false;
            if (timer) clearTimeout(timer);
            timer = null;
            try { master.disconnect(); } catch { /* ignore */ }
        },
    };
}
