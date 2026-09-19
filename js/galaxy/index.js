/* ============================================================
   galaxy/index.js
   Entry point. Wires generation, rendering, camera and page
   integration together, and owns the lifecycle:

     capability check -> quality tier -> build -> loop -> reveal

   Anything that can fail degrades instead of throwing: no
   WebGL, a lost context, or a shader error all fall through
   to the 2D starfield while the page keeps working.
   ============================================================ */

import { clamp, damp } from './math.js';
import {
    GALAXY_RADIUS,
    generateStars,
    generateDust,
    generateNebula,
    generateDeepField,
    generateCoreGlow,
} from './generate.js';
import { GalaxyRenderer, isWebGLAvailable } from './renderer.js';
import { OrbitCamera, CameraControls } from './controls.js';
import { createStarfieldFallback } from './fallback.js';

/* ------------------------------------------------------------
   Quality tiers
   Particle budgets are chosen so the heaviest layer still fits
   comfortably in one draw call on integrated graphics.
------------------------------------------------------------ */
const QUALITY_TIERS = {
    high:   { stars: 58000, dust: 7000, nebula: 420, deep: 11000, maxPixelRatio: 1.75, bloom: true },
    medium: { stars: 30000, dust: 3600, nebula: 240, deep: 6000,  maxPixelRatio: 1.5,  bloom: true },
    low:    { stars: 13000, dust: 1700, nebula: 130, deep: 3200,  maxPixelRatio: 1.25, bloom: false },
};

function detectQuality() {
    const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    const narrow = window.innerWidth < 820;
    const cores = navigator.hardwareConcurrency || 4;
    const memory = navigator.deviceMemory || 4;

    if (coarsePointer || narrow || cores <= 4 || memory <= 3) return 'low';
    if (cores <= 8 || memory <= 6) return 'medium';
    return 'high';
}

/* ------------------------------------------------------------
   Screen point -> world point on the galactic plane (y = 0).

   Builds the camera basis by hand and intersects the view ray
   with the disc, which is all a click ripple needs — cheaper
   and clearer than inverting the view-projection matrix.
------------------------------------------------------------ */
function screenToGalacticPlane(camera, clientX, clientY, out = [0, 0, 0]) {
    const eye = camera.position;

    let fx = camera.target[0] - eye[0];
    let fy = camera.target[1] - eye[1];
    let fz = camera.target[2] - eye[2];
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;

    // right = normalize(cross(forward, worldUp)) with worldUp = (0, 1, 0)
    let rx = -fz;
    let ry = 0;
    let rz = fx;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;

    // up = cross(right, forward)
    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;

    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    const tan = Math.tan(camera.fov / 2);
    const ndcX = ((clientX / window.innerWidth) * 2 - 1) * tan * aspect;
    const ndcY = -((clientY / window.innerHeight) * 2 - 1) * tan;

    let dx = fx + rx * ndcX + ux * ndcY;
    let dy = fy + ry * ndcX + uy * ndcY;
    let dz = fz + rz * ndcX + uz * ndcY;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;

    // Intersect the y = 0 plane; fall back to the core if the ray is parallel.
    const t = Math.abs(dy) > 1e-4 ? -eye[1] / dy : -1;
    if (t <= 0) {
        out[0] = out[1] = out[2] = 0;
        return out;
    }

    out[0] = eye[0] + dx * t;
    out[1] = 0;
    out[2] = eye[2] + dz * t;

    // Keep the shockwave inside the disc so far clicks still read.
    const limit = GALAXY_RADIUS * 1.6;
    const len = Math.hypot(out[0], out[2]);
    if (len > limit) {
        out[0] = (out[0] / len) * limit;
        out[2] = (out[2] / len) * limit;
    }
    return out;
}

