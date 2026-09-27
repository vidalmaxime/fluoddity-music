// The Reactor: a modulation matrix from musical features to physics & FX.
//
// Every target has a base value and one modulation slot {source, depth}.
// Physics targets take their base from the live preset blend; FX/visual
// targets have a user base. Event targets (ripple/ink) fire on the source's
// transient instead of following it continuously.

export const SOURCES = [
    ['none', '—'],
    ['kick', 'Kick'], ['snare', 'Snare / clap'], ['hat', 'Hats'],
    ['bass', 'Bass'], ['lowMid', 'Low-mid'], ['mid', 'Mid'], ['highMid', 'High-mid'], ['high', 'Air'],
    ['loudness', 'Loudness'], ['intensity', 'Intensity'],
    ['beat', 'Beat pulse'], ['bar', 'Bar pulse'], ['lfoBeat', 'LFO ¼ note'], ['lfoBar', 'LFO 1 bar'],
    ['build', 'Build-up'], ['drop', 'Drop'], ['calm', 'Breakdown'],
    ['brightness', 'Brightness'], ['flatness', 'Noisiness'],
];

// Section sources are 0 when nothing is happening, so they are never centred.
const UNCENTERED = new Set(['build', 'drop', 'calm']);

const EVENT_OF = { kick: 'kick', snare: 'snare', hat: 'hat', beat: 'beat', bar: 'bar', drop: 'drop', build: 'build', calm: 'breakdown' };

// mode: how depth*source combines with base.
//   mul:     base * (1 + depth*src*span)
//   add:     base + depth*src*span
//   persist: trail half-life scaled by 2^(depth*src*span)
//   event:   triggered on the source's transient
export const TARGETS = [
    { id: 'forceMult', label: 'Force', group: 'physics', mode: 'mul', span: 1.5, tip: 'Global force multiplier — how hard particles steer' },
    { id: 'speed', label: 'Time', group: 'physics', mode: 'mul', span: 1, min: 0.1, max: 2.5, tip: 'Simulation speed (physics steps per second)' },
    { id: 'sensorGain', label: 'Sensitivity', group: 'physics', mode: 'mul', span: 1, tip: 'How strongly particles react to trails' },
    { id: 'sensorAngle', label: 'Sensor angle', group: 'physics', mode: 'add', span: 0.3, tip: 'Angle between the left/right sensors' },
    { id: 'sensorDist', label: 'Sensor reach', group: 'physics', mode: 'mul', span: 1, tip: 'How far ahead particles sense' },
    { id: 'drag', label: 'Glide', group: 'physics', mode: 'add', span: 0.3, min: -0.98, max: 0.98, tip: 'Velocity retained per step (momentum)' },
    { id: 'strafe', label: 'Strafe', group: 'physics', mode: 'mul', span: 2, tip: 'Sideways hops independent of heading' },
    { id: 'axial', label: 'Thrust', group: 'physics', mode: 'mul', span: 1, tip: 'Forward/back component of the rule output' },
    { id: 'lateral', label: 'Turn', group: 'physics', mode: 'mul', span: 1.2, tip: 'Left/right component — negative flips handedness' },
    { id: 'persist', label: 'Trail memory', group: 'physics', mode: 'persist', span: 2.5, tip: 'How long trails last' },
    { id: 'diffusion', label: 'Trail blur', group: 'physics', mode: 'add', span: 0.6, min: 0, max: 1, tip: 'Trail diffusion' },
    { id: 'mutation', label: 'Diversity', group: 'physics', mode: 'add', span: 0.25, tip: 'Per-cohort mutation — how different the tribes behave' },

    { id: 'ripple', label: 'Shockwave', group: 'forces', mode: 'event', base: 0, tip: 'Expanding refraction ring across the image' },
    { id: 'ink', label: 'Shock ink', group: 'forces', mode: 'event', base: 0, tip: 'Ring written into the trail field — particles react through their own rule' },
    { id: 'swirl', label: 'Swirl', group: 'forces', mode: 'add', base: 0, span: 1, bipolar: true, tip: 'Vortex around the centre (flips direction each bar)' },
    { id: 'breathe', label: 'Breathe', group: 'forces', mode: 'add', base: 0, span: 1, bipolar: true, centered: true, tip: 'Radial in/out push that follows the source (centred, so no net drift)' },
    { id: 'jitter', label: 'Shimmer', group: 'forces', mode: 'add', base: 0, span: 1, tip: 'Sideways jitter' },
    { id: 'specInk', label: 'Spectrum ink', group: 'forces', mode: 'add', base: 0, span: 1, tip: 'The live spectrum drawn as a ring of flow' },
    { id: 'orbiters', label: 'Orbiters', group: 'forces', mode: 'add', base: 0, span: 1, tip: 'Beat-locked emitters circling once per bar, painting flow' },
    { id: 'rebirth', label: 'Rebirth', group: 'forces', mode: 'event', base: 0, tip: 'Respawns a share of particles from the preset’s start pattern' },

    { id: 'size', label: 'Particle size', group: 'visuals', mode: 'mul', base: 1, span: 1, centered: true, min: 0.2, tip: 'Pulses around its base' },
    { id: 'brightness', label: 'Brightness', group: 'visuals', mode: 'mul', base: 1, span: 1, centered: true, min: 0.1, tip: 'Pulses around its base' },
    { id: 'bloom', label: 'Bloom', group: 'visuals', mode: 'add', base: 0.6, span: 1.5, tip: '' },
    { id: 'flow', label: 'Flow glow', group: 'visuals', mode: 'add', base: 0, span: 1, tip: 'Reveal the invisible trail field (hue = direction)' },
    { id: 'echo', label: 'Echo', group: 'visuals', mode: 'add', base: 0, span: 0.8, tip: 'Video feedback trails' },
    { id: 'echoZoom', label: 'Echo zoom', group: 'visuals', mode: 'add', base: 0.3, span: 1, bipolar: true, tip: 'Feedback tunnel: zoom per frame' },
    { id: 'ca', label: 'Aberration', group: 'visuals', mode: 'add', base: 0, span: 1, tip: 'Chromatic split' },
    { id: 'flash', label: 'Flash', group: 'visuals', mode: 'event', base: 0, tip: 'White flash on the source’s hits' },
    { id: 'hue', label: 'Hue shift', group: 'visuals', mode: 'add', base: 0, span: 0.5, bipolar: true, tip: 'Rotate the palette' },
    { id: 'spin', label: 'Kaleido spin', group: 'visuals', mode: 'add', base: 0, span: 1, bipolar: true, tip: 'Rotation of the kaleidoscope' },
    { id: 'zoom', label: 'Camera punch', group: 'visuals', mode: 'mul', base: 1, span: 0.15, tip: 'Zoom into the scene' },
];

