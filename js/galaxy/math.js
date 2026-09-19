/* ============================================================
   galaxy/math.js
   Minimal linear-algebra + RNG helpers.

   We only need what a point-cloud renderer uses: a perspective
   projection, a look-at view matrix, and one multiply. Writing
   these by hand keeps the whole galaxy dependency-free (~0 KB
   of third-party code) instead of pulling in a full 3D engine.
   ============================================================ */

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Frame-rate independent damping. t = how much of the gap to close per second. */
export const damp = (current, target, lambda, dt) =>
    current + (target - current) * (1 - Math.exp(-lambda * dt));

/* ---------- Deterministic RNG (mulberry32) -------------------
   A seeded generator means the galaxy is reproducible: the same
   seed always produces the same star field, which makes visual
   tweaking predictable instead of a slot machine.
------------------------------------------------------------- */
export function createRandom(seed = 1337) {
    let a = seed >>> 0;
    return function random() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Approximate standard normal via the central limit theorem (sum of 3 uniforms). */
export function gaussian(random) {
    return (random() + random() + random() - 1.5) * 1.1547;
}

/* ---------- mat4 (column-major, WebGL layout) ---------- */

export function mat4Identity(out = new Float32Array(16)) {
    out.fill(0);
    out[0] = out[5] = out[10] = out[15] = 1;
    return out;
}

/**
 * Right-handed perspective projection with an optional lens shift.
 *
 * offsetX / offsetY slide the whole image within the frame (in units of
 * half-viewport) without rotating the camera or skewing perspective —
 * the same trick a tilt-shift lens uses. It lets the galaxy sit
 * off-centre for composition while the camera still orbits its core.
 *
 * fovY in radians, depth range mapped to [-1, 1].
 */
export function mat4Perspective(out, fovY, aspect, near, far, offsetX = 0, offsetY = 0) {
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);
    out.fill(0);
    out[0] = f / aspect;
    out[5] = f;
    out[8] = offsetX;
    out[9] = offsetY;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[14] = 2 * far * near * nf;
    return out;
}

/** Right-handed look-at view matrix. */
export function mat4LookAt(out, eye, target, up) {
    let zx = eye[0] - target[0];
    let zy = eye[1] - target[1];
    let zz = eye[2] - target[2];
    let len = Math.hypot(zx, zy, zz) || 1;
    zx /= len; zy /= len; zz /= len;

    // x = normalize(cross(up, z))
    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    len = Math.hypot(xx, xy, xz) || 1;
    xx /= len; xy /= len; xz /= len;

    // y = cross(z, x)  — already unit length
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;

    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[15] = 1;
    return out;
}

/** out = a * b */
export function mat4Multiply(out, a, b) {
    for (let c = 0; c < 4; c++) {
        const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
        out[c * 4]     = a[0] * b0 + a[4] * b1 + a[8]  * b2 + a[12] * b3;
        out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9]  * b2 + a[13] * b3;
        out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
        out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return out;
}

/** Convert spherical (radius, polar phi from +Y, azimuth theta) to cartesian. */
export function sphericalToCartesian(radius, phi, theta, out = [0, 0, 0]) {
    const sinPhi = Math.sin(phi);
    out[0] = radius * sinPhi * Math.sin(theta);
    out[1] = radius * Math.cos(phi);
    out[2] = radius * sinPhi * Math.cos(theta);
    return out;
}
