// Preset library, the two-deck mixer (crossfade morphs through rule space) and
// the Director, which picks and mixes presets on musical boundaries.

import { computeEntityRule } from './rule.js';

export const PHYSICS_KEYS = [
    'sensor_gain', 'sensor_angle', 'sensor_distance', 'mutation_scale', 'global_force_mult', 'drag',
    'strafe_power', 'axial_force', 'lateral_force', 'hazard_rate', 'trail_persistence', 'trail_diffusion',
];

// Hand-picked by the Fluoddity author for the web demo; a good default crate.
export const STARTER_CRATE = ['HungryHungryHippos', 'Corners', 'Bramble', 'SideWinder', 'Circuits', 'Web', 'Vacuoles',
    'Cilia', 'Meandering', 'Bubbles', 'Pop', 'Nettle', 'ReactionConfusion', 'LavaLamp', 'Critters', 'Veins', 'RingOfFire'];

export function normalizePreset(p) {
    const rule = Float32Array.from(p.rule);
    const gen = rule[0] === 0 && rule[1] === 0 && rule[2] === 0 && rule[3] === 0 &&
        rule[44] === 0 && rule[45] === 0 && rule[46] === 0 && rule[47] === 0;
    return { ...p, rule, gen, physics: { ...p.physics } };
}

