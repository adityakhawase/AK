/* ============================================================
   galaxy/shaders.js
   GLSL for the point-cloud renderer.

   Everything that moves is animated on the GPU from a single
   uTime uniform. Nothing writes back to a vertex buffer per
   frame, so a 60k-star galaxy costs one draw call and zero
   per-frame CPU work.
   ============================================================ */

export const VERTEX_SHADER = /* glsl */ `
precision highp float;

attribute vec3  aPosition;   // rest position in galaxy space
attribute vec3  aColor;      // star colour
attribute float aSize;       // relative point size
attribute float aSeed;       // per-particle randomness (0..1)

uniform mat4  uProjection;
uniform mat4  uView;
uniform float uTime;
uniform float uPixelRatio;
uniform float uSizeScale;    // viewport-height based size factor

uniform float uSpin;         // rotation speed of this layer
uniform float uTwinkle;      // 0 = steady, 1 = full shimmer
uniform float uDrift;        // vertical bobbing amplitude
uniform float uFogNear;      // fade particles that get too close
uniform float uFogFar;       // fade particles into the void

uniform vec3  uRippleOrigin; // click shockwave centre
uniform float uRippleAge;    // seconds since the click (<0 = inactive)

varying vec3  vColor;
varying float vAlpha;

void main() {
    vec3 pos = aPosition;

    /* --- Differential rotation -----------------------------
       Real galaxies do not spin like a rigid disc: material
       near the core completes an orbit far faster than the
       outer arms. Angular speed w(r) ~ 1 / (r + k) reproduces
       that shear, which is what makes the arms feel alive
       rather than like a rotating JPEG.
    ------------------------------------------------------- */
    float radius = length(pos.xz);
    float angle  = uTime * uSpin / (radius * 0.35 + 1.0);
    float s = sin(angle);
    float c = cos(angle);
    pos.xz = mat2(c, -s, s, c) * pos.xz;

    /* --- Slow vertical drift, de-synchronised per particle --- */
    pos.y += sin(uTime * 0.25 + aSeed * 40.0) * uDrift;

    /* --- Click shockwave -----------------------------------
       A short outward push that decays with both time and
       distance, so a click ripples through nearby dust and
       settles again within a couple of seconds.
    ------------------------------------------------------- */
    if (uRippleAge >= 0.0) {
        vec3  toPoint = pos - uRippleOrigin;
        float dist    = length(toPoint) + 0.0001;
        float wave    = sin(dist * 2.2 - uRippleAge * 5.0);
        float decay   = exp(-uRippleAge * 1.6) * exp(-dist * 0.35);
        pos += (toPoint / dist) * wave * decay * 0.45;
    }

    vec4 viewPos = uView * vec4(pos, 1.0);
    float depth  = -viewPos.z;

    /* Perspective point scaling.
       uSizeScale is the projection scale in device pixels
       (viewportHeight / (2 * tan(fov/2))), so aSize is a real
       world-space diameter and a star shrinks correctly with
       distance instead of being an arbitrary pixel count. */
    gl_PointSize = aSize * uSizeScale / max(depth, 0.05);
    gl_PointSize = clamp(gl_PointSize, 0.6, 220.0);

    /* Atmospheric depth: fade in from the near plane, out into fog. */
    float nearFade = smoothstep(0.0, uFogNear, depth);
    float farFade  = 1.0 - smoothstep(uFogFar * 0.55, uFogFar, depth);

    float shimmer = 1.0 - uTwinkle * 0.5
                  + uTwinkle * 0.5 * sin(uTime * 1.7 + aSeed * 63.0);

    vColor   = aColor;
    vAlpha   = nearFade * farFade * shimmer;
    gl_Position = uProjection * viewPos;
}
`;

export const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform float uOpacity;    // per-layer master opacity
uniform float uSoftness;   // 1 = crisp star, 6 = diffuse nebula
uniform float uFade;       // global fade used by the intro + scroll dimming

varying vec3  vColor;
varying float vAlpha;

