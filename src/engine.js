// FluoddityEngine: GPU particle physics (fragment-shader GPGPU) + the render
// stack (particles, flow field, echo feedback, bloom, final composite).
//
// Physics per step:  sim (particles read trail field) → brush (particles stamp
// their velocity) → canvas (diffuse/decay + brush + music ink).

import { createProgram, createTarget, createTexture, deleteTarget, bindTarget } from './gl.js';
import * as S from './shaders.js';

const MIP_LEVELS = 5;

export function worldConstants(worldSize, aspect) {
    const sqrtWS = Math.sqrt(worldSize);
    const count = Math.floor(600000 * worldSize);
    const f = Math.sqrt(aspect);
    const canvasW = Math.floor(1024 * f * sqrtWS);
    const canvasH = Math.floor((1024 / f) * sqrtWS);
    const ca = canvasW / canvasH;
    const texW = Math.ceil(Math.sqrt(count));
    const texH = Math.ceil(count / texW);
    return { worldSize, sqrtWS, count, canvasW, canvasH, texW, texH, edge: [Math.sqrt(ca), 1 / Math.sqrt(ca)] };
}

export class FluoddityEngine {
    constructor(gl) {
        this.gl = gl;
        this.frame = 0;
        this.c = null;
        this.sim = null;      // [target, target] each with 2 attachments (state, aux)
        this.simPing = 0;
        this.canvas = null;   // [target, target]
        this.canvasPing = 0;
        this.brush = null;
        this.hdr = null;
        this.echo = null;
        this.echoPing = 0;
        this.mips = [];
        this.viewW = 0;
        this.viewH = 0;
    }

    init() {
        const gl = this.gl;
        if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This GPU/browser cannot render to float textures (EXT_color_buffer_float missing).');
        gl.getExtension('OES_texture_float_linear');
        this.floatBlend = !!gl.getExtension('EXT_float_blend');
        this.brushScale = this.floatBlend ? 1 : 64;

        this.p = {
            sim: createProgram(gl, S.QUAD_VS, S.SIM_FS, 'sim'),
            brush: createProgram(gl, S.BRUSH_VS, S.BRUSH_FS, 'brush'),
            canvas: createProgram(gl, S.QUAD_VS, S.CANVAS_FS, 'canvas'),
            particles: createProgram(gl, S.PARTICLE_VS, S.PARTICLE_FS, 'particles'),
            flow: createProgram(gl, S.QUAD_VS, S.FLOW_FS, 'flow'),
            echo: createProgram(gl, S.QUAD_VS, S.ECHO_FS, 'echo'),
            down: createProgram(gl, S.QUAD_VS, S.BLOOM_DOWN_FS, 'bloom-down'),
            up: createProgram(gl, S.QUAD_VS, S.BLOOM_UP_FS, 'bloom-up'),
            final: createProgram(gl, S.QUAD_VS, S.FINAL_FS, 'final'),
            sortKey: createProgram(gl, S.QUAD_VS, S.SORT_KEY_FS, 'sort-key'),
            gather: createProgram(gl, S.QUAD_VS, S.GATHER_FS, 'gather'),
        };
        this.sortWorker = new Worker(new URL('./sort-worker.js', import.meta.url));
        this.sortWorker.onmessage = ({ data }) => {
            if (data.gen !== this.sortGen || this.sortState !== 'sorting') return;
            this.sortPerm = data.perm;
            this.sortState = 'ready';
        };
        this.sortState = 'idle';
        this.sortGen = 0;
        this.lastSort = 0;
        this.sortInterval = 900; // ms

        this.quadVAO = gl.createVertexArray();
        gl.bindVertexArray(this.quadVAO);
        const vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        this.emptyVAO = gl.createVertexArray();
        gl.bindVertexArray(null);

        this.spectrumTex = createTexture(gl, 64, 1, { internal: gl.R32F, format: gl.RED, filter: gl.LINEAR });
        this.rulesTex = [null, null];
        this.rulesCap = [0, 0];
        this.maxStride = 4;
        this.brushPhase = 0;
    }

