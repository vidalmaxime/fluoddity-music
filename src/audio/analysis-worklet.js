/**
 * Fluoddity DJ — audio analysis worklet.
 *
 * Mono-mixes the input into a 2048-sample ring buffer and, every HOP (512)
 * samples, runs a Hann-windowed FFT and posts one packed Float32Array of
 * features to the main thread (transferred, so zero-copy).
 *
 * Packed layout (REC_SIZE floats):
 *   [0]      t          audio time (s) at hop end
 *   [1]      rms        linear RMS of the newest hop
 *   [2..6]   bands[5]   power in 20-150 / 150-500 / 500-2k / 2k-6k / 6k-16k Hz
 *   [7..10]  flux[4]    spectral flux (log-compressed) full / low / mid / high
 *   [11]     centroid   Hz
 *   [12]     flatness   0..1 (100 Hz - 10 kHz)
 *   [13..24] chroma[12] pitch-class energy, 0 = C
 *   [25..88] spectrum[64] log-spaced band level in dB (-100..0)
 */

const N = 2048;
const HOP = 512;
const LOG2N = 11;
const REC_SIZE = 89;
const FLUX_C = 1000;

const BAND_EDGES = [[20, 150], [150, 500], [500, 2000], [2000, 6000], [6000, 16000]];
const SPEC_BANDS = 64;
const SPEC_LO = 30;
const SPEC_HI = 16000;

class FluoddityAnalysis extends AudioWorkletProcessor {
    constructor() {
        super();
        const sr = sampleRate;
        this.binHz = sr / N;
        const half = N / 2;

        this.ring = new Float32Array(N);
        this.ringPos = 0;
        this.sinceHop = 0;
        this.hopSumSq = 0;
        this.hopCount = 0;

        // Hann window + FFT tables
        this.win = new Float32Array(N);
        for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
        this.rev = new Uint32Array(N);
        for (let i = 0; i < N; i++) {
            let r = 0;
            for (let b = 0; b < LOG2N; b++) r |= ((i >> b) & 1) << (LOG2N - 1 - b);
            this.rev[i] = r;
        }
        this.cosT = new Float32Array(half);
        this.sinT = new Float32Array(half);
        for (let i = 0; i < half; i++) {
            this.cosT[i] = Math.cos((2 * Math.PI * i) / N);
            this.sinT[i] = -Math.sin((2 * Math.PI * i) / N);
        }
        this.re = new Float32Array(N);
        this.im = new Float32Array(N);
        this.mag = new Float32Array(half + 1);
        this.logMag = new Float32Array(half + 1);
        this.prevLogMag = new Float32Array(half + 1);

        const nyq = sr / 2;
        const bin = (hz) => Math.max(1, Math.min(half, Math.round(Math.min(hz, nyq) / this.binHz)));

        // Band bin ranges [lo, hi)
        this.bandLo = new Uint16Array(5);
        this.bandHi = new Uint16Array(5);
        for (let b = 0; b < 5; b++) {
            this.bandLo[b] = bin(BAND_EDGES[b][0]);
            this.bandHi[b] = Math.max(this.bandLo[b] + 1, bin(BAND_EDGES[b][1]));
        }

        // Flux ranges and mid weighting
        this.fluxLo = [bin(30), bin(30), bin(150), bin(5000)];
        this.fluxHi = [bin(16000), bin(150), bin(4000), bin(16000)];
        for (let i = 0; i < 4; i++) this.fluxHi[i] = Math.max(this.fluxLo[i] + 1, this.fluxHi[i]);
        this.midW = new Float32Array(half + 1);
        for (let k = 0; k <= half; k++) {
            const f = k * this.binHz;
            this.midW[k] = f >= 1000 && f <= 4000 ? 1.6 : 1.0;
        }

        this.centLo = bin(30);
        this.centHi = bin(16000);
        this.flatLo = bin(100);
        this.flatHi = Math.max(this.flatLo + 1, bin(10000));

        // Chroma bin → pitch class (−1 = unused)
        this.chromaLo = bin(80);
        this.chromaHi = bin(5000);
        this.pc = new Int8Array(half + 1).fill(-1);
        for (let k = this.chromaLo; k < this.chromaHi; k++) {
            const f = k * this.binHz;
            const midi = 69 + 12 * Math.log2(f / 440);
            this.pc[k] = ((Math.round(midi) % 12) + 12) % 12;
        }

        // Log-spaced spectrum bands: either a bin range, or (for narrow bands)
        // linear interpolation at the band centre frequency.
        this.specLo = new Uint16Array(SPEC_BANDS);
        this.specHi = new Uint16Array(SPEC_BANDS);
        this.specCenter = new Float32Array(SPEC_BANDS); // fractional bin, used when narrow
        const hiHz = Math.min(SPEC_HI, nyq * 0.999);
        const ratio = Math.pow(hiHz / SPEC_LO, 1 / SPEC_BANDS);
        for (let i = 0; i < SPEC_BANDS; i++) {
            const f0 = SPEC_LO * Math.pow(ratio, i);
            const f1 = f0 * ratio;
            const lo = Math.ceil(f0 / this.binHz);
            const hi = Math.floor(f1 / this.binHz);
            this.specLo[i] = lo;
            this.specHi[i] = hi; // hi < lo means "narrow" → interpolate
            this.specCenter[i] = Math.sqrt(f0 * f1) / this.binHz;
        }

        this.chromaAcc = new Float32Array(12);
    }