const m = (source, depth) => ({ source, depth });
export const PROFILES = {
    Pulse: {
        forceMult: m('kick', 0.5), speed: m('intensity', 0.5), sensorAngle: m('brightness', 0.25), strafe: m('hat', 0.6),
        lateral: m('snare', 0.5), persist: m('calm', 0.6), mutation: m('build', 0.5),
        ripple: m('kick', 0.5), ink: m('kick', 0.5), jitter: m('hat', 0.25), swirl: m('snare', 0.35), specInk: m('loudness', 0.35), orbiters: m('none', 0),
        rebirth: m('drop', 1), size: m('bass', 0.35), brightness: m('loudness', 0.4), bloom: m('kick', 0.5),
        ca: m('snare', 0.18), flash: m('drop', 1), echo: m('calm', 0.6), hue: m('none', 0), zoom: m('kick', 0.35),
    },
    Liquid: {
        forceMult: m('bass', 0.3), speed: m('loudness', 0.4), sensorDist: m('mid', 0.4), drag: m('calm', 0.4),
        persist: m('calm', 1), diffusion: m('high', 0.3),
        ink: m('kick', 0.7), specInk: m('loudness', 0.7), orbiters: m('mid', 0.7), breathe: m('bass', 0.25),
        size: m('bass', 0.2), brightness: m('loudness', 0.3), bloom: m('bass', 0.4), flow: m('mid', 0.4), echo: m('none', 0),
        hue: m('lfoBar', 0.1), rebirth: m('drop', 0.6), flash: m('drop', 0.4),
    },
    Storm: {
        forceMult: m('kick', 1), speed: m('intensity', 0.7), sensorGain: m('bass', 0.6), sensorAngle: m('snare', 0.8),
        strafe: m('hat', 1.2), lateral: m('snare', -1), mutation: m('build', 1), persist: m('calm', 0.4),
        ripple: m('kick', 1), ink: m('snare', 0.8), swirl: m('snare', 0.8), jitter: m('hat', 0.6), breathe: m('bass', 0.4),
        rebirth: m('drop', 1), size: m('bass', 0.6), brightness: m('loudness', 0.6), bloom: m('kick', 1),
        ca: m('snare', 0.9), flash: m('kick', 0.25), echo: m('build', 0.6), hue: m('snare', 0.15), spin: m('beat', 0.5), zoom: m('kick', 0.7),
    },
    Minimal: {
        speed: m('loudness', 0.3), brightness: m('loudness', 0.5), size: m('bass', 0.25), bloom: m('kick', 0.3), persist: m('calm', 0.4),
    },
    Off: {},
};