/* ------------------------------------------------------------
   Main
------------------------------------------------------------ */
export function initGalaxy(options = {}) {
    const canvas = options.canvas || document.getElementById('galaxy-canvas');
    if (!canvas) return null;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const stage = options.stage || document.getElementById('hero') || document.body;

    const finish = (instance) => {
        document.documentElement.dataset.galaxyState = instance ? instance.mode : 'failed';
        window.dispatchEvent(new CustomEvent('galaxy:ready', { detail: { mode: instance ? instance.mode : 'failed' } }));
        return instance;
    };

    if (!isWebGLAvailable()) {
        return finish(createStarfieldFallback(canvas, { reducedMotion }));
    }

    let renderer;
    try {
        renderer = new GalaxyRenderer(canvas);
    } catch (error) {
        console.warn('[galaxy] WebGL init failed, using starfield fallback:', error.message);
        return finish(createStarfieldFallback(canvas, { reducedMotion }));
    }

    const tierName = options.quality || detectQuality();
    const tier = QUALITY_TIERS[tierName] || QUALITY_TIERS.medium;
    const adaptive = options.adaptive !== false;

    /* --- Build the layers -----------------------------------
       Draw order matters now: dust is drawn LAST, with
       multiplicative blending, so it can actually darken the
       stars already accumulated beneath it instead of merely
       glowing on top of them. */
    renderer.addLayer(generateDeepField(tier.deep), {
        name: 'deep',
        spin: 0.004,          // near-static: these are meant to be very far away
        opacity: 0.85,
        softness: 1.5,
        twinkle: 0.45,
        fogNear: 4.0,
        fogFar: 260.0,
    });

    renderer.addLayer(generateNebula(tier.nebula), {
        name: 'nebula',
        spin: 0.055,
        opacity: 0.08,        // deliberately faint — nebulae should suggest, not shout
        softness: 3.6,
        drift: 0.05,
        fogNear: 2.5,
        fogFar: 95.0,
    });

    renderer.addLayer(generateCoreGlow(130), {
        name: 'coreGlow',
        spin: 0.07,
        opacity: 0.045,       // stacked additively into one smooth nucleus
        softness: 3.8,
        fogNear: 2.0,
        fogFar: 120.0,
    });

    renderer.addLayer(generateStars(tier.stars), {
        name: 'stars',
        spin: 0.07,           // the reference rate; ~90s for an outer-arm sweep
        opacity: 1.0,
        softness: 1.35,
        twinkle: 0.30,
        fogNear: 1.0,
        fogFar: 90.0,
    });

    renderer.addLayer(generateDust(tier.dust), {
        name: 'dust',
        blend: 'multiply',    // occludes the stars behind it — see shaders.js
        spin: 0.062,
        opacity: 0.40,
        softness: 2.4,
        drift: 0.02,
        fogNear: 2.0,
        fogFar: 80.0,
    });

    /* Bloom is a meaningful GPU cost, so it only turns on for tiers
       that can afford it, and never on top of a device that already
       needed to be asked twice — if the framebuffers themselves
       aren't supported, carry on without bloom rather than fail. */
    if (tier.bloom) {
        try {
            renderer.enableBloom({ threshold: 0.55, strength: 0.85 });
        } catch (error) {
            console.warn('[galaxy] bloom unavailable on this device:', error.message);
        }
    }

    /* --- Camera + input ------------------------------------ */
    const camera = new OrbitCamera({ reducedMotion });
    const ripple = { origin: [0, 0, 0], age: -1 };

    const controls = new CameraControls(camera, stage, {
        enabled: !reducedMotion,
        onClick: (event) => {
            screenToGalacticPlane(camera, event.clientX, event.clientY, ripple.origin);
            ripple.age = 0;
        },
    });

    /* --- Render loop --------------------------------------- */
    let pixelRatio = Math.min(window.devicePixelRatio || 1, tier.maxPixelRatio);
    let running = true;
    let frameHandle = null;
    let lastTime = performance.now();
    let elapsed = 0;
    let fade = 0;            // intro fade-in, then scroll dimming
    let targetFade = 1;
    let scrollTarget = 0;

    // Adaptive quality: sample the first couple of seconds and
    // drop resolution once if the device cannot keep up.
    let sampleFrames = 0;
    let sampleTime = 0;
    let degradeStage = 0;   // 0 = full quality, 1 = lower scale, 2 = reduced layers

    /* Composition is viewport-dependent: on a wide screen the galaxy
       sits up and to the left of the centred headline; on a narrow one
       there is no room beside the text, so it moves above it and the
       camera backs off to keep the whole disc in frame. */
    function updateFraming() {
        const portrait = window.innerWidth < 820;
        camera.screenOffset[0] = portrait ? 0.02 : 0.36;
        camera.screenOffset[1] = portrait ? -0.72 : -0.46;
        camera.baseRadius = portrait ? 21.0 : 15.5;
    }

    function updateScrollInfluence() {
        const viewport = window.innerHeight || 1;
        const progress = clamp(window.scrollY / viewport, 0, 1);
        // Camera pulls back as the hero leaves; the field dims so
        // body copy over it stays comfortably readable.
        camera.scrollDepth = reducedMotion ? 0 : progress;
        scrollTarget = 1 - progress * 0.62;
    }

    function frame(now) {
        if (!running) return;
        const rawDt = (now - lastTime) / 1000;
        // Clamped for animation stability across tab switches and hitches.
        const dt = Math.min(rawDt, 0.05);
        lastTime = now;
        elapsed += reducedMotion ? 0 : dt;

        if (ripple.age >= 0) {
            ripple.age += dt;
            if (ripple.age > 3.5) ripple.age = -1; // shockwave has fully decayed
        }

        camera.update(dt);
        targetFade = scrollTarget;
        fade = damp(fade, targetFade, reducedMotion ? 30 : 2.2, dt);

        renderer.resize(pixelRatio);
        renderer.render({ camera, time: elapsed, pixelRatio, fade, ripple });

        /* Adaptive quality ladder.
           Sample two seconds of real frames, then step down one rung
           if the device cannot hold a smooth rate. Nebulae and the
           core glow are the large soft sprites that dominate fill
           rate, so they are the first things to go. */
        if (adaptive && degradeStage < 2) {
            sampleFrames++;
            sampleTime += rawDt;   // real elapsed time, not the clamped step
            if (sampleTime >= 2.0) {
                const fps = sampleFrames / sampleTime;
                sampleFrames = 0;
                sampleTime = 0;
                if (fps < 40) {
                    degradeStage++;
                    if (degradeStage === 1) {
                        // Bloom (extra render passes) and render scale are
                        // the cheapest wins — drop both before touching
                        // any particle layer.
                        renderer.disableBloom();
                        if (pixelRatio > 1) pixelRatio = Math.max(1, pixelRatio * 0.72);
                        console.info('[galaxy] disabled bloom and lowered render scale to hold the frame rate');
                    } else {
                        renderer.setLayerEnabled('nebula', false);
                        renderer.setLayerEnabled('coreGlow', false);
                        degradeStage = 2;
                        console.info('[galaxy] dropped soft-sprite layers to hold the frame rate');
                    }
                } else if (fps >= 50) {
                    degradeStage = 2; // performing well, stop sampling
                }
            }
        }

        frameHandle = requestAnimationFrame(frame);
    }

    function start() {
        if (running && frameHandle !== null) return;
        running = true;
        lastTime = performance.now();
        frameHandle = requestAnimationFrame(frame);
    }

    function stop() {
        running = false;
        if (frameHandle !== null) cancelAnimationFrame(frameHandle);
        frameHandle = null;
    }

    /* --- Lifecycle listeners -------------------------------- */
    const onVisibility = () => (document.hidden ? stop() : start());
    const onResize = () => {
        pixelRatio = Math.min(window.devicePixelRatio || 1, tier.maxPixelRatio);
        if (degradeStage >= 1) pixelRatio = Math.max(1, pixelRatio * 0.72);
        updateFraming();
        updateScrollInfluence();
    };
    const onScroll = () => updateScrollInfluence();

    const onContextLost = (event) => {
        event.preventDefault();
        stop();
        console.warn('[galaxy] WebGL context lost — switching to starfield fallback');
        controls.dispose();
        createStarfieldFallback(canvas, { reducedMotion });
        document.documentElement.dataset.galaxyState = 'fallback';
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('orientationchange', onResize, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    canvas.addEventListener('webglcontextlost', onContextLost, false);

    updateFraming();
    updateScrollInfluence();
    start();

    return finish({
        mode: 'webgl',
        quality: tierName,
        camera,
        renderer,
        dispose() {
            stop();
            controls.dispose();
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('resize', onResize);
            window.removeEventListener('orientationchange', onResize);
            window.removeEventListener('scroll', onScroll);
            canvas.removeEventListener('webglcontextlost', onContextLost);
            renderer.dispose();
        },
    });
}

/* Auto-start once the document is parsed. */
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initGalaxy());
} else {
    initGalaxy();
}
