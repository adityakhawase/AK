/* ============================================================
   galaxy/controls.js
   Damped orbital camera.

   Every input writes to a *target* value; the camera eases
   toward it with frame-rate independent damping. That single
   indirection is what keeps the motion feeling cinematic
   instead of twitchy, and it makes the controls forgiving.
   ============================================================ */

import { clamp, damp, sphericalToCartesian } from './math.js';

/* Elements that own their own pointer behaviour — dragging must
   never start on top of a link, a button or a form field. */
const INTERACTIVE = 'a, button, input, textarea, select, label, [role="button"]';

export class OrbitCamera {
    constructor(options = {}) {
        const {
            radius = 15.5,
            phi = 0.78,         // polar angle from +Y; ~45 degrees above the disc,
                                // face-on enough for the spiral arms to read
            theta = 0.6,
            /* Lens shift rather than a tilted look-at: keeps the camera
               orbiting the galactic core while the core itself sits in the
               lower-right of the frame, leaving clean dark sky behind the
               hero headline. */
            screenOffset = [0.36, -0.46],
            fov = (52 * Math.PI) / 180,
            minRadius = 4.5,
            maxRadius = 32,
            reducedMotion = false,
        } = options;

        this.fov = fov;
        this.minRadius = minRadius;
        this.maxRadius = maxRadius;
        this.reducedMotion = reducedMotion;

        // Current (rendered) values.
        this.radius = radius + (reducedMotion ? 0 : 7); // start pulled back, then ease in
        this.phi = phi;
        this.theta = theta;

        // Targets the input layer writes to.
        this.targetRadius = radius;
        this.targetPhi = phi;
        this.targetTheta = theta;

        // Base values that parallax and scroll offsets are applied on top of.
        this.baseRadius = radius;
        this.basePhi = phi;
        this.baseTheta = theta;

        this.parallaxX = 0;
        this.parallaxY = 0;
        this.scrollDepth = 0;

        this.position = [0, 0, 0];
        this.target = [0, 0, 0];
        this.screenOffset = screenOffset.slice();
        this.autoRotate = reducedMotion ? 0 : 0.012; // radians per second
    }

    update(dt) {
        if (this.autoRotate) this.baseTheta += this.autoRotate * dt;

        // Compose: user orbit + mouse parallax + scroll-driven dolly.
        this.targetTheta = this.baseTheta + this.parallaxX * 0.22;
        this.targetPhi = clamp(this.basePhi + this.parallaxY * 0.14 + this.scrollDepth * 0.22, 0.18, Math.PI - 0.18);
        this.targetRadius = clamp(this.baseRadius + this.scrollDepth * 7.0, this.minRadius, this.maxRadius);

        const lambda = this.reducedMotion ? 30 : 3.2;
        this.theta = damp(this.theta, this.targetTheta, lambda, dt);
        this.phi = damp(this.phi, this.targetPhi, lambda, dt);
        this.radius = damp(this.radius, this.targetRadius, this.reducedMotion ? 30 : 1.8, dt);

        sphericalToCartesian(this.radius, this.phi, this.theta, this.position);
    }
}

export class CameraControls {
    /**
     * @param {OrbitCamera} camera
     * @param {HTMLElement} surface element whose bounds gate touch gestures
     */
    constructor(camera, surface, options = {}) {
        this.camera = camera;
        this.surface = surface;
        this.enabled = options.enabled !== false;
        this.onClick = options.onClick || null;

        this.dragging = false;
        this.pointerId = null;
        this.lastX = 0;
        this.lastY = 0;
        this.movedDistance = 0;
        this.activeTouches = new Map();
        this.pinchDistance = 0;

        this.handlers = [];
        this.bind();
    }

    listen(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        this.handlers.push([target, type, handler, options]);
    }

    bind() {
        if (!this.enabled) return;

        this.listen(window, 'pointerdown', this.onPointerDown, { passive: true });
        this.listen(window, 'pointermove', this.onPointerMove, { passive: true });
        this.listen(window, 'pointerup', this.onPointerUp, { passive: true });
        this.listen(window, 'pointercancel', this.onPointerUp, { passive: true });
        this.listen(window, 'touchmove', this.onTouchMove, { passive: false });
    }

