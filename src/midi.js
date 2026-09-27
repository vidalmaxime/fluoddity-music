// Web MIDI learn: any element with [data-midi] can be mapped to a knob, fader
// or pad on a DJ controller. Mappings persist in localStorage.

const KEY = 'fluoddity-dj.midi';

export class Midi {
    constructor({ toast } = {}) {
        this.toast = toast || (() => {});
        this.access = null;
        this.learning = false;
        this.pending = null;   // element waiting for a message
        this.map = {};         // "cc:ch:num" | "note:ch:num" → data-midi id
        this.lastCC = {};      // for edge-triggering buttons from CC pads
        try { this.map = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { this.map = {}; }
        this._onClick = this._onClick.bind(this);
    }

    async enable() {
        if (this.access) return true;
        if (!navigator.requestMIDIAccess) { this.toast('Web MIDI is not available in this browser (use Chrome or Edge)'); return false; }
        try {
            this.access = await navigator.requestMIDIAccess();
        } catch (e) {
            this.toast(`MIDI access denied: ${e.message}`);
            return false;
        }
        const attach = () => this.access.inputs.forEach((inp) => (inp.onmidimessage = (m) => this._message(m.data)));
        attach();
        this.access.onstatechange = attach;
        return true;
    }

    async toggleLearn() {
        if (!(await this.enable())) return;
        this.learning = !this.learning;
        document.body.classList.toggle('midi-learn', this.learning);
        document.getElementById('btn-midi')?.classList.toggle('on', this.learning);
        if (this.learning) {
            this._markMapped();
            document.addEventListener('click', this._onClick, true);
            const n = this.access.inputs.size;
            this.toast(n ? `MIDI learn: click a control, then move a knob/pad (${n} device${n > 1 ? 's' : ''})` : 'MIDI learn on — no MIDI devices connected yet');
        } else {
            document.removeEventListener('click', this._onClick, true);
            this.pending?.classList.remove('learning');
            this.pending = null;
        }
    }

    _markMapped() {
        const ids = new Set(Object.values(this.map));
        document.querySelectorAll('[data-midi]').forEach((el) => el.classList.toggle('mapped', ids.has(el.dataset.midi)));
    }

    _onClick(e) {
        const el = e.target.closest('[data-midi]');
        if (!el || el.id === 'btn-midi') return;
        e.preventDefault();
        e.stopPropagation();
        this.pending?.classList.remove('learning');
        this.pending = el;
        el.classList.add('learning');
    }

    _message(data) {
        const [st, num, val] = data;
        const type = st & 0xf0, ch = st & 0x0f;
        let key, value, press = false;
        if (type === 0xb0) {
            key = `cc:${ch}:${num}`;
            value = val / 127;
            press = val > 63 && !(this.lastCC[key] > 63);   // rising edge only
            this.lastCC[key] = val;
        }
        else if (type === 0x90 && val > 0) { key = `note:${ch}:${num}`; value = 1; press = true; }
        else return;

        if (this.learning && this.pending) {
            for (const k of Object.keys(this.map)) if (this.map[k] === this.pending.dataset.midi) delete this.map[k];
            this.map[key] = this.pending.dataset.midi;
            localStorage.setItem(KEY, JSON.stringify(this.map));
            this.toast(`Mapped ${key} → ${this.pending.dataset.midi}`);
            this.pending.classList.remove('learning');
            this.pending = null;
            this._markMapped();
            return;
        }
        const id = this.map[key];
        if (!id) return;
        const el = document.querySelector(`[data-midi="${id}"]`);
        if (!el) return;
        if (el.type === 'range') {
            el.value = +el.min + value * (+el.max - +el.min);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (el.type === 'checkbox') {
            if (press) { el.checked = !el.checked; el.dispatchEvent(new Event('change', { bubbles: true })); }
        } else if (el.tagName === 'SELECT') {
            if (type === 0xb0 && !key.startsWith('note')) {
                el.selectedIndex = Math.min(el.options.length - 1, Math.floor(value * el.options.length));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (press) {
                el.selectedIndex = (el.selectedIndex + 1) % el.options.length;
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } else if (press) {
            el.click();
        }
    }
}