    // Upload one deck's per-tribe rules (see rule.js cohortRules).
    setDeckRules(side, data, cohorts) {
        const gl = this.gl;
        if (this.rulesCap[side] < cohorts) {
            if (this.rulesTex[side]) gl.deleteTexture(this.rulesTex[side]);
            const cap = Math.max(128, cohorts);
            this.rulesTex[side] = createTexture(gl, 20, cap);
            this.rulesCap[side] = cap;
        }
        gl.bindTexture(gl.TEXTURE_2D, this.rulesTex[side]);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 20, cohorts, gl.RGBA, gl.FLOAT, data);
    }

    // (Re)allocate the simulation at a given world size. Resets the sim.
    configure(worldSize, aspect) {
        const gl = this.gl;
        this._destroySim();
        const c = (this.c = worldConstants(worldSize, aspect));
        const simOpts = { attachments: [{}, {}] };
        this.sim = [createTarget(gl, c.texW, c.texH, simOpts), createTarget(gl, c.texW, c.texH, simOpts)];
        // Trail field: velocity only (RG), full float so slow decays don't stall.
        const canvasOpts = { internal: gl.RG32F, format: gl.RG, filter: gl.LINEAR, wrap: gl.REPEAT };
        this.canvas = [createTarget(gl, c.canvasW, c.canvasH, canvasOpts), createTarget(gl, c.canvasW, c.canvasH, canvasOpts)];
        this.brush = createTarget(gl, c.canvasW, c.canvasH, this.floatBlend
            ? { internal: gl.RG32F, format: gl.RG }
            : { internal: gl.RG16F, format: gl.RG, type: gl.HALF_FLOAT });
        this.simPing = 0;
        this.canvasPing = 0;
        this.frame = 0;

        // Spatial sort resources
        this.keyW = Math.ceil(c.texW / 4);
        this.keyTarget = createTarget(gl, this.keyW, c.texH);
        this.permTex = createTexture(gl, c.texW, c.texH, { internal: gl.R32F, format: gl.RED });
        this.sortPBO = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.sortPBO);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, this.keyW * c.texH * 16, gl.STREAM_READ);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        this.sortGrid = [Math.ceil(c.canvasW / 32), Math.ceil(c.canvasH / 32)];
        this.sortGen++;
        this.sortState = 'idle';
        this.lastSort = performance.now() - this.sortInterval + 150;
    }

    // Asynchronous spatial re-sort, advanced a little every frame:
    // key pass → PBO readback → worker counting sort → gather pass.
    _sortTick() {
        const gl = this.gl;
        const c = this.c;
        const now = performance.now();
        if (this.sortState === 'idle' && now - this.lastSort > this.sortInterval) {
            const kp = this.p.sortKey.use();
            bindTarget(gl, this.keyTarget);
            kp.tex('u_state', 0, this.sim[this.simPing].textures[0]).set('u_texW', c.texW).set('u_count', c.count)
              .set('u_edge', c.edge).set('u_grid', this.sortGrid);
            this._quad();
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.sortPBO);
            gl.readPixels(0, 0, this.keyW, c.texH, gl.RGBA, gl.FLOAT, 0);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
            this.sortFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            gl.flush();
            this.sortState = 'reading';
            this.sortReadAt = now;
        } else if (this.sortState === 'reading') {
            // Fences can stay unsignalled while the page is hidden (nothing is
            // presented); after a grace period just read — it blocks briefly.
            const st = gl.clientWaitSync(this.sortFence, 0, 0);
            if (st === gl.TIMEOUT_EXPIRED && now - this.sortReadAt < 400) return;
            gl.deleteSync(this.sortFence);
            const keys = new Float32Array(this.keyW * c.texH * 4);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.sortPBO);
            gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, keys);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
            this.sortState = 'sorting';
            this.sortWorker.postMessage({ keys, count: c.count, texW: c.texW, texH: c.texH, rowStride: this.keyW * 4,
                nkeys: this.sortGrid[0] * this.sortGrid[1], gen: this.sortGen }, [keys.buffer]);
        } else if (this.sortState === 'ready') {
            gl.bindTexture(gl.TEXTURE_2D, this.permTex);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, c.texW, c.texH, gl.RED, gl.FLOAT, this.sortPerm);
            this.sortPerm = null;
            const read = this.sim[this.simPing], write = this.sim[1 - this.simPing];
            const gp = this.p.gather.use();
            bindTarget(gl, write);
            gp.tex('u_state', 0, read.textures[0]).tex('u_aux', 1, read.textures[1]).tex('u_perm', 2, this.permTex).set('u_texW', c.texW);
            this._quad();
            this.simPing = 1 - this.simPing;
            this.sortState = 'idle';
            this.lastSort = now;
        }
    }

    // Run a full sort cycle now (used by calibration).
    async sortNow() {
        this.lastSort = 0;
        for (let i = 0; i < 400; i++) {
            this._sortTick();
            if (this.sortState === 'idle' && this.lastSort > 0) return;
            await new Promise((r) => setTimeout(r, 4));
        }
    }

    _destroySim() {
        const gl = this.gl;
        deleteTarget(gl, this.keyTarget);
        if (this.permTex) gl.deleteTexture(this.permTex);
        if (this.sortPBO) gl.deleteBuffer(this.sortPBO);
        if (this.sortState === 'reading' && this.sortFence) gl.deleteSync(this.sortFence);
        this.sim?.forEach((t) => deleteTarget(gl, t));
        this.canvas?.forEach((t) => deleteTarget(gl, t));
        deleteTarget(gl, this.brush);
    }

    _ensureView() {
        const gl = this.gl;
        const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
        if (w === this.viewW && h === this.viewH) return;
        deleteTarget(gl, this.hdr);
        this.echo?.forEach((t) => deleteTarget(gl, t));
        this.mips.forEach((t) => deleteTarget(gl, t));
        const hdrOpts = { internal: gl.RGBA16F, type: gl.HALF_FLOAT, filter: gl.LINEAR };
        this.hdr = createTarget(gl, w, h, hdrOpts);
        this.echo = [createTarget(gl, w, h, hdrOpts), createTarget(gl, w, h, hdrOpts)];
        for (const t of this.echo) { bindTarget(gl, t); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
        this.mips = [];
        let mw = w, mh = h;
        for (let i = 0; i < MIP_LEVELS; i++) {
            mw = Math.max(1, mw >> 1);
            mh = Math.max(1, mh >> 1);
            this.mips.push(createTarget(gl, mw, mh, hdrOpts));
        }
        this.viewW = w;
        this.viewH = h;
    }

    reset() { this.frame = 0; }

    setSpectrum(arr64) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.spectrumTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 1, gl.RED, gl.FLOAT, arr64);
    }

    _quad() {
        const gl = this.gl;
        gl.bindVertexArray(this.quadVAO);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // Run `steps` physics iterations with one parameter set `u` (see main.js buildSimUniforms).
    advance(u, steps) {
        if (this.frame > 0) this._sortTick();
        if (steps <= 0) return;
        const inv = 1 / steps;
        // Per-frame quantities are spread across substeps
        const perStep = {
            swirl: u.swirl * inv,
            breathe: u.breathe * inv,
            jitter: u.jitter * Math.sqrt(inv),
            rebirth: 1 - Math.pow(1 - Math.min(u.rebirth, 0.999), inv),
        };
        for (let i = 0; i < steps; i++) this._step(u, perStep);
    }

    _step(u, ps) {
        const gl = this.gl;
        const c = this.c;
        const readSim = this.sim[this.simPing], writeSim = this.sim[1 - this.simPing];
        const readCan = this.canvas[this.canvasPing], writeCan = this.canvas[1 - this.canvasPing];

        // 1) particles
        const sp = this.p.sim.use();
        bindTarget(gl, writeSim);
        sp.tex('u_state', 0, readSim.textures[0]).tex('u_aux', 1, readSim.textures[1]).tex('u_canvas', 2, readCan.tex);
        sp.set('u_frame', this.frame).set('u_count', c.count).set('u_texW', c.texW).set('u_sqrtWS', c.sqrtWS).set('u_edge', c.edge);
        sp.set('u_sensorGain', u.sensorGain).set('u_sensorAngle', u.sensorAngle).set('u_sensorDist', u.sensorDist)
          .set('u_forceMult', u.forceMult).set('u_drag', u.drag).set('u_strafe', u.strafe)
          .set('u_axial', u.axial).set('u_lateral', u.lateral).set('u_hazard', u.hazard).set('u_symmetry', u.symmetry)
          .set('u_boundary', u.boundary).set('u_resetMode', u.resetMode).set('u_resetCohorts', u.resetCohorts);
        const A = u.deckA, B = u.deckB;
        sp.tex('u_rulesA', 3, this.rulesTex[0]).tex('u_rulesB', 4, this.rulesTex[1]);
        sp.set('u_cohortsA', A.cohorts).set('u_orientA', A.orient).set('u_hueA', A.hue);
        sp.set('u_cohortsB', B.cohorts).set('u_orientB', B.orient).set('u_hueB', B.hue);
        sp.set('u_xfade', u.xfade);
        sp.set('u_swirl', ps.swirl).set('u_breathe', ps.breathe)
          .set('u_jitter', ps.jitter).set('u_rebirth', ps.rebirth).set('u_swirlCenter', u.swirlCenter);
        this._quad();

        // 2) brush
        const bp = this.p.brush.use();
        bindTarget(gl, this.brush);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        // Trail memory in steps ≈ 1/(1-p); subsample stamping when it is long.
        const p = Math.min(u.persist, 0.999);
        const stride = Math.max(1, Math.min(this.maxStride, Math.floor(1 / (1 - p) / 12)));
        const phase = this.brushPhase++ % stride;
        bp.tex('u_state', 0, writeSim.textures[0]).set('u_texW', c.texW).set('u_edge', c.edge)
          .set('u_stride', stride).set('u_phase', phase).set('u_pointPx', 2 * 0.0015 * c.canvasH / (2 * c.edge[1]) / c.sqrtWS)
          .set('u_weight', (1 - p) * stride * this.brushScale);
        gl.bindVertexArray(this.emptyVAO);
        gl.drawArrays(gl.POINTS, 0, Math.floor((c.count - phase + stride - 1) / stride));
        gl.disable(gl.BLEND);

        // 3) trail field
        const cp = this.p.canvas.use();
        bindTarget(gl, writeCan);
        cp.tex('u_canvas', 0, readCan.tex).tex('u_brush', 1, this.brush.tex).tex('u_spectrum', 2, this.spectrumTex);
        cp.set('u_frame', this.frame).set('u_persist', u.persist).set('u_diffusion', u.diffusion)
          .set('u_brushScale', this.brushScale).set('u_boundary', u.boundary).set('u_edge', c.edge);
        cp.set('u_stroke', u.strokes).set('u_strokeP', u.strokeP).set('u_strokeCount', u.strokeCount);
        cp.set('u_shock', u.shockInk).set('u_shockWidth', u.shockWidth);
        cp.set('u_specInk', u.specInk).set('u_specRadius', u.specRadius).set('u_specRot', u.specRot).set('u_specMode', u.specMode);
        this._quad();

        this.simPing = 1 - this.simPing;
        this.canvasPing = 1 - this.canvasPing;
        this.frame++;
    }

    fitScale() {
        const gl = this.gl;
        const a = gl.drawingBufferWidth / gl.drawingBufferHeight;
        const ca = this.c.edge[0] / this.c.edge[1];
        return [Math.max(1, ca / a), Math.max(1, a / ca)];
    }

    render(r) {
        const gl = this.gl;
        const c = this.c;
        this._ensureView();
        const fit = this.fitScale();
        const sim = this.sim[this.simPing];

        // Scene into HDR
        bindTarget(gl, this.hdr);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        if (r.flow > 0.001) {
            const fp = this.p.flow.use();
            fp.tex('u_canvas', 0, this.canvas[this.canvasPing].tex).set('u_edge', c.edge).set('u_camPos', r.camPos)
              .set('u_camZoom', r.camZoom).set('u_fit', fit).set('u_amount', r.flow).set('u_hueShift', r.hueShift)
              .set('u_boundary', r.boundary).set('u_palette', r.palette).set('u_satur', r.satur);
            this._quad();
        }
        const pp = this.p.particles.use();
        pp.tex('u_state', 0, sim.textures[0]).tex('u_aux', 1, sim.textures[1]);
        // Sprite diameter: upstream's 1.5 * 0.0015/sqrt(ws) half-size in world units, in pixels
        const pxPerWorld = (this.viewH / 2) / c.edge[1] * r.camZoom * fit[1];
        const rawPx = 2 * 1.5 * 0.0015 / c.sqrtWS * r.size * pxPerWorld / Math.sqrt(r.camZoom);
        const pointPx = Math.max(1, rawPx);
        pp.set('u_texW', c.texW).set('u_edge', c.edge).set('u_camPos', r.camPos)
          .set('u_camZoom', r.camZoom).set('u_fit', fit).set('u_xfade', r.xfade).set('u_hueShift', r.hueShift)
          .set('u_colorMode', r.colorMode).set('u_speedScale', 1 / c.sqrtWS).set('u_pointPx', pointPx).set('u_spawnGlow', r.spawnGlow)
          .set('u_brightness', r.brightness * (rawPx / pointPx) ** 2).set('u_palette', r.palette).set('u_satur', r.satur);
        gl.bindVertexArray(this.emptyVAO);
        gl.drawArrays(gl.POINTS, 0, c.count);
        gl.disable(gl.BLEND);

        // Echo feedback
        const aspect = [this.viewW / Math.max(this.viewW, this.viewH), this.viewH / Math.max(this.viewW, this.viewH)];
        let scene = this.hdr;
        if (r.echo.decay > 0.001) {
            const out = this.echo[this.echoPing], prev = this.echo[1 - this.echoPing];
            const ep = this.p.echo.use();
            bindTarget(gl, out);
            ep.tex('u_cur', 0, this.hdr.tex).tex('u_prev', 1, prev.tex).set('u_decay', Math.min(r.echo.decay, 0.97))
              .set('u_zoom', r.echo.zoom).set('u_rot', r.echo.rot).set('u_aspect', aspect);
            this._quad();
            this.echoPing = 1 - this.echoPing;
            scene = out;
        }

        // Bloom
        const dp = this.p.down.use();
        for (let i = 0; i < MIP_LEVELS; i++) {
            const src = i === 0 ? scene : this.mips[i - 1];
            bindTarget(gl, this.mips[i]);
            dp.tex('u_src', 0, src.tex).set('u_texel', [1 / src.w, 1 / src.h]).set('u_first', i === 0 ? 1 : 0)
              .set('u_threshold', r.bloom.threshold);
            this._quad();
        }
        const up = this.p.up.use();
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        for (let i = MIP_LEVELS - 1; i > 0; i--) {
            bindTarget(gl, this.mips[i - 1]);
            up.tex('u_src', 0, this.mips[i].tex).set('u_texel', [1 / this.mips[i].w, 1 / this.mips[i].h]);
            this._quad();
        }
        gl.disable(gl.BLEND);

        // Final
        const f = r.final;
        const fin = this.p.final.use();
        bindTarget(gl, null);
        fin.tex('u_hdr', 0, scene.tex).tex('u_bloom', 1, this.mips[0].tex).set('u_aspect', aspect)
           .set('u_bloomStrength', r.bloom.strength).set('u_ca', f.ca).set('u_flash', f.flash).set('u_exposure', f.exposure)
           .set('u_vignette', f.vignette).set('u_fade', f.fade).set('u_kaleido', f.kaleido).set('u_kaleidoRot', f.kaleidoRot)
           .set('u_time', r.time % 1000).set('u_ripple', r.ripple).set('u_screenAspect', this.viewW / this.viewH);
        this._quad();
    }

    // Particle state for click-to-select: {state: (x,y,vx,vy)*, aux: (hueA,hueB,age,identity)*}
    readState() {
        const gl = this.gl;
        const c = this.c;
        const t = this.sim[this.simPing];
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        const read = (i) => {
            gl.readBuffer(gl.COLOR_ATTACHMENT0 + i);
            const d = new Float32Array(c.texW * c.texH * 4);
            gl.readPixels(0, 0, c.texW, c.texH, gl.RGBA, gl.FLOAT, d);
            return d;
        };
        const state = read(0), aux = read(1);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { state, aux };
    }

    // Blocks until the GPU has finished queued work (calibration only).
    sync() {
        const gl = this.gl;
        const buf = new Float32Array(4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.sim[this.simPing].fbo);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, buf);
        gl.finish();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // Screen (css px, relative to canvas rect) → entity space
    screenToWorld(x01, y01, camPos, camZoom) {
        const fit = this.fitScale();
        const ndc = [x01 * 2 - 1, 1 - y01 * 2];
        return [
            (ndc[0] / (camZoom * fit[0])) * this.c.edge[0] + camPos[0],
            (ndc[1] / (camZoom * fit[1])) * this.c.edge[1] + camPos[1],
        ];
    }
}