    /** True when the gesture started over page content we must not steal. */
    blockedTarget(event) {
        const el = event.target;
        return !!(el && el.closest && el.closest(INTERACTIVE));
    }

    /** True when the point lies inside the surface we treat as the galaxy stage. */
    withinSurface(x, y) {
        if (!this.surface) return true;
        const rect = this.surface.getBoundingClientRect();
        return y >= rect.top && y <= rect.bottom && x >= rect.left && x <= rect.right;
    }

    onPointerDown = (event) => {
        if (event.pointerType === 'touch') {
            this.activeTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }
        if (this.blockedTarget(event)) return;
        if (event.pointerType === 'touch' && !this.withinSurface(event.clientX, event.clientY)) return;

        this.dragging = true;
        this.pointerId = event.pointerId;
        this.lastX = event.clientX;
        this.lastY = event.clientY;
        this.movedDistance = 0;
    };

    /* Orbiting must not paint the page with a text selection.
       The class is only applied once a drag genuinely starts, so
       ordinary text selection still works everywhere. */
    setDragState(active) {
        document.documentElement.classList.toggle('galaxy-dragging', active);
        if (active) {
            const selection = window.getSelection && window.getSelection();
            if (selection && selection.rangeCount) selection.removeAllRanges();
        }
    }

    onPointerMove = (event) => {
        const camera = this.camera;

        if (event.pointerType === 'touch' && this.activeTouches.has(event.pointerId)) {
            this.activeTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }

        /* Mouse parallax: normalised -1..1 across the viewport.
           Applied whether or not a drag is in progress, so the
           scene always breathes with the cursor. */
        if (event.pointerType === 'mouse' && !camera.reducedMotion) {
            camera.parallaxX = (event.clientX / window.innerWidth) * 2 - 1;
            camera.parallaxY = (event.clientY / window.innerHeight) * 2 - 1;
        }

        if (!this.dragging || event.pointerId !== this.pointerId) return;
        if (this.activeTouches.size > 1) return; // pinch takes over

        const dx = event.clientX - this.lastX;
        const dy = event.clientY - this.lastY;
        this.lastX = event.clientX;
        this.lastY = event.clientY;
        this.movedDistance += Math.abs(dx) + Math.abs(dy);
        if (this.movedDistance > 6) this.setDragState(true);

        // Deliberately gentle: a full screen-width drag is ~1 radian.
        camera.baseTheta -= dx * 0.0032;
        camera.basePhi = clamp(camera.basePhi - dy * 0.0026, 0.18, Math.PI - 0.18);
    };

    onPointerUp = (event) => {
        this.activeTouches.delete(event.pointerId);
        if (this.activeTouches.size < 2) this.pinchDistance = 0;

        const wasDragging = this.dragging && event.pointerId === this.pointerId;
        this.dragging = false;
        this.pointerId = null;
        this.setDragState(false);

        // A press that barely moved counts as a click, not a drag.
        if (wasDragging && this.movedDistance < 6 && this.onClick && !this.blockedTarget(event)) {
            this.onClick(event);
        }
    };

    /** Two-finger pinch to zoom, only while the gesture is over the stage. */
    onTouchMove = (event) => {
        if (event.touches.length !== 2) return;
        const [a, b] = event.touches;
        if (!this.withinSurface(a.clientX, a.clientY)) return;

        const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (this.pinchDistance > 0) {
            const delta = this.pinchDistance - distance;
            this.camera.baseRadius = clamp(
                this.camera.baseRadius + delta * 0.02,
                this.camera.minRadius,
                this.camera.maxRadius
            );
            event.preventDefault(); // we are handling this gesture
        }
        this.pinchDistance = distance;
    };

    dispose() {
        this.handlers.forEach(([target, type, handler, options]) => {
            target.removeEventListener(type, handler, options);
        });
        this.handlers.length = 0;
        this.setDragState(false);
    }
}
