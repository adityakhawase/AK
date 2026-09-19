/* ============================================================
   galaxy/meteors.js
   Shooting-star overlay.

   A lightweight 2D canvas that sits just above the WebGL galaxy
   (or the 2D fallback) and occasionally streaks a meteor across
   the sky. Kept deliberately separate from the point-cloud
   renderer:

     - streaks are lines with a gradient tail, not point sprites,
       so they don't fit the star shader;
     - a 2D overlay works identically over WebGL and fallback;
     - zero risk to the existing five draw calls / bloom pipeline.

   Costs one extra canvas + a rAF that idles (no drawing) between
   meteors. Respects prefers-reduced-motion and tab visibility.
   ============================================================ */

export function createMeteorOverlay(options = {}) {
    const {
        reducedMotion = false,
        // Average spawn cadence per quality tier. Overridden by index.js.
        minInterval = 2500,
        maxInterval = 7000,
        maxAlive = 3,
    } = options;

    if (reducedMotion) return null;

    const canvas = document.createElement('canvas');
    canvas.id = 'meteor-canvas';
    canvas.setAttribute('aria-hidden', 'true');

    const galaxyCanvas = document.getElementById('galaxy-canvas');
    if (galaxyCanvas && galaxyCanvas.parentNode) {
        galaxyCanvas.parentNode.insertBefore(canvas, galaxyCanvas.nextSibling);
    } else {
        document.body.prepend(canvas);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
        canvas.remove();
        return null;
    }

    let width = 0;
    let height = 0;
    let pixelRatio = 1;
    let meteors = [];
    let running = true;
    let manualPaused = false;
    let frameHandle = null;
    let lastTime = performance.now();
    let nextSpawnIn = 1200; // first streak arrives quickly for the wow factor

    function resize() {
        pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
        width = window.innerWidth;
        height = window.innerHeight;
        canvas.width = Math.round(width * pixelRatio);
        canvas.height = Math.round(height * pixelRatio);
        ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    }

    function spawn() {
        // Start in the upper 60% of the screen, travel diagonally down.
        const startX = Math.random() * width * 0.9 + width * 0.05;
        const startY = Math.random() * height * 0.45;
        const angle = Math.PI * (0.72 + Math.random() * 0.12); // down-left-ish
        const speed = 550 + Math.random() * 650; // px per second
        const life = 0.9 + Math.random() * 0.7;
        const tail = 120 + Math.random() * 160;

        meteors.push({
            x: startX,
            y: startY,
            vx: Math.cos(angle) * speed, // negative: drifts left
            vy: Math.abs(Math.sin(angle)) * speed, // positive: drifts down
            age: 0,
            life,
            tail,
            width: 1.2 + Math.random() * 1.4,
        });
    }

    function drawMeteor(m) {
        const progress = m.age / m.life;
        // Ease: quick fade-in, long fade-out.
        const alpha = progress < 0.15
            ? progress / 0.15
            : 1 - (progress - 0.15) / 0.85;

        const mag = Math.hypot(m.vx, m.vy) || 1;
        const dx = (m.vx / mag) * m.tail;
        const dy = (m.vy / mag) * m.tail;

        const grad = ctx.createLinearGradient(m.x, m.y, m.x - dx, m.y - dy);
        grad.addColorStop(0, `rgba(255, 255, 255, ${0.9 * alpha})`);
        grad.addColorStop(0.25, `rgba(190, 230, 255, ${0.55 * alpha})`);
        grad.addColorStop(1, 'rgba(190, 230, 255, 0)');

        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = grad;
        ctx.lineWidth = m.width;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(m.x - dx, m.y - dy);
        ctx.stroke();

        // Bright head.
        ctx.fillStyle = `rgba(255, 255, 255, ${0.9 * alpha})`;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.width * 0.9, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
    }

    function frame(now) {
        if (!running) return;
        const dt = Math.min((now - lastTime) / 1000, 0.05);
        lastTime = now;

        ctx.clearRect(0, 0, width, height);

        nextSpawnIn -= dt * 1000;
        if (nextSpawnIn <= 0 && meteors.length < maxAlive) {
            spawn();
            nextSpawnIn = minInterval + Math.random() * (maxInterval - minInterval);
        }

        meteors = meteors.filter((m) => m.age < m.life);
        for (const m of meteors) {
            m.age += dt;
            m.x += m.vx * dt;
            m.y += m.vy * dt;
            // Slight gravity curve for a natural arc.
            m.vy += 60 * dt;
            drawMeteor(m);
        }

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

    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);

    resize();
    start();

    return {
        mode: 'meteors',
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
            canvas.remove();
        },
    };
}