export async function loadLibrary(url = 'presets/presets.json') {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load presets (${res.status})`);
    const list = (await res.json()).map(normalizePreset);
    return list;
}

const smooth = (t) => t * t * (3 - 2 * t);

export class Mixer {
    constructor(a, b) {
        this.decks = [a, b];
        this.xf = 0;            // 0 = deck A, 1 = deck B
        this.transition = null; // {from, to, beats, progress}
        this.onchange = null;
        this.generation = 0;    // bumps whenever a deck changes (UI refresh)
    }

    get live() { return this.xf < 0.5 ? 0 : 1; }
    get off() { return 1 - this.live; }
    get dominant() { return this.decks[this.live]; }

    loadDeck(i, preset) {
        this.decks[i] = preset;
        this.generation++;
        this.onchange?.();
    }

    // Load onto the off deck and glide the crossfader across over `beats`.
    mixTo(preset, beats = 8) {
        const target = this.transition ? this.transition.to : this.off === 1 ? 1 : 0;
        const deck = target === 1 ? 1 : 0;
        // If a transition is already under way towards `deck`, retarget: the
        // crossfader is between decks, so swap what's loaded on the target.
        this.loadDeck(deck, preset);
        this.transition = { from: this.xf, to: deck, beats: Math.max(0.01, beats), progress: 0 };
    }

    // Instant switch (for drops).
    cut(preset) {
        const deck = this.off;
        this.loadDeck(deck, preset);
        this.transition = null;
        this.xf = deck;
    }

    setCrossfader(x) {
        this.transition = null;
        this.xf = Math.min(1, Math.max(0, x));
    }

    update(dt, bpm) {
        const t = this.transition;
        if (!t) return;
        const beatsPerSec = (bpm > 0 ? bpm : 120) / 60;
        t.progress += (dt * beatsPerSec) / t.beats;
        if (t.progress >= 1) {
            this.xf = t.to;
            this.transition = null;
        } else {
            this.xf = t.from + (t.to - t.from) * smooth(t.progress);
        }
    }

    blendedPhysics() {
        const [a, b] = this.decks;
        const x = this.xf;
        const out = {};
        for (const k of PHYSICS_KEYS) out[k] = a.physics[k] * (1 - x) + b.physics[k] * x;
        out.symmetry = (a.disable_symmetry ? 0 : 1) * (1 - x) + (b.disable_symmetry ? 0 : 1) * x;
        return out;
    }

    // The exact rule the particle at `index` runs, as a new preset in its lineage.
    lineageOf(index, count) {
        const x = this.xf;
        const side = (d) => computeEntityRule(d.rule, d.rule_seed, d.physics.mutation_scale, d.cohorts, index, count);
        const [a, b] = this.decks;
        let rule;
        if (x <= 0) rule = side(a);
        else if (x >= 1) rule = side(b);
        else {
            const ra = side(a), rb = side(b);
            rule = ra.map((v, i) => v * (1 - x) + rb[i] * x);
        }
        const base = this.dominant;
        const gen = (base.lineage || 0) + 1;
        const root = base.root || base.name;
        return { ...base, physics: { ...base.physics }, rule: Float32Array.from(rule), gen: false, name: `${root} ›${gen}`, root, lineage: gen };
    }
}

export class Director {
    constructor(mixer, library) {
        this.mixer = mixer;
        this.library = library;
        this.settings = {
            enabled: true,
            phraseBars: 16,
            mixBeats: 8,
            onDrop: 'cut',       // 'cut' | 'mix' | 'none'
            evolveBars: 0,       // 0 = off
            order: 'shuffle',    // 'shuffle' | 'sequence'
            crate: 'starter',    // 'starter' | 'favorites' | 'all' | 'Core' | 'Advanced'
        };
        this.favorites = new Set();
        this.barsSinceChange = 0;
        this.barsSinceEvolve = 0;
        this.history = [];
        this.onaction = null; // (message) => void
        this.lastIndex = -1;
    }

    crate() {
        const s = this.settings.crate;
        let list;
        if (s === 'favorites') list = this.library.filter((p) => this.favorites.has(p.name));
        else if (s === 'starter') list = this.library.filter((p) => STARTER_CRATE.includes(p.name));
        else if (s === 'Core' || s === 'Advanced') list = this.library.filter((p) => p.category === s);
        else list = this.library;
        return list.length ? list : this.library;
    }

    pickNext() {
        const crate = this.crate();
        const current = new Set(this.mixer.decks.map((d) => d.root || d.name));
        if (this.settings.order === 'sequence') {
            const cur = crate.findIndex((p) => current.has(p.name));
            return crate[(Math.max(cur, this.lastIndex) + 1) % crate.length];
        }
        const recent = new Set(this.history.slice(-Math.min(6, Math.floor(crate.length / 2))));
        const pool = crate.filter((p) => !current.has(p.name) && !recent.has(p.name));
        const pick = (pool.length ? pool : crate)[Math.floor(Math.random() * (pool.length || crate.length))];
        return pick;
    }

    _remember(p) {
        this.history.push(p.name);
        if (this.history.length > 50) this.history.shift();
        this.lastIndex = this.crate().indexOf(p);
    }

    next({ cut = false, beats } = {}) {
        const p = this.pickNext();
        if (!p) return null;
        this._remember(p);
        if (cut) this.mixer.cut(p);
        else this.mixer.mixTo(p, beats ?? this.settings.mixBeats);
        this.barsSinceChange = 0;
        this.barsSinceEvolve = 0;
        return p;
    }

    evolve(count) {
        const index = Math.floor(Math.random() * count);
        const child = this.mixer.lineageOf(index, count);
        this.mixer.mixTo(child, 4);
        this.barsSinceEvolve = 0;
        return child;
    }

    // Returns list of actions fired this frame, e.g. [{type:'drop'}] for FX.
    update(events, count) {
        const s = this.settings;
        const fired = [];
        for (const ev of events) {
            if (ev.type === 'bar') {
                this.barsSinceChange++;
                this.barsSinceEvolve++;
                if (!s.enabled) continue;
                if (s.phraseBars > 0 && this.barsSinceChange >= s.phraseBars && !this.mixer.transition) {
                    const p = this.next();
                    if (p) this.onaction?.(`Phrase → mixing into ${p.name}`);
                } else if (s.evolveBars > 0 && this.barsSinceEvolve >= s.evolveBars && !this.mixer.transition) {
                    const c = this.evolve(count);
                    this.onaction?.(`Evolving → ${c.name}`);
                }
            } else if (ev.type === 'drop') {
                fired.push({ type: 'drop' });
                if (!s.enabled || s.onDrop === 'none') continue;
                const p = this.next({ cut: s.onDrop === 'cut', beats: 2 });
                if (p) this.onaction?.(`DROP → ${s.onDrop === 'cut' ? 'cut to' : 'slam into'} ${p.name}`);
            }
        }
        return fired;
    }
}
