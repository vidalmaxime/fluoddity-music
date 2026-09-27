// DOM side of the app: panels, library, modulation matrix, meters.

import { SOURCES, TARGETS, PROFILES } from './reactor.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// Controls keep focus after use and swallow shortcuts; release it.
// Only after the interaction is finished: blurring a <select> on pointerup
// would close its menu immediately, and text fields must keep focus to type.
function releaseFocus(el) {
    if (el.tagName === 'INPUT' && (el.type === 'search' || el.type === 'text')) return;
    el.addEventListener('change', () => el.blur());
    if (el.type === 'range' || el.type === 'checkbox') {
        el.addEventListener('pointerup', () => setTimeout(() => el.blur(), 0));
    }
}

export class UI {
    constructor(app) {
        this.app = app;
        this.hud = $('#hud');
        this.spec = $('#spectrum').getContext('2d');
        this.frame = 0;
        this.xfDragging = false;
        this.libFilter = '';
        this._toastTimer = null;
        this._buildMatrix();
        this._buildProfiles();
        this._bind();
        this.renderLibrary();
        this.renderDecks();
        $$('select, input').forEach(releaseFocus);
    }

    // ── static wiring ──────────────────────────────────────────────────────
    _bind() {
        const app = this.app;
        const on = (sel, ev, fn) => $(sel).addEventListener(ev, fn);

        on('#src-tab', 'click', () => app.startSource('tab'));
        on('#src-input', 'click', () => app.startSource('input'));
        on('#src-files', 'click', () => $('#file-input').click());
        on('#src-demo', 'click', () => app.startSource('demo'));
        on('#file-input', 'change', (e) => { if (e.target.files.length) app.startFiles([...e.target.files]); e.target.value = ''; });
        on('#input-device', 'change', (e) => app.startSource('input', e.target.value));
        on('#tr-prev', 'click', () => app.audio.prev?.());
        on('#tr-next', 'click', () => app.audio.next?.());
        on('#tr-play', 'click', () => app.audio.togglePlay?.());
        on('#tr-bar', 'click', (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            app.audio.seek?.(((e.clientX - r.left) / r.width) * (app.audio.duration || 0));
        });

        on('#tap', 'click', () => app.brain.tap());
        on('#resync', 'click', () => app.brain.resyncDownbeat());
        on('#btn-projector', 'click', () => app.output.popout());
        on('#btn-rec', 'click', () => app.toggleRecording());
        on('#btn-fs', 'click', () => app.toggleFullscreen());
        on('#btn-hide', 'click', () => this.toggleHud());
        on('#btn-help', 'click', () => this.toggleHelp(true));
        on('#help', 'click', () => this.toggleHelp(false));

        on('#btn-next', 'click', (e) => app.next(e.shiftKey));
        on('#btn-drop', 'click', () => app.drop());
        on('#btn-evolve', 'click', () => app.evolve());
        on('#mix-beats', 'change', (e) => { app.director.settings.mixBeats = +e.target.value; app.save(); });

        const d = app.director.settings;
        const autoBind = (sel, key, num) => on(sel, 'change', (e) => { d[key] = num ? +e.target.value : e.target.value; app.save(); });
        on('#auto-enabled', 'change', (e) => { d.enabled = e.target.checked; app.save(); });
        autoBind('#auto-phrase', 'phraseBars', true);
        autoBind('#auto-drop', 'onDrop');
        autoBind('#auto-evolve', 'evolveBars', true);
        autoBind('#auto-crate', 'crate');
        autoBind('#auto-order', 'order');

        on('#lib-search', 'input', (e) => { this.libFilter = e.target.value.trim().toLowerCase(); this.renderLibrary(); });
        on('#lib-search', 'keydown', (e) => { if (e.key === 'Escape' || e.key === 'Enter') e.target.blur(); e.stopPropagation(); });

        const xf = $('#crossfader');
        xf.addEventListener('pointerdown', () => (this.xfDragging = true));
        window.addEventListener('pointerup', () => (this.xfDragging = false));
        xf.addEventListener('input', () => app.mixer.setCrossfader(+xf.value));

        const r = app.reactor;
        on('#profile', 'change', (e) => { r.setProfile(e.target.value); this.syncMatrix(); app.save(); });
        this._range('#master', (v) => (r.master = v), () => r.master);
        this._range('#sensitivity', (v) => app.brain.setSensitivity(v), () => app.settings.sensitivity, (v) => (app.settings.sensitivity = v));
        on('#palette', 'change', (e) => { r.look.palette = +e.target.value; app.save(); });
        on('#color-mode', 'change', (e) => { r.look.colorMode = +e.target.value; app.save(); });
        on('#harmonic', 'change', (e) => { r.harmonicColor = e.target.checked; app.save(); });
        on('#kaleido', 'change', (e) => { r.look.kaleido = +e.target.value; app.save(); });
        this._range('#exposure', (v) => (r.look.exposure = v), () => r.look.exposure);

        on('#world-size', 'change', (e) => app.setWorldSize(+e.target.value));
        on('#render-scale', 'change', (e) => { app.settings.renderScale = +e.target.value; app.save(); });
        this._range('#steps', (v) => (app.settings.steps = v), () => app.settings.steps);
        on('#mouse-mode', 'change', (e) => (app.mouseMode = e.target.value));
        on('#btn-reset', 'click', () => app.resetSim());
        on('#btn-midi', 'click', () => app.midi.toggleLearn());

        $$('#start [data-start]').forEach((b) => b.addEventListener('click', () => {
            const kind = b.dataset.start;
            if (kind === 'files') $('#file-input').click();
            else app.startSource(kind);
        }));
    }

