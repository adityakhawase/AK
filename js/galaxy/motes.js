/* ============================================================
   galaxy/motes.js
   Foreground dust motes — the "depth" layer.

   A 2D canvas above the galaxy (and above the vignette) carrying
   a few dozen large, very soft, slow-drifting dust specks. Because
   they are big, blurred and close to the viewer while the galaxy
   is sharp and far away, the parallax between them sells real
   depth — the cheapest 3D trick there is.

   Like meteors.js this is fully independent of the WebGL
   renderer, so it works over both WebGL and the 2D fallback and
   can never break the main scene. One canvas, one rAF, ~40 soft
   sprites: negligible GPU cost.
   ============================================================ */

export function createMoteOverlay(options = {}) {
    const {
        reducedMotion = false,
        count = 42,
    } = options;

    if (reducedMotion) return null;

    const canvas = document.createElement('canvas');
    canvas.id = 'mote-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.prepend(canvas);

    const ctx = canvas.getContext('2d');
    if (!ctx) {
        canvas.remove();
        return null;
    }

    let width = 0;
    let height = 0;
    let pixelRatio = 1;
    let motes = [];
    let running = true;
    let manualPaused = false;
    let frameHandle = null;
    let lastTime = performance.now();

    // Mouse parallax, normalised -1..1, eased toward the target.
    let parallaxX = 0;
    let parallaxY = 0;
    let targetParallaxX = 0;
    let targetParallaxY = 0;

    function resize() {
        pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
        width = window.innerWidth;
        height = window.innerHeight;
        canvas.width = Math.round(width * pixelRatio);
        canvas.height = Math.round(height * pixelRatio);
        ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        build();
    }

    function build() {
        const mobile = width < 820;
        const n = mobile ? Math.round(count * 0.5) : count;
        motes = Array.from({ length: n }, () => ({
            // Random position across the whole viewport.
            x: Math.random() * width,
            y: Math.random() * height,
            // Depth 0..1: deep motes are small, dim and slow;
            // near motes are big, brighter and faster.
            depth: Math.pow(Math.random(), 1.6),
            // Slow drift direction + speed.
            vx: (Math.random() - 0.5) * 14,
            vy: (Math.random() - 0.5) * 10 - 3, // gentle upward float
            phase: Math.random() * Math.PI * 2,
        }));
    }

    function drawMote(m, time) {
        // Breathing alpha so motes fade in and out as they drift.
        const breathe = 0.55 + 0.45 * Math.sin(time * 0.0004 + m.phase);
        const radius = 18 + m.depth * 70;
        const alpha = (0.025 + m.depth * 0.075) * breathe;

        // Parallax: near motes shift most with the mouse.
        const px = parallaxX * m.depth * 46;
        const py = parallaxY * m.depth * 30;
        const x = m.x + px;
        const y = m.y + py;

        const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
        grad.addColorStop(0, `rgba(180, 210, 255, ${alpha})`);
        grad.addColorStop(0.5, `rgba(150, 190, 255, ${alpha * 0.45})`);
        grad.addColorStop(1, 'rgba(150, 190, 255, 0)');

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
    }

    function frame(now) {
        if (!running) return;
        const dt = Math.min((now - lastTime) / 1000, 0.05);
        lastTime = now;

        // Ease the parallax so it glides rather than snaps.
        parallaxX += (targetParallaxX - parallaxX) * (1 - Math.exp(-2.5 * dt));
        parallaxY += (targetParallaxY - parallaxY) * (1 - Math.exp(-2.5 * dt));

        ctx.clearRect(0, 0, width, height);
        ctx.globalCompositeOperation = 'lighter';

        for (const m of motes) {
            m.x += m.vx * dt;
            m.y += m.vy * dt;
            // Wrap around the edges so the field never empties.
            const margin = 120;
            if (m.x < -margin) m.x = width + margin;
            if (m.x > width + margin) m.x = -margin;
            if (m.y < -margin) m.y = height + margin;
            if (m.y > height + margin) m.y = -margin;
            drawMote(m, now);
        }

        ctx.globalCompositeOperation = 'source-over';
        frameHandle = requestAnimationFrame(frame);
    }

    function start() {
        if (frameHandle !== null) return;
        running = true;
        lastTime = performance.now();
        frameHandle = requestAnimationFrame(frame);
    }

    function stop() {
        running = false;
        if (frameHandle !== null) cancelAnimationFrame(frameHandle);
        frameHandle = null;
    }

    const onResize = () => resize();
    const onVisibility = () => {
        if (manualPaused) return;
        document.hidden ? stop() : start();
    };
    const onPointerMove = (event) => {
        if (event.pointerType === 'touch') return;
        targetParallaxX = (event.clientX / window.innerWidth) * 2 - 1;
        targetParallaxY = (event.clientY / window.innerHeight) * 2 - 1;
    };

    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pointermove', onPointerMove, { passive: true });

    resize();
    start();

    return {
        mode: 'motes',
        get paused() { return manualPaused; },
        pause() {
            manualPaused = true;
            stop();
        },
        resume() {
            manualPaused = false;
            if (!document.hidden) start();
        },
        dispose() {
            stop();
            window.removeEventListener('resize', onResize);
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('pointermove', onPointerMove);
            canvas.remove();
        },
    };
}