export function defaultRouting(profile = 'Pulse') {
    const p = PROFILES[profile] || {};
    const r = {};
    for (const t of TARGETS) r[t.id] = { source: p[t.id]?.source || 'none', depth: p[t.id]?.depth ?? 0, base: t.base ?? 0 };
    return r;
}

// Visual defaults that are not modulated
export function defaultLook() {
    return { palette: 0, colorMode: 0, satur: 0.8, kaleido: 0, exposure: 1, vignette: 0.35, bloomThreshold: 0.15, flowBase: 0 };
}

export class Reactor {
    constructor() {
        this.routing = defaultRouting('Pulse');
        this.profile = 'Pulse';
        this.master = 1;
        this.look = defaultLook();
        this.shocks = [];           // {x, y, r, speed, amp, ink, life}
        this.flash = 0;
        this.rebirth = 0;
        this.swirlSign = 1;
        this.spin = 0;
        this.hueDrift = 0;
        this.keyHue = 0;           // smoothed key position on the circle of fifths
        this.keyRef = null;        // key when the current preset came in
        this.hueOffset = 0;
        this.harmonicColor = true;
        this.edge = [1, 1];
        this.manual = { flash: 0, rebirth: 0, shock: 0 };
        this.lastSrc = {};
        this.srcMean = {};          // slow running mean per source (for centring)
    }

    // Physics modulation is centred on each source's running mean so a
    // preset's *average* physics stays the preset's own — the music makes it
    // surge and relax around its natural state instead of dragging it into a
    // different regime (e.g. constant hats would otherwise double strafe).
    _trackMeans(state, dt) {
        const k = 1 - Math.exp(-dt / 8);
        for (const [id] of SOURCES) {
            if (id === 'none') continue;
            const v = this.src(state, id);
            this.srcMean[id] = this.srcMean[id] === undefined ? v : this.srcMean[id] + (v - this.srcMean[id]) * k;
        }
    }

    setProfile(name) {
        this.profile = name;
        this.routing = defaultRouting(name);
        // keep user-set bases for visuals
    }

    src(state, id) {
        const s = state;
        switch (id) {
            case 'none': return 0;
            case 'kick': case 'snare': case 'hat': case 'beatPulse': return s[id] || 0;
            case 'beat': return s.beatPulse || 0;
            case 'bar': return s.barPulse || 0;
            case 'lfoBeat': return 0.5 - 0.5 * Math.cos(2 * Math.PI * (s.beatPhase || 0));
            case 'lfoBar': return 0.5 - 0.5 * Math.cos(2 * Math.PI * (s.barPhase || 0));
            case 'drop': return s.dropEnv || 0;
            case 'build': return s.build || 0;
            case 'calm': return s.calm || 0;
            case 'intensity': return s.intensity || 0;
            case 'brightness': return s.brightness || 0;
            case 'flatness': return s.flatness || 0;
            default: return s.levels?.[id] || 0;
        }
    }

    // Value of a modulated target given its base.
    value(state, id, base) {
        const t = TARGET_MAP[id];
        const r = this.routing[id];
        const b = base ?? r.base;
        if (!r || r.source === 'none' || r.depth === 0) return b;
        let sv = this.src(state, r.source);
        if ((t.group === 'physics' || t.centered) && !UNCENTERED.has(r.source)) sv -= this.srcMean[r.source] ?? sv;
        const x = sv * r.depth * this.master;
        let v;
        switch (t.mode) {
            case 'mul': v = b * (1 + x * t.span); break;
            case 'add': v = b + x * t.span; break;
            case 'persist': {
                const p = Math.min(Math.max(b, 0), 0.9995);
                v = 1 - (1 - p) * Math.pow(2, -x * t.span);
                break;
            }
            default: v = b;
        }
        if (t.min !== undefined) v = Math.max(t.min, v);
        if (t.max !== undefined) v = Math.min(t.max, v);
        return v;
    }

    // Did the source of an event-target fire this frame? returns strength or 0
    trigger(state, events, id) {
        const r = this.routing[id];
        if (!r || r.source === 'none' || r.depth === 0) return 0;
        const evType = EVENT_OF[r.source];
        let strength = 0;
        if (evType) {
            for (const e of events) if (e.type === evType) strength = Math.max(strength, e.strength ?? 1);
        } else {
            // continuous source: fire on rising edge through 0.65
            const v = this.src(state, r.source);
            const prev = this.lastSrc[id] ?? 0;
            if (v > 0.65 && prev <= 0.65) strength = v;
            this.lastSrc[id] = v;
        }
        return strength * r.depth * this.master;
    }