    _range(sel, set, get, persist) {
        const el = $(sel);
        const out = el.parentElement.querySelector('output');
        const show = () => out && (out.textContent = (+el.value).toFixed(el.step >= 1 ? 0 : 2));
        el.value = get();
        show();
        el.addEventListener('input', () => { set(+el.value); persist?.(+el.value); show(); this.app.save(); });
        el._sync = () => { el.value = get(); show(); };
    }

    syncControls() {
        const app = this.app, r = app.reactor, d = app.director.settings;
        $('#profile').value = r.profile;
        $('#palette').value = r.look.palette;
        $('#color-mode').value = r.look.colorMode;
        $('#harmonic').checked = r.harmonicColor;
        $('#kaleido').value = r.look.kaleido;
        $('#auto-enabled').checked = d.enabled;
        $('#auto-phrase').value = d.phraseBars;
        $('#auto-drop').value = d.onDrop;
        $('#auto-evolve').value = d.evolveBars;
        $('#auto-crate').value = d.crate;
        $('#auto-order').value = d.order;
        $('#mix-beats').value = d.mixBeats;
        $('#world-size').value = String(app.settings.worldSize);
        $('#render-scale').value = String(app.settings.renderScale);
        $('#mouse-mode').value = app.mouseMode;
        $$('input[type=range]').forEach((el) => el._sync?.());
        this.syncMatrix();
    }

    _buildProfiles() {
        const sel = $('#profile');
        for (const name of Object.keys(PROFILES)) sel.add(new Option(name, name));
        sel.add(new Option('Custom', 'Custom'));
        sel.value = this.app.reactor.profile;
    }

    _buildMatrix() {
        const root = $('#matrix');
        const groups = { physics: 'Physics', forces: 'Forces', visuals: 'Visuals' };
        this.mxRows = {};
        for (const [g, label] of Object.entries(groups)) {
            const h = document.createElement('div');
            h.className = 'mx-group';
            h.textContent = label;
            root.appendChild(h);
            for (const t of TARGETS.filter((x) => x.group === g)) {
                const row = document.createElement('div');
                row.className = 'mx-row';
                row.title = t.tip || '';
                const hasBase = t.group !== 'physics' && t.mode !== 'event';
                if (!hasBase) row.classList.add('nobase');
                const baseMax = t.id === 'size' || t.id === 'brightness' ? 3 : t.id === 'zoom' ? 3 : t.bipolar ? 1 : t.id === 'bloom' ? 3 : 1;
                const baseMin = t.bipolar ? -1 : t.id === 'zoom' ? 1 : 0;
                row.innerHTML = `
                    <span class="t">${t.label}</span>
                    <input class="base" type="range" min="${baseMin}" max="${baseMax}" step="0.01" data-midi="base-${t.id}">
                    <select></select>
                    <input class="depth" type="range" min="-1.5" max="1.5" step="0.01" data-midi="depth-${t.id}" title="Depth (double-click to zero)">
                    <div class="meter"><i></i></div>`;
                const sel = row.querySelector('select');
                for (const [id, name] of SOURCES) sel.add(new Option(name, id));
                const r = () => this.app.reactor.routing[t.id];
                sel.addEventListener('change', () => { r().source = sel.value; this._custom(); row.classList.toggle('active', r().source !== 'none' && r().depth !== 0); });
                const depth = row.querySelector('.depth');
                depth.addEventListener('input', () => { r().depth = +depth.value; this._custom(); row.classList.toggle('active', r().source !== 'none' && r().depth !== 0); });
                depth.addEventListener('dblclick', () => { depth.value = 0; r().depth = 0; this._custom(); });
                const base = row.querySelector('.base');
                base.addEventListener('input', () => { r().base = +base.value; this.app.save(); });
                base.addEventListener('dblclick', () => { base.value = t.base ?? 0; r().base = t.base ?? 0; this.app.save(); });
                root.appendChild(row);
                this.mxRows[t.id] = { row, sel, depth, base, meter: row.querySelector('.meter i') };
            }
        }
    }