void main() {
    /* Procedural round sprite — no texture upload, no atlas,
       and it stays perfectly sharp at any point size. */
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;

    float falloff = pow(1.0 - d * 2.0, uSoftness);

    /* A tight bright centre on top of the soft halo reads as a
       real star rather than a fuzzy blob. */
    float core = pow(1.0 - d * 2.0, uSoftness * 6.0) * 0.6;

    float alpha = (falloff + core) * vAlpha * uOpacity * uFade;
    if (alpha < 0.002) discard;

    gl_FragColor = vec4(vColor * alpha, alpha);
}
`;

/* ------------------------------------------------------------
   Multiplicative variant — used only by the dust layer.

   Real dust lanes do not glow, they OBSCURE: light from stars
   behind them is absorbed and reddened. Additive blending can
   only ever brighten a pixel, so it cannot represent that. This
   shader instead outputs a tint that the framebuffer is
   multiplied BY (renderer.js sets blendFunc(ZERO, SRC_COLOR)):
   white leaves the sky untouched, vColor darkens it toward
   that colour. The result is a real occluding lane instead of
   a bright haze pretending to be one.
------------------------------------------------------------ */
export const DUST_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform float uOpacity;
uniform float uSoftness;
uniform float uFade;

varying vec3  vColor;
varying float vAlpha;

void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;

    float shape = pow(1.0 - d * 2.0, uSoftness);
    float strength = clamp(shape * vAlpha * uOpacity * uFade, 0.0, 1.0);

    vec3 tint = mix(vec3(1.0), vColor, strength);
    gl_FragColor = vec4(tint, 1.0);
}
`;

/* ------------------------------------------------------------
   Post-processing: a compact three-pass bloom.

   bright-pass (isolate highlights) -> separable blur -> composite.
   All three share one fullscreen-triangle vertex shader — three
   vertices covering the viewport, no quad, no index buffer.
------------------------------------------------------------ */
export const FULLSCREEN_VERTEX_SHADER = /* glsl */ `
attribute vec2 aPosition;
varying vec2 vUv;

void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const BRIGHTPASS_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
uniform sampler2D uScene;
uniform float uThreshold;
varying vec2 vUv;

void main() {
    vec3 color = texture2D(uScene, vUv).rgb;
    vec3 bright = max(color - vec3(uThreshold), 0.0);
    gl_FragColor = vec4(bright, 1.0);
}
`;

/* 5-tap linear-sampled Gaussian, run twice (horizontal then
   vertical) per blur level. Cheap enough for a background effect
   while still giving a soft, non-boxy halo. */
export const BLUR_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexelStep; // (1/width, 0) or (0, 1/height), pre-scaled by radius
varying vec2 vUv;

void main() {
    vec3 sum = texture2D(uTex, vUv).rgb * 0.2270270270;
    vec2 off1 = uTexelStep * 1.3846153846;
    vec2 off2 = uTexelStep * 3.2307692308;
    sum += texture2D(uTex, vUv + off1).rgb * 0.3162162162;
    sum += texture2D(uTex, vUv - off1).rgb * 0.3162162162;
    sum += texture2D(uTex, vUv + off2).rgb * 0.0702702703;
    sum += texture2D(uTex, vUv - off2).rgb * 0.0702702703;
    gl_FragColor = vec4(sum, 1.0);
}
`;

export const COMPOSITE_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
varying vec2 vUv;

void main() {
    vec3 scene = texture2D(uScene, vUv).rgb;
    vec3 bloom = texture2D(uBloom, vUv).rgb;
    vec3 color = scene + bloom * uBloomStrength;

    /* The canvas sits transparently over the page, so alpha has to
       carry real meaning here, not just be 1.0 everywhere. Deriving
       it from luminance keeps empty sky transparent (letting the
       page's own dark backdrop show through) while stars and the
       bloom halo around them stay opaque — the same behaviour the
       single-pass additive renderer had before bloom existed. */
    float alpha = clamp(max(max(color.r, color.g), color.b) * 2.1, 0.0, 1.0);
    gl_FragColor = vec4(min(color, vec3(1.0)), alpha);
}
`;