    // Called when a new preset is loaded: its native colours map to the current key.
    anchorHue() { this.keyRef = this.keyHue; }

    triggerDrop() { this.manual.flash = 0.7; this.manual.rebirth = 1; this.manual.shock = 1; }

    // Compute everything for this frame.
    update(dt, state, events, physics) {
        const o = {};
        if (dt > 0) this._trackMeans(state, dt);
        const V = (id, base) => this.value(state, id, base);

        // Physics
        o.forceMult = V('forceMult', physics.global_force_mult);
        o.speed = V('speed', 1);
        o.sensorGain = V('sensorGain', physics.sensor_gain);
        o.sensorAngle = V('sensorAngle', physics.sensor_angle);
        o.sensorDist = V('sensorDist', physics.sensor_distance);
        o.drag = V('drag', physics.drag);
        o.strafe = V('strafe', physics.strafe_power);
        o.axial = V('axial', physics.axial_force);
        o.lateral = V('lateral', physics.lateral_force);
        o.persist = V('persist', physics.trail_persistence);
        o.diffusion = V('diffusion', physics.trail_diffusion);
        o.mutationDelta = V('mutation', 0);
        o.hazard = physics.hazard_rate;
        o.symmetry = physics.symmetry;

        // Beat-synced swirl direction: flips every bar
        for (const e of events) if (e.type === 'bar') this.swirlSign = -this.swirlSign;

        // Shockwaves
        const ripple = this.trigger(state, events, 'ripple');
        const ink = this.trigger(state, events, 'ink');
        const manualShock = this.manual.shock;
        if (ripple > 0 || ink > 0 || manualShock > 0) {
            const centered = Math.random() < 0.6 || manualShock > 0;
            const x = centered ? 0 : (Math.random() * 2 - 1) * this.edge[0] * 0.7;
            const y = centered ? 0 : (Math.random() * 2 - 1) * this.edge[1] * 0.7;
            this.shocks.push({ x, y, r: 0.02, speed: 1.6 + 0.8 * (state.levels?.bass || 0), amp: ripple + manualShock, ink: ink + manualShock * 0.5, life: 1 });
            if (this.shocks.length > 4) this.shocks.shift();
        }
        this.manual.shock = 0;
        for (const s of this.shocks) {
            s.r += s.speed * dt;
            s.life -= dt / 0.9;
        }
        this.shocks = this.shocks.filter((s) => s.life > 0);
        o.shocks = this.shocks;

        // Rebirth & flash (events)
        let reb = this.trigger(state, events, 'rebirth');
        if (this.manual.rebirth) { reb = Math.max(reb, this.manual.rebirth); this.manual.rebirth = 0; }
        o.rebirth = Math.min(0.9, reb * 0.4);

        this.flash = Math.max(this.flash * Math.exp(-dt / 0.1), this.manual.flash, this.trigger(state, events, 'flash') * 0.6);
        this.manual.flash = 0;
        o.flash = Math.min(0.8, this.flash);

        o.swirl = V('swirl', this.routing.swirl.base) * this.swirlSign;
        o.breathe = V('breathe', this.routing.breathe.base);
        o.jitter = V('jitter', this.routing.jitter.base);
        o.specInk = V('specInk', this.routing.specInk.base);
        o.orbiters = V('orbiters', this.routing.orbiters.base);

        // Visuals
        o.size = V('size');
        o.brightness = V('brightness');
        o.bloom = V('bloom');
        o.flow = V('flow');
        o.echo = V('echo');
        o.echoZoom = V('echoZoom');
        o.ca = V('ca');
        o.zoom = V('zoom');
        this.spin += V('spin') * dt * 1.5;
        o.spin = this.spin;

        // Colour: a preset keeps its own palette in the key it arrived in, then
        // rotates as the harmony moves around the circle of fifths.
        if (state.keyHue !== undefined && (state.tonalClarity ?? 1) > 0.05) {
            let d = state.keyHue - this.keyHue;
            d -= Math.round(d);
            this.keyHue += d * Math.min(1, dt * 0.8);
        }
        if (this.keyRef === null) this.keyRef = this.keyHue;
        let target = this.harmonicColor ? this.keyHue - this.keyRef : 0;
        target -= Math.round(target - this.hueOffset);
        this.hueOffset += (target - this.hueOffset) * Math.min(1, dt * 1.2);
        o.hueShift = this.hueOffset + V('hue');
        return o;
    }
}

export const TARGET_MAP = Object.fromEntries(TARGETS.map((t) => [t.id, t]));