    _custom() {
        this.app.reactor.profile = 'Custom';
        $('#profile').value = 'Custom';
        this.app.save();
    }

    syncMatrix() {
        const R = this.app.reactor.routing;
        for (const [id, x] of Object.entries(this.mxRows)) {
            x.sel.value = R[id].source;
            x.depth.value = R[id].depth;
            x.base.value = R[id].base;
            x.row.classList.toggle('active', R[id].source !== 'none' && R[id].depth !== 0);
        }
    }

    // ── library ────────────────────────────────────────────────────────────
    renderLibrary() {
        const app = this.app;
        const root = $('#library');
        root.innerHTML = '';
        const favs = [...app.director.favorites];
        const liveNames = app.mixer.decks.map((d) => d.root || d.name);
        const f = this.libFilter;
        const sections = [];
        if (favs.length && !f) sections.push(['★ Favorites', app.library.filter((p) => app.director.favorites.has(p.name)).sort((a, b) => favs.indexOf(a.name) - favs.indexOf(b.name))]);
        for (const cat of ['Core', 'Advanced']) sections.push([cat, app.library.filter((p) => p.category === cat && (!f || p.name.toLowerCase().includes(f)))]);
        for (const [title, items] of sections) {
            if (!items.length) continue;
            const h = document.createElement('div');
            h.className = 'lib-cat';
            h.textContent = `${title} · ${items.length}`;
            root.appendChild(h);
            for (const p of items) {
                const el = document.createElement('div');
                el.className = 'lib-item';
                const slot = favs.indexOf(p.name);
                const live = liveNames[app.mixer.live] === p.name, cued = liveNames[app.mixer.off] === p.name;
                if (live) el.classList.add('live');
                else if (cued) el.classList.add('cued');
                el.innerHTML = `<span class="slot">${slot >= 0 && slot < 9 ? slot + 1 : ''}</span><span class="n"></span><span class="star ${app.director.favorites.has(p.name) ? 'on' : ''}" title="Favourite (keys 1–9)">★</span>`;
                el.querySelector('.n').textContent = p.name;
                el.addEventListener('click', (e) => {
                    if (e.target.classList.contains('star')) { app.toggleFavorite(p.name); return; }
                    app.play(p, e.shiftKey);
                });
                root.appendChild(el);
            }
        }
    }

    renderDecks() {
        const m = this.app.mixer;
        ['a', 'b'].forEach((k, i) => {
            const d = m.decks[i];
            const el = $(`#deck-${k}`);
            el.querySelector('.name').textContent = d.name;
            el.querySelector('.cat').textContent = d.lineage ? `lineage · gen ${d.lineage}` : `${d.category} · ${d.cohorts} tribes`;
            $(`#xf-${k}`).textContent = d.name;
        });
        this._deckGen = m.generation;
        this.renderLibrary();
    }