    fft() {
        const re = this.re, im = this.im, cosT = this.cosT, sinT = this.sinT;
        for (let size = 2; size <= N; size <<= 1) {
            const halfSize = size >> 1;
            const step = N / size;
            for (let start = 0; start < N; start += size) {
                for (let j = 0, t = 0; j < halfSize; j++, t += step) {
                    const a = start + j;
                    const b = a + halfSize;
                    const wr = cosT[t], wi = sinT[t];
                    const xr = re[b] * wr - im[b] * wi;
                    const xi = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - xr;
                    im[b] = im[a] - xi;
                    re[a] += xr;
                    im[a] += xi;
                }
            }
        }
    }

    analyse(tEnd) {
        const half = N / 2;
        const re = this.re, im = this.im, ring = this.ring, win = this.win, rev = this.rev;
        // Unroll ring (oldest first) with window, bit-reversed placement
        let p = this.ringPos;
        for (let i = 0; i < N; i++) {
            const r = rev[i];
            re[r] = ring[p] * win[i];
            im[r] = 0;
            p++;
            if (p === N) p = 0;
        }
        this.fft();

        const mag = this.mag, logMag = this.logMag, prev = this.prevLogMag;
        const norm = 4 / N; // full-scale sine → ~1
        for (let k = 0; k <= half; k++) {
            const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * norm;
            mag[k] = m;
            logMag[k] = Math.log(1 + FLUX_C * m);
        }

        const out = new Float32Array(REC_SIZE);
        out[0] = tEnd;
        out[1] = Math.sqrt(this.hopSumSq / Math.max(1, this.hopCount));

        // Bands
        for (let b = 0; b < 5; b++) {
            let s = 0;
            for (let k = this.bandLo[b]; k < this.bandHi[b]; k++) s += mag[k] * mag[k];
            out[2 + b] = s;
        }

        // Flux
        for (let f = 0; f < 4; f++) {
            let s = 0, w = 0;
            const lo = this.fluxLo[f], hi = this.fluxHi[f];
            for (let k = lo; k < hi; k++) {
                const d = logMag[k] - prev[k];
                const wk = f === 2 ? this.midW[k] : 1;
                if (d > 0) s += d * wk;
                w += wk;
            }
            out[7 + f] = s / Math.max(1, w);
        }

        // Centroid
        {
            let num = 0, den = 0;
            for (let k = this.centLo; k < this.centHi; k++) {
                num += k * this.binHz * mag[k];
                den += mag[k];
            }
            out[11] = den > 1e-12 ? num / den : 0;
        }

        // Flatness (power spectrum)
        {
            let logSum = 0, sum = 0;
            const lo = this.flatLo, hi = this.flatHi, n = hi - lo;
            for (let k = lo; k < hi; k++) {
                const pw = mag[k] * mag[k] + 1e-14;
                logSum += Math.log(pw);
                sum += pw;
            }
            const am = sum / n;
            const gm = Math.exp(logSum / n);
            out[12] = am > 1e-13 ? Math.min(1, gm / am) : 0;
        }

        // Chroma
        {
            const acc = this.chromaAcc;
            acc.fill(0);
            for (let k = this.chromaLo; k < this.chromaHi; k++) {
                const c = this.pc[k];
                if (c >= 0) acc[c] += mag[k] * mag[k];
            }
            for (let c = 0; c < 12; c++) out[13 + c] = acc[c];
        }

        // Log spectrum (dB)
        for (let i = 0; i < SPEC_BANDS; i++) {
            const lo = this.specLo[i], hi = this.specHi[i];
            let pw;
            if (hi >= lo) {
                let s = 0;
                for (let k = lo; k <= hi; k++) s += mag[k] * mag[k];
                pw = s / (hi - lo + 1);
            } else {
                const c = this.specCenter[i];
                const k0 = Math.min(half - 1, Math.floor(c));
                const fr = c - k0;
                const m = mag[k0] * (1 - fr) + mag[k0 + 1] * fr;
                pw = m * m;
            }
            const db = 10 * Math.log10(pw + 1e-12);
            out[25 + i] = db < -100 ? -100 : db > 0 ? 0 : db;
        }

        // Swap flux history
        this.prevLogMag = logMag;
        this.logMag = prev;

        this.port.postMessage(out, [out.buffer]);
    }

    process(inputs) {
        const input = inputs[0];
        const nch = input ? input.length : 0;
        const frames = nch > 0 ? input[0].length : 128;
        const ring = this.ring;
        const inv = nch > 0 ? 1 / nch : 0;
        for (let i = 0; i < frames; i++) {
            let s = 0;
            for (let c = 0; c < nch; c++) s += input[c][i];
            s *= inv;
            if (!(s === s)) s = 0; // NaN guard
            ring[this.ringPos] = s;
            this.ringPos = (this.ringPos + 1) & (N - 1);
            this.hopSumSq += s * s;
            this.hopCount++;
            this.sinceHop++;
            if (this.sinceHop >= HOP) {
                this.sinceHop = 0;
                this.analyse((currentFrame + i + 1) / sampleRate);
                this.hopSumSq = 0;
                this.hopCount = 0;
            }
        }
        return true;
    }
}

registerProcessor('fluoddity-analysis', FluoddityAnalysis);
