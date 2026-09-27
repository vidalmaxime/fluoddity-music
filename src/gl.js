// Small WebGL2 helpers: program compilation, render targets, uniform setting.

export function createProgram(gl, vsSource, fsSource, name = 'program') {
    const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(s);
            gl.deleteShader(s);
            throw new Error(`[${name}] ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader failed:\n${log}`);
        }
        return s;
    };
    const vs = compile(gl.VERTEX_SHADER, vsSource);
    const fs = compile(gl.FRAGMENT_SHADER, fsSource);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error(`[${name}] link failed:\n${gl.getProgramInfoLog(p)}`);
    }
    return wrapProgram(gl, p);
}

// Wraps a program with a cached, type-aware uniform setter.
function wrapProgram(gl, program) {
    const info = new Map();
    const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
        const u = gl.getActiveUniform(program, i);
        const base = u.name.replace(/\[0\]$/, '');
        info.set(base, { type: u.type, size: u.size, loc: gl.getUniformLocation(program, u.name) });
    }
    const T = gl;
    return {
        program,
        use() { gl.useProgram(program); return this; },
        has(name) { return info.has(name); },
        // Missing uniforms are silently ignored (the GLSL compiler strips unused ones).
        set(name, v) {
            const u = info.get(name);
            if (!u) return this;
            const l = u.loc;
            switch (u.type) {
                case T.FLOAT: u.size > 1 ? gl.uniform1fv(l, v) : gl.uniform1f(l, v); break;
                case T.FLOAT_VEC2: gl.uniform2fv(l, v); break;
                case T.FLOAT_VEC3: gl.uniform3fv(l, v); break;
                case T.FLOAT_VEC4: gl.uniform4fv(l, v); break;
                case T.INT: case T.BOOL: case T.SAMPLER_2D:
                    u.size > 1 ? gl.uniform1iv(l, v) : gl.uniform1i(l, typeof v === 'boolean' ? (v ? 1 : 0) : v); break;
                default: throw new Error(`Unhandled uniform type for ${name}`);
            }
            return this;
        },
        tex(name, unit, texture) {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            return this.set(name, unit);
        },
    };
}

export function createTexture(gl, w, h, { internal = gl.RGBA32F, format = gl.RGBA, type = gl.FLOAT, filter = gl.NEAREST, wrap = gl.CLAMP_TO_EDGE, data = null } = {}) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return t;
}

export function createTarget(gl, w, h, opts = {}) {
    const textures = (opts.attachments || [opts]).map((o) => createTexture(gl, w, h, { ...opts, ...o }));
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    textures.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    if (textures.length > 1) gl.drawBuffers(textures.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Framebuffer incomplete: 0x${status.toString(16)}`);
    return { fbo, tex: textures[0], textures, w, h };
}

export function deleteTarget(gl, t) {
    if (!t) return;
    t.textures.forEach((x) => gl.deleteTexture(x));
    gl.deleteFramebuffer(t.fbo);
}

export function bindTarget(gl, target) {
    if (target) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.viewport(0, 0, target.w, target.h);
    } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    }
}