    // ── per-frame ─────────────────────────────────────────────────────────
    update(dt, s, fx, perf) {
        this.frame++;
        if (this.hud.classList.contains('hidden')) return;
        const app = this.app;
        const m = app.mixer;
        if (this._deckGen !== m.generation) this.renderDecks();

        $('#deck-a').classList.toggle('live', m.xf < 0.5);
        $('#deck-b').classList.toggle('live', m.xf >= 0.5);
        if (!this.xfDragging) $('#crossfader').value = m.xf;

        // tempo
        const bpmEl = $('#bpm');
        bpmEl.textContent = s.bpm > 0 ? s.bpm.toFixed(1) : '–––';
        bpmEl.parentElement.classList.toggle('low', (s.bpmConfidence ?? 0) < 0.3 && !s.manual);
        bpmEl.parentElement.classList.toggle('manual', !!s.manual);
        $$('#beats i').forEach((el, i) => {
            el.classList.toggle('on', s.beatInBar === i && (s.beatPhase ?? 1) < 0.35);
            el.classList.toggle('down', i === 0);
        });

        const tag = $('#section-tag');
        let sec = 'groove', cls = '';
        if (s.silent) sec = 'silence';
        else if ((s.dropEnv ?? 0) > 0.25) { sec = 'drop'; cls = 'drop'; }
        else if ((s.build ?? 0) > 0.55) { sec = 'build'; cls = 'build'; }
        else if ((s.calm ?? 0) > 0.55) { sec = 'breakdown'; cls = 'calm'; }
        if (tag.textContent !== sec.toUpperCase()) { tag.textContent = sec.toUpperCase(); tag.className = cls; }

        $('#led-kick').classList.toggle('on', (s.kick ?? 0) > 0.35);
        $('#led-snare').classList.toggle('on', (s.snare ?? 0) > 0.35);
        $('#led-hat').classList.toggle('on', (s.hat ?? 0) > 0.35);

        if (this.frame % 3 === 0) {
            $('#m-intensity').value = s.intensity ?? 0;
            $('#m-build').value = s.build ?? 0;
            $('#m-drop').value = s.dropEnv ?? 0;
            $('#m-calm').value = s.calm ?? 0;
            // modulation meters
            const r = app.reactor;
            for (const [id, x] of Object.entries(this.mxRows)) {
                const R = r.routing[id];
                const v = R.source === 'none' ? 0 : Math.min(1, Math.abs(r.src(s, R.source) * R.depth));
                x.meter.style.width = `${(v * 100).toFixed(0)}%`;
            }
        }

        // transport
        const a = app.audio;
        if (a.sourceType === 'files') {
            $('#transport').hidden = false;
            $('#tr-name').textContent = a.trackName || '';
            $('#tr-pos').style.width = `${a.duration ? (100 * a.currentTime) / a.duration : 0}%`;
        } else $('#transport').hidden = true;

        if (this.frame % 30 === 0 && perf) $('#perf').textContent = perf;

        this._drawSpectrum(s);
    }

    setAccent(hue01) {
        const h = Math.round(((hue01 % 1) + 1) % 1 * 360);
        if (h === this._lastHue) return;
        this._lastHue = h;
        this._accentStr = `hsl(${h} 90% 62%)`;
        document.documentElement.style.setProperty('--accent', `hsl(${h} 90% 62%)`);
        document.documentElement.style.setProperty('--accent-soft', `hsl(${h} 90% 62% / 0.18)`);
    }

    _drawSpectrum(s) {
        const c = this.spec, W = c.canvas.width, H = c.canvas.height;
        c.clearRect(0, 0, W, H);
        const sp = s.spectrum;
        if (!sp) return;
        const n = sp.length, bw = W / n;
        c.fillStyle = this._accentStr || '#4cf';
        for (let i = 0; i < n; i++) {
            const h = Math.max(1, sp[i] * (H - 4));
            c.globalAlpha = 0.35 + 0.65 * sp[i];
            c.fillRect(i * bw + 0.5, H - h, bw - 1.5, h);
        }
        c.globalAlpha = 1;
        // beat phase line
        c.fillStyle = 'rgba(255,255,255,.5)';
        c.fillRect(0, 0, W * (s.barPhase ?? 0), 2);
    }

    // ── misc ──────────────────────────────────────────────────────────────
    toggleHud(force) {
        const hide = force !== undefined ? force : !this.hud.classList.contains('hidden');
        this.hud.classList.toggle('hidden', hide);
        document.body.classList.toggle('cursor-hidden', hide);
    }
    toggleHelp(show) { $('#help').classList.toggle('hidden', !show); }
    hideStart() { $('#start').classList.add('hidden'); }
    setGpuStatus(t) { $('#gpu-status').textContent = t; }
    setSourceLabel(t) { $('#src-label').textContent = t; }
    markSource(kind) {
        ['tab', 'input', 'files', 'demo'].forEach((k) => $(`#src-${k}`).classList.toggle('on', k === kind));
    }
    async fillDevices(list, current) {
        const sel = $('#input-device');
        sel.innerHTML = '';
        for (const d of list) sel.add(new Option(d.label || 'Input', d.deviceId));
        if (current) sel.value = current;
        sel.hidden = list.length < 2;
    }
    setRecording(on) {
        const b = $('#btn-rec');
        b.classList.toggle('on', on);
        b.textContent = on ? '■ Stop' : '● Rec';
    }
    toast(msg, ms = 2600) {
        const t = $('#toast');
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => t.classList.remove('show'), ms);
    }
    error(msg) {
        const e = $('#error');
        e.textContent = msg;
        e.hidden = !msg;
        if (msg) setTimeout(() => (e.hidden = true), 9000);
    }
}
