// All GLSL for the engine.
//
// Entity space follows upstream Fluoddity: x in [-ex, ex], y in [-ey, ey] with
// ex = sqrt(aspect), ey = 1/sqrt(aspect), so the world area is always 4 and
// canvas uv = p / (2 * edge) + 0.5.

const HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
#define PI 3.14159265
`;

const HASH = /* glsl */ `
uint pcg_hash(uint seed) {
    uint state = seed * 747796405u + 2891336453u;
    uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}
float hash(vec2 co) {
    uvec2 u = uvec2(floatBitsToUint(co.x), floatBitsToUint(co.y));
    uint h = pcg_hash(u.x ^ pcg_hash(u.y));
    return float(h) / float(0xffffffffu);
}
vec4 hash4(vec2 co) {
    return vec4(hash(co), hash(co * -1.0 + 5.0), hash(co.yx - 100.0), hash(co.yx * -1.0 + 25.0));
}
`;

export const QUAD_VS = HEADER + /* glsl */ `
layout(location = 0) in vec2 a_pos;
out vec2 uv;
void main() {
    uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// ─── Physics: one fragment per particle ──────────────────────────────────────
// Each tribe's (mutated) rule is precomputed on the CPU into a 20 x cohorts
// texture per deck (texel 2i = frequency, 2i+1 = amplitude of centre i), so
// the per-particle cost is just the two sensor taps and the Fourier network.
export const SIM_FS = HEADER + HASH + /* glsl */ `
uniform sampler2D u_state;   // pos.xy, vel.zw
uniform sampler2D u_aux;     // hueA, hueB, age, identity (original index — slots get spatially re-sorted)
uniform sampler2D u_canvas;  // trail field: vel.xy
uniform sampler2D u_rulesA;
uniform sampler2D u_rulesB;

uniform int u_frame;
uniform int u_count;
uniform int u_texW;
uniform float u_sqrtWS;
uniform vec2 u_edge;

// Blended + audio-modulated physics
uniform float u_sensorGain, u_sensorAngle, u_sensorDist, u_forceMult, u_drag;
uniform float u_strafe, u_axial, u_lateral, u_hazard, u_symmetry;
uniform int u_boundary;      // 0 bounce, 1 reset, 2 wrap
uniform int u_resetMode;     // 0 grid, 1 random, 2 ring
uniform int u_resetCohorts;

uniform int u_cohortsA, u_cohortsB;
uniform vec2 u_orientA, u_orientB;  // (mode, mix)
uniform vec2 u_hueA, u_hueB;        // (colorByCohort, hueSensitivity)
uniform float u_xfade;

// Music forces
uniform float u_swirl;       // rotational push around the centre
uniform float u_breathe;     // radial push (+out / -in)
uniform float u_jitter;      // lateral shimmer
uniform float u_rebirth;     // extra respawn probability this step
uniform vec2 u_swirlCenter;

in vec2 uv;
layout(location = 0) out vec4 o_state;
layout(location = 1) out vec4 o_aux;

vec4 basis(float phase, float aw, float i) {
    float off = 2.0 * i * 0.6283 + aw * 3.14159;
    return vec4(sin(phase + off), cos(phase + off * 0.7), sin(phase * 2.0 + off * 1.3), cos(phase * 2.0 + off * 0.5));
}

void pR(inout vec2 p, float a) { p = cos(a) * p + sin(a) * vec2(p.y, -p.x); }
vec2 safenorm(vec2 p) { return length(p) == 0.0 ? vec2(0.0) : normalize(p); }
vec2 y_reflect(vec2 p) { return p * vec2(1.0, -1.0); }
float edgeflect(float x) { return sign(x) * (1.0 - abs(1.0 - abs(x))); }

vec4 get_can(vec2 p) {
    vec2 cuv = p / (2.0 * u_edge) + 0.5;
    if (u_boundary == 2) cuv = fract(cuv);
    return texture(u_canvas, cuv);
}

vec2 wrap_delta(vec2 d) {
    if (u_boundary == 2) d -= 2.0 * u_edge * floor(d / (2.0 * u_edge) + 0.5);
    return d;
}

vec4 do_reset(int index) {
    float cohorts = float(u_resetCohorts);
    float cohort_val = cohorts * float(index) / float(u_count);
    float aspect = u_edge.x; // sqrt(canvas aspect)
    vec2 pos = 0.019 * vec2(hash(vec2(cohort_val)), hash(vec2(cohort_val + float(index) + 2.142)));
    vec2 vel = 0.00005 * (vec2(hash(vec2(cohort_val, float(index))), hash(vec2(cohort_val, pos.y))) * 2.0 - 1.0);
    if (u_resetMode == 0) {
        float spot_rows = ceil(aspect * sqrt(cohorts));
        vec2 cell = vec2(float(int(cohort_val) % int(spot_rows)), float(int(cohort_val) / int(spot_rows)));
        pos += 1.8 * (cell / spot_rows) * vec2(aspect);
        pos += 1.8 * (0.5 * (1.0 / vec2(spot_rows, cohorts / spot_rows) - 1.0)) * vec2(aspect, 1.0 / aspect);
    } else if (u_resetMode == 1) {
        pos = vec2(hash(vec2(cohort_val, 1.0)), hash(vec2(cohort_val, 2.0))) * 2.0 - 1.0;
        pos *= u_edge;
    } else {
        float angle = cohort_val / cohorts * 2.0 * PI;
        pos += vec2(cos(angle), sin(angle)) * 0.5;
    }
    return vec4(pos, vel);
}

vec2 orient(vec2 o, vec2 mode_mix, vec2 pos, float w) {
    if (mode_mix.x < 0.5) return o;
    vec2 target = mode_mix.x < 1.5 ? vec2(0.0, 1.0) : -safenorm(pos);
    return mix(o, target, mode_mix.y * w);
}

void main() {
    ivec2 px = ivec2(gl_FragCoord.xy);
    int slot = px.y * u_texW + px.x;
    if (slot >= u_count) { o_state = vec4(1e4); o_aux = vec4(0.0, 0.0, 0.0, float(slot)); return; }

    vec4 e = texelFetch(u_state, px, 0);
    vec4 aux = texelFetch(u_aux, px, 0);
    if (u_frame == 0) aux.w = float(slot);
    int index = int(aux.w);
    vec2 pos = e.xy, vel = e.zw;
    float fi = float(index) / float(u_count);

    float h = hash(vec2(fi, float(u_frame)));
    if (u_frame == 0 || h < u_hazard + u_rebirth) {
        o_state = do_reset(index);
        o_aux = vec4(aux.xy, 0.0, aux.w);
        return;
    }

    float cohortA = float(u_cohortsA) * fi;
    float cohortB = float(u_cohortsB) * fi;
    int rowA = int(cohortA), rowB = int(cohortB);

    // Sensors
    float sample_dist = 1.0 / u_sqrtWS * 0.005 * u_sensorDist;
    vec2 o = safenorm(vel);
    o = orient(o, u_orientA, pos, 1.0 - u_xfade);
    o = orient(o, u_orientB, pos, u_xfade);
    vec2 lo = o * sample_dist, ro = o * sample_dist;
    pR(lo, u_sensorAngle * PI);
    pR(ro, -u_sensorAngle * PI);
    float gain = u_sqrtWS * 38.855 * u_sensorGain;
    vec2 L = get_can(pos + lo).xy * gain;
    vec2 R = get_can(pos + ro).xy * gain;

    // Behaviour: Fourier network in the local frame, mirrored for chiral symmetry.
    // During a crossfade the rule coefficients morph between the two decks.
    vec2 fwd = safenorm(o);
    vec2 left = vec2(fwd.y, -fwd.x);
    L = vec2(dot(L, fwd), dot(L, left));
    R = vec2(dot(R, fwd), dot(R, left));
    vec4 sb = vec4(L, R);
    vec4 sm = vec4(y_reflect(R), y_reflect(L));
    vec4 base = vec4(0.0), mirror = vec4(0.0);
    for (int i = 0; i < 10; i++) {
        vec4 F, A;
        if (u_xfade <= 0.0) {
            F = texelFetch(u_rulesA, ivec2(2 * i, rowA), 0);
            A = texelFetch(u_rulesA, ivec2(2 * i + 1, rowA), 0);
        } else if (u_xfade >= 1.0) {
            F = texelFetch(u_rulesB, ivec2(2 * i, rowB), 0);
            A = texelFetch(u_rulesB, ivec2(2 * i + 1, rowB), 0);
        } else {
            F = mix(texelFetch(u_rulesA, ivec2(2 * i, rowA), 0), texelFetch(u_rulesB, ivec2(2 * i, rowB), 0), u_xfade);
            A = mix(texelFetch(u_rulesA, ivec2(2 * i + 1, rowA), 0), texelFetch(u_rulesB, ivec2(2 * i + 1, rowB), 0), u_xfade);
        }
        float fi_ = float(i);
        base += A * basis(dot(sb, F), A.w, fi_);
        mirror += A * basis(dot(sm, F), A.w, fi_);
    }
    mirror *= u_symmetry;
    vec2 f = base.xy + y_reflect(mirror.xy);
    vec2 s = base.zw + y_reflect(mirror.zw);
    vec2 force = fwd * f.x * u_axial + left * f.y * u_lateral;
    vec2 strafe = fwd * s.x * u_axial + left * s.y * u_lateral;
    vec2 colp = base.xy + mirror.xy;

    force *= 1.0 / u_sqrtWS * u_forceMult / 400.0;
    strafe *= 1.0 / u_sqrtWS * u_forceMult / 20.0;

    vel = vel * u_drag + force;
    pos += vel;
    pos += strafe * u_strafe;

    // ── Music forces (displacements so they read the same under any drag) ──
    if (u_swirl != 0.0 || u_breathe != 0.0) {
        vec2 d = wrap_delta(pos - u_swirlCenter);
        float r = length(d);
        float fall = exp(-r * r * 0.9);
        pos += vec2(-d.y, d.x) * u_swirl * fall;
        pos += d * u_breathe * fall;
    }
    if (u_jitter > 0.0) {
        float j = hash(vec2(fi * 7.31, float(u_frame) * 0.618)) * 2.0 - 1.0;
        pos += left * j * u_jitter;
    }

    // Boundaries
    if (u_boundary == 0) {
        if (pos.x < -u_edge.x || pos.x > u_edge.x) { vel.x = -vel.x; pos.x = edgeflect(pos.x / u_edge.x) * u_edge.x; }
        if (pos.y < -u_edge.y || pos.y > u_edge.y) { vel.y = -vel.y; pos.y = edgeflect(pos.y / u_edge.y) * u_edge.y; }
        pos = clamp(pos, -u_edge, u_edge);
    } else if (u_boundary == 1) {
        if (any(greaterThan(abs(pos), u_edge))) {
            o_state = do_reset(index);
            o_aux = vec4(aux.xy, 0.0, aux.w);
            return;
        }
    } else {
        pos = u_edge * 2.0 * (fract(pos / (u_edge * 2.0) - 0.5) - 0.5);
    }

    // Colour parameters for each deck (renderer crossfades them)
    float hueA = u_hueA.x > 0.5 ? hash(vec2(floor(cohortA))) : u_hueA.y * colp.x;
    float hueB = u_hueB.x > 0.5 ? hash(vec2(floor(cohortB))) : u_hueB.y * colp.x;
    o_state = vec4(pos, vel);
    o_aux = vec4(hueA, hueB, min(aux.z + 1.0, 1e5), aux.w);
}`;

// ─── Trail deposition: every particle stamps its velocity onto the canvas ────
// Drawn as points. With u_stride k > 1 only every k-th particle (rotating
// phase) stamps each step, at k-times weight: same expected trail field,
// k-times cheaper. Only used when trails persist long enough to average it.
export const BRUSH_VS = HEADER + /* glsl */ `
uniform sampler2D u_state;
uniform int u_texW;
uniform int u_stride;
uniform int u_phase;
uniform vec2 u_edge;
uniform float u_pointPx;
out vec2 v_vel;
void main() {
    int id = gl_VertexID * u_stride + u_phase;
    vec4 e = texelFetch(u_state, ivec2(id % u_texW, id / u_texW), 0);
    v_vel = e.zw;
    gl_PointSize = u_pointPx;
    gl_Position = vec4(e.xy / u_edge, 0.0, 1.0);
}`;

export const BRUSH_FS = HEADER + /* glsl */ `
in vec2 v_vel;
uniform float u_weight;   // (1 - persistence) * stride * scale * area correction
out vec4 o;
void main() {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;
    float s2 = 0.163 * 0.163;
    float k = exp(-dot(c, c) / (2.0 * s2)) / (2.0 * PI * s2);
    float w = u_weight * k * k;
    o = vec4(v_vel * w, 0.0, 0.0);
}`;

// ─── Trail field update: diffuse, decay, add brush + music ink ───────────────
export const CANVAS_FS = HEADER + /* glsl */ `
uniform sampler2D u_canvas;
uniform sampler2D u_brush;
uniform sampler2D u_spectrum;   // 64x1, 0..1
uniform int u_frame;
uniform float u_persist, u_diffusion, u_brushScale;
uniform int u_boundary;
uniform vec2 u_edge;

uniform vec4 u_stroke[6];       // pos.xy, prev.xy (entity space)
uniform vec2 u_strokeP[6];      // radius, power
uniform int u_strokeCount;

uniform vec4 u_shock[4];        // center, radius, ink strength
uniform float u_shockWidth;

uniform float u_specInk, u_specRadius, u_specRot;
uniform int u_specMode;         // 0 tangential (orbit), 1 radial (pulse)

in vec2 uv;
out vec4 o;

vec4 can(vec2 p) { return texture(u_canvas, u_boundary == 2 ? fract(p) : p); }

vec2 wrap_delta(vec2 d) {
    if (u_boundary == 2) d -= 2.0 * u_edge * floor(d / (2.0 * u_edge) + 0.5);
    return d;
}

void main() {
    if (u_frame < 1) { o = vec4(0.0); return; }
    vec4 c;
    if (u_diffusion > 0.0) {
        float K = u_diffusion * u_diffusion;
        K = 4.0 / (pow(5.0, K) - 1.0);
        vec2 t = 1.0 / vec2(textureSize(u_canvas, 0));
        c = (can(uv) * K + can(uv + vec2(0.0, t.y)) + can(uv - vec2(0.0, t.y))
             + can(uv + vec2(t.x, 0.0)) + can(uv - vec2(t.x, 0.0))) / (4.0 + K);
    } else {
        c = texture(u_canvas, uv);
    }
    float p = clamp(u_persist, 0.0, 0.999);
    o = c * p + texture(u_brush, uv) / u_brushScale;

    vec2 pos = (uv * 2.0 - 1.0) * u_edge;
    float inkScale = 1.0 - p;

    // Strokes: mouse drawing and the beat-locked emitters
    for (int i = 0; i < 6; i++) {
        if (i >= u_strokeCount) break;
        vec2 d = wrap_delta(pos - u_stroke[i].xy);
        float r = u_strokeP[i].x;
        float k = exp(-dot(d, d) / (2.0 * r * r));
        vec2 v = u_stroke[i].xy - u_stroke[i].zw;
        o.xy += v * u_strokeP[i].y * k / (r * 60.0) * inkScale;
    }

    // Kick shock rings written into the field: particles *react* to them via their rule
    for (int i = 0; i < 4; i++) {
        vec4 sh = u_shock[i];
        if (sh.w == 0.0) continue;
        vec2 d = wrap_delta(pos - sh.xy);
        float r = length(d);
        float band = (r - sh.z) / u_shockWidth;
        float birth = smoothstep(0.0, 0.2, sh.z);   // no singular blob at the origin
        // Outward flow ahead of the ring, inward behind it: zero net flow, so
        // particles ripple through their own rule instead of being evacuated.
        o.xy += (r > 0.0 ? d / r : vec2(0.0)) * sh.w * birth * 2.0 * band * exp(-band * band) * inkScale;
    }

    // Spectrum ring: the live spectrum wrapped around a circle (mirrored)
    if (u_specInk > 0.0) {
        vec2 d = pos;
        float r = length(d);
        float a = atan(d.x, d.y) + u_specRot;
        float t = abs(fract(a / (2.0 * PI) + 0.5) * 2.0 - 1.0);   // 0 top .. 1 bottom, mirrored
        float mag = texture(u_spectrum, vec2(t * 0.98 + 0.01, 0.5)).r;
        float band = (r - u_specRadius * (1.0 + 0.35 * mag)) / 0.035;
        float k = exp(-band * band) * mag * mag;
        vec2 dir = r > 0.0 ? d / r : vec2(0.0);
        vec2 v = u_specMode == 0 ? vec2(-dir.y, dir.x) : dir;
        o.xy += v * k * u_specInk * inkScale;
    }
}`;

// ─── Particle rendering ──────────────────────────────────────────────────────
const PALETTE = /* glsl */ `
uniform int u_palette;
uniform float u_satur;
vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
vec3 cosPal(float t, vec3 a, vec3 b, vec3 c, vec3 d) { return a + b * cos(6.28318 * (c * t + d)); }
vec3 palette(float h) {
    if (u_palette == 1) return cosPal(h, vec3(.5), vec3(.5), vec3(1.), vec3(.0, .10, .20));              // spectral
    if (u_palette == 2) return cosPal(h, vec3(.55,.35,.35), vec3(.5,.35,.3), vec3(1.,.7,.4), vec3(0.,.15,.2)); // ember
    if (u_palette == 3) return cosPal(h, vec3(.3,.5,.65), vec3(.3,.35,.35), vec3(1.), vec3(.55,.6,.65));   // abyss
    if (u_palette == 4) return cosPal(h, vec3(.5), vec3(.5), vec3(2.,1.,0.), vec3(.5,.2,.25));            // neon acid
    if (u_palette == 5) { float v = .55 + .45 * cos(6.28318 * h); return vec3(v); }                      // mono
    return hsv2rgb(vec3(h, u_satur, 1.0));                                                                 // original
}
`;

export const PARTICLE_VS = HEADER + PALETTE + /* glsl */ `
uniform sampler2D u_state;
uniform sampler2D u_aux;
uniform int u_texW;
uniform vec2 u_edge;
uniform vec2 u_camPos;
uniform float u_camZoom;
uniform vec2 u_fit;            // aspect fit scale
uniform float u_xfade;
uniform float u_hueShift;
uniform int u_colorMode;       // 0 preset, 1 heading, 2 activity
uniform float u_pointPx;       // sprite diameter in pixels
uniform float u_spawnGlow;
uniform float u_speedScale;
out vec3 v_col;
void main() {
    int id = gl_VertexID;
    ivec2 tc = ivec2(id % u_texW, id / u_texW);
    vec4 e = texelFetch(u_state, tc, 0);
    vec4 aux = texelFetch(u_aux, tc, 0);
    vec2 ndc = (e.xy - u_camPos) / u_edge * u_camZoom * u_fit;
    gl_Position = vec4(ndc, 0.0, 1.0);
    gl_PointSize = u_pointPx;

    vec3 col;
    if (u_colorMode == 1) {
        col = palette(atan(e.w, e.z) / (2.0 * PI) + u_hueShift);
    } else if (u_colorMode == 2) {
        col = palette(0.18 * log2(1.0 + length(e.zw) * 2000.0 * u_speedScale) + u_hueShift);
    } else {
        col = mix(palette(aux.x + u_hueShift), palette(aux.y + u_hueShift), u_xfade);
    }
    // Freshly (re)born particles flash white — makes rebirth bursts visible
    col += vec3(u_spawnGlow * exp(-aux.z / 40.0));
    v_col = col;
}`;

export const PARTICLE_FS = HEADER + /* glsl */ `
in vec3 v_col;
uniform float u_brightness;
out vec4 o;
void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r2 = dot(c, c);
    if (r2 > 0.25) discard;
    float s2 = 0.163 * 0.163;
    float k = 0.5 * exp(-r2 / (2.0 * s2)) / (2.0 * PI * s2);
    o = vec4(v_col * u_brightness * 3.0 * 0.045 * k, 1.0);
}`;

// Flow layer: the invisible trail field made visible (hue = direction)
export const FLOW_FS = HEADER + PALETTE + /* glsl */ `
uniform sampler2D u_canvas;
uniform vec2 u_edge;
uniform vec2 u_camPos;
uniform float u_camZoom;
uniform vec2 u_fit;
uniform float u_amount;
uniform float u_hueShift;
uniform int u_boundary;
in vec2 uv;
out vec4 o;
void main() {
    vec2 ndc = uv * 2.0 - 1.0;
    vec2 p = ndc / (u_camZoom * u_fit) * u_edge + u_camPos;
    vec2 cuv = p / (2.0 * u_edge) + 0.5;
    if (u_boundary == 2) cuv = fract(cuv);
    else if (any(lessThan(cuv, vec2(0.0))) || any(greaterThan(cuv, vec2(1.0)))) { o = vec4(0.0); return; }
    vec4 c = texture(u_canvas, cuv);
    float m = length(c.xy) * 24.0;
    vec3 col = palette(atan(c.y, c.x) / (2.0 * PI) + u_hueShift) * m;
    float L = length(col);
    if (L > 0.0) col /= pow(L, 0.575);
    o = vec4(col * u_amount * 0.35, 1.0);
}`;

// Echo / feedback: previous frame, zoomed & rotated, decays under the new one
export const ECHO_FS = HEADER + /* glsl */ `
uniform sampler2D u_cur;
uniform sampler2D u_prev;
uniform float u_decay, u_zoom, u_rot;
uniform vec2 u_aspect;
in vec2 uv;
out vec4 o;
void main() {
    vec2 p = (uv - 0.5) * u_aspect;
    float c = cos(u_rot), s = sin(u_rot);
    p = mat2(c, -s, s, c) * p / u_zoom;
    vec2 puv = p / u_aspect + 0.5;
    vec3 prev = texture(u_prev, puv).rgb;
    float inside = step(0.0, puv.x) * step(puv.x, 1.0) * step(0.0, puv.y) * step(puv.y, 1.0);
    // max() keeps feedback trails from stacking into a white-out
    o = vec4(max(texture(u_cur, uv).rgb, prev * u_decay * inside), 1.0);
}`;

export const BLOOM_DOWN_FS = HEADER + /* glsl */ `
uniform sampler2D u_src;
uniform vec2 u_texel;
uniform float u_threshold;
uniform int u_first;
in vec2 uv;
out vec4 o;
void main() {
    vec3 a = texture(u_src, uv + u_texel * vec2(-0.5, -0.5)).rgb;
    vec3 b = texture(u_src, uv + u_texel * vec2(0.5, -0.5)).rgb;
    vec3 c = texture(u_src, uv + u_texel * vec2(-0.5, 0.5)).rgb;
    vec3 d = texture(u_src, uv + u_texel * vec2(0.5, 0.5)).rgb;
    vec3 col = (a + b + c + d) * 0.25;
    if (u_first == 1) {
        float br = max(col.r, max(col.g, col.b));
        col *= max(0.0, br - u_threshold) / max(br, 1e-4);
    }
    o = vec4(col, 1.0);
}`;

export const BLOOM_UP_FS = HEADER + /* glsl */ `
uniform sampler2D u_src;
uniform vec2 u_texel;
in vec2 uv;
out vec4 o;
void main() {
    vec3 s = vec3(0.0);
    s += texture(u_src, uv + u_texel * vec2(-1, -1)).rgb;
    s += texture(u_src, uv + u_texel * vec2(0, -1)).rgb * 2.0;
    s += texture(u_src, uv + u_texel * vec2(1, -1)).rgb;
    s += texture(u_src, uv + u_texel * vec2(-1, 0)).rgb * 2.0;
    s += texture(u_src, uv).rgb * 4.0;
    s += texture(u_src, uv + u_texel * vec2(1, 0)).rgb * 2.0;
    s += texture(u_src, uv + u_texel * vec2(-1, 1)).rgb;
    s += texture(u_src, uv + u_texel * vec2(0, 1)).rgb * 2.0;
    s += texture(u_src, uv + u_texel * vec2(1, 1)).rgb;
    o = vec4(s / 16.0, 1.0);
}`;

// Final composite: kaleidoscope, chromatic aberration, bloom, tonemap, flash
export const FINAL_FS = HEADER + /* glsl */ `
uniform sampler2D u_hdr;
uniform sampler2D u_bloom;
uniform vec2 u_aspect;
uniform float u_bloomStrength, u_ca, u_flash, u_exposure, u_vignette, u_fade;
uniform float u_kaleido, u_kaleidoRot;
uniform float u_time;
uniform vec4 u_ripple[4];      // center (uv), radius, amplitude — in screen-height units
uniform float u_screenAspect;  // width / height
in vec2 uv;
out vec4 o;

// Kick shockwaves as a refraction ring travelling across the image
vec2 ripple(vec2 q) {
    vec2 off = vec2(0.0);
    for (int i = 0; i < 4; i++) {
        vec4 r = u_ripple[i];
        if (r.w == 0.0) continue;
        vec2 d = (q - r.xy) * vec2(u_screenAspect, 1.0);
        float len = length(d);
        float band = (len - r.z) / 0.045;
        off += (len > 0.0 ? d / len : vec2(0.0)) * r.w * band * exp(-band * band) / vec2(u_screenAspect, 1.0);
    }
    return q - off;
}

vec2 kaleido(vec2 q) {
    if (u_kaleido < 1.5) return q;
    vec2 p = (q - 0.5) * u_aspect;
    float r = length(p);
    float a = atan(p.y, p.x) + u_kaleidoRot;
    float seg = PI / u_kaleido;
    a = mod(a, 2.0 * seg);
    a = abs(a - seg);
    return vec2(cos(a), sin(a)) * r / u_aspect + 0.5;
}

vec3 sampleHDR(vec2 q) {
    return texture(u_hdr, q).rgb + texture(u_bloom, q).rgb * u_bloomStrength;
}

void main() {
    vec2 q = ripple(kaleido(uv));
    vec3 col;
    if (u_ca > 0.0) {
        vec2 dir = (q - 0.5) * u_ca * 0.02;
        col = vec3(sampleHDR(q + dir).r, sampleHDR(q).g, sampleHDR(q - dir).b);
    } else {
        col = sampleHDR(q);
    }
    col *= u_exposure;
    float len = length(col);
    if (len > 0.0) col *= 2.0 * asinh(len * 3.9) / (len * 3.9);
    vec2 v = (uv - 0.5) * u_aspect / max(u_aspect.x, u_aspect.y);
    col *= 1.0 - u_vignette * smoothstep(0.35, 0.95, length(v) * 1.4);
    col += vec3(u_flash);
    // subtle dither against banding on projectors
    col += (fract(sin(dot(gl_FragCoord.xy + u_time, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
    o = vec4(col * u_fade, 1.0);
}`;

// ─── Spatial sorting (keeps particles in raster order: ~4x faster on tilers) ──
// Keys: one RGBA texel holds the tile keys of 4 consecutive slots.
export const SORT_KEY_FS = HEADER + /* glsl */ `
uniform sampler2D u_state;
uniform int u_texW;
uniform int u_count;
uniform vec2 u_edge;
uniform vec2 u_grid;
out vec4 o;
float key(int x, int y) {
    int slot = y * u_texW + x;
    if (x >= u_texW || slot >= u_count) return 1e9;
    vec2 p = texelFetch(u_state, ivec2(x, y), 0).xy;
    vec2 t = clamp(floor((p / (2.0 * u_edge) + 0.5) * u_grid), vec2(0.0), u_grid - 1.0);
    float col = mod(t.y, 2.0) < 0.5 ? t.x : u_grid.x - 1.0 - t.x;   // serpentine rows
    return t.y * u_grid.x + col;
}
void main() {
    ivec2 px = ivec2(gl_FragCoord.xy);
    int x = px.x * 4;
    o = vec4(key(x, px.y), key(x + 1, px.y), key(x + 2, px.y), key(x + 3, px.y));
}`;

export const GATHER_FS = HEADER + /* glsl */ `
uniform sampler2D u_state;
uniform sampler2D u_aux;
uniform sampler2D u_perm;
uniform int u_texW;
layout(location = 0) out vec4 o_state;
layout(location = 1) out vec4 o_aux;
void main() {
    ivec2 px = ivec2(gl_FragCoord.xy);
    int j = int(texelFetch(u_perm, px, 0).r);
    ivec2 pj = ivec2(j % u_texW, j / u_texW);
    o_state = texelFetch(u_state, pj, 0);
    o_aux = texelFetch(u_aux, pj, 0);
}`;
