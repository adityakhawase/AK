/* ============================================================
   galaxy/fallback.js
   Lightweight 2D canvas starfield.

   Used when WebGL is missing, blocked, or the context is lost.
   Same visual language (drifting spiral of stars, dark field),
   a tiny fraction of the cost, and it degrades to a static
   frame under prefers-reduced-motion.
   ============================================================ */

import { TAU, createRandom } from './math.js';

export function createStarfieldFallback(canvas, options = {}) {
    const { reducedMotion = false, density = 1 } = options;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const random = createRandom(7331);
    let stars = [];
    let width = 0;
    let height = 0;
    let pixelRatio = 1;
    let frame = null;
    let running = false;
    let manualPaused = false;

    function build() {
        pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
        width = canvas.clientWidth;
        height = canvas.clientHeight;
        canvas.width = Math.round(width * pixelRatio);
        canvas.height = Math.round(height * pixelRatio);
        ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

        const count = Math.min(900, Math.round((width * height) / 1700 * density));
        stars = Array.from({ length: count }, () => {
            // Loose spiral so the fallback still hints at a galaxy.
            const radial = Math.pow(random(), 1.7);
            const arm = (random() * 4 | 0) / 4 * TAU;
            const angle = arm + radial * 5.2 + (random() - 0.5) * 0.7;
            return {
                angle,
                radius: radial,
                depth: 0.35 + random() * 0.65,
                size: 0.8 + Math.pow(random(), 3) * 2.4,
                hue: random(),
            };
        });
    }

    function draw(time) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, width, height);
        // Additive, so dense arm regions brighten the way the WebGL
        // point cloud does instead of flattening into a grey wash.
        ctx.globalCompositeOperation = 'lighter';

        const portrait = width < 820;
        const cx = width * 0.5;
        const cy = height * 0.5;
        const scale = Math.min(width, height) * (portrait ? 0.62 : 0.78);
        const spin = reducedMotion ? 0 : time * 0.00002;

        for (let i = 0; i < stars.length; i++) {
            const s = stars[i];
            // Inner stars sweep faster, echoing the WebGL version.
            const angle = s.angle + spin / (s.radius * 0.6 + 0.35);
            const r = s.radius * scale;
            const x = cx + Math.cos(angle) * r;
            const y = cy + Math.sin(angle) * r * 0.42; // viewed near the disc plane

            const alpha = (0.35 + s.depth * 0.65) * (1 - s.radius * 0.28);
            ctx.globalAlpha = Math.max(0, alpha);
            ctx.fillStyle = s.hue < 0.5
                ? 'rgb(255, 238, 210)'
                : s.hue < 0.85 ? 'rgb(225, 235, 255)' : 'rgb(150, 190, 255)';
            ctx.beginPath();
            ctx.arc(x, y, Math.max(0.5, s.size * s.depth), 0, TAU);
            ctx.fill();
        }

        // Soft core glow.
        const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, scale * 0.34);
        glow.addColorStop(0, 'rgba(255, 234, 196, 0.55)');
        glow.addColorStop(0.35, 'rgba(255, 210, 150, 0.16)');
        glow.addColorStop(1, 'rgba(255, 210, 150, 0)');
        ctx.globalAlpha = 1;
        ctx.fillStyle = glow;
        ctx.fillRect(cx - scale, cy - scale, scale * 2, scale * 2);
    }

    function loop(time) {
        draw(time);
        if (running && !reducedMotion && !manualPaused) frame = requestAnimationFrame(loop);
    }

    function start() {
        running = true;
        if (reducedMotion) draw(0);
        else frame = requestAnimationFrame(loop);
    }

    function onResize() {
        build();
        if (reducedMotion) draw(0);
    }

    build();
    start();
    window.addEventListener('resize', onResize);

    return {
        mode: 'fallback',
        get paused() { return manualPaused; },
        pause() {
            manualPaused = true;
            running = false;
            if (frame) cancelAnimationFrame(frame);
            frame = null;
        },
        resume() {
            manualPaused = false;
            if (!running) start();
        },
        dispose() {
            running = false;
            if (frame) cancelAnimationFrame(frame);
            window.removeEventListener('resize', onResize);
        },
    };
}
