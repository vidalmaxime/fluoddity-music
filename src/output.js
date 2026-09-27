// Projector window (a clean second-screen output fed by canvas.captureStream)
// and video+audio recording via MediaRecorder.

export class Output {
    constructor(canvas, { onRecordingChange, onError } = {}) {
        this.canvas = canvas;
        this.win = null;
        this.stream = null;
        this.recorder = null;
        this.chunks = [];
        this.onRecordingChange = onRecordingChange;
        this.onError = onError;
    }

    _videoStream() {
        if (!this.stream || this.stream.getVideoTracks().every((t) => t.readyState === 'ended')) {
            this.stream = this.canvas.captureStream(60);
        }
        return this.stream;
    }

    popout() {
        if (this.win && !this.win.closed) { this.win.focus(); return; }
        const w = window.open('', 'fluoddity-output', 'popup,width=1280,height=720');
        if (!w) { this.onError?.('Pop-up blocked: allow pop-ups for this page to open the projector window.'); return; }
        w.document.title = 'Fluoddity DJ · Output';
        w.document.body.style.cssText = 'margin:0;background:#000;overflow:hidden;cursor:none';
        w.document.body.innerHTML = '<video autoplay muted playsinline style="width:100vw;height:100vh;object-fit:cover;display:block"></video>' +
            '<div style="position:fixed;bottom:12px;left:50%;transform:translateX(-50%);font:12px monospace;color:#888;background:#0008;padding:6px 10px;border-radius:6px" id="hint">Double-click for fullscreen — drag this window to the projector first</div>';
        const video = w.document.querySelector('video');
        video.srcObject = this._videoStream();
        video.play().catch(() => {});
        w.document.addEventListener('dblclick', () => {
            if (w.document.fullscreenElement) w.document.exitFullscreen();
            else w.document.documentElement.requestFullscreen().catch(() => {});
        });
        setTimeout(() => { const h = w.document.getElementById('hint'); if (h) h.remove(); }, 6000);
        this.win = w;
    }

    get recording() { return !!this.recorder && this.recorder.state === 'recording'; }

    startRecording(audioStream) {
        const tracks = [...this._videoStream().getVideoTracks()];
        if (audioStream) tracks.push(...audioStream.getAudioTracks());
        const stream = new MediaStream(tracks);
        const types = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
        const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
        try {
            this.recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 16_000_000 });
        } catch (e) {
            this.onError?.(`Recording not supported: ${e.message}`);
            return;
        }
        this.chunks = [];
        this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
        this.recorder.onstop = () => {
            const type = this.recorder.mimeType || 'video/webm';
            const blob = new Blob(this.chunks, { type });
            const a = document.createElement('a');
            const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
            a.href = URL.createObjectURL(blob);
            a.download = `fluoddity-dj-${stamp}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
            this.onRecordingChange?.(false);
        };
        this.recorder.start(1000);
        this.onRecordingChange?.(true);
    }

    stopRecording() {
        if (this.recording) this.recorder.stop();
    }
}
