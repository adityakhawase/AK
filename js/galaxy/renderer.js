/* ============================================================
   galaxy/renderer.js
   WebGL point-cloud renderer.

   Two programs share the same vertex shader (position, rotation,
   fog, ripple are identical for every layer) but differ in the
   fragment stage:
     - additive program: stars, nebula, core glow, deep field —
       light that adds on top of what is already there.
     - multiply program: dust — a tint the frame is multiplied
       BY, which is what lets dust actually darken the stars
       behind it instead of just glowing over them.

   Bloom, when enabled, is an optional third stage: particles are
   drawn into an offscreen target instead of the canvas, then
   BloomPipeline composites scene + blurred highlights onto the
   real canvas. Draw order still never matters within a layer —
   nothing here sorts a single particle.
   ============================================================ */

import { VERTEX_SHADER, FRAGMENT_SHADER, DUST_FRAGMENT_SHADER } from './shaders.js';
import { mat4Identity, mat4Perspective, mat4LookAt } from './math.js';
import { BloomPipeline } from './bloom.js';

const UNIFORM_NAMES = [
    'uProjection', 'uView', 'uTime', 'uPixelRatio', 'uSizeScale',
    'uSpin', 'uTwinkle', 'uDrift', 'uFogNear', 'uFogFar',
    'uRippleOrigin', 'uRippleAge', 'uOpacity', 'uSoftness', 'uFade',
];

function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error('Shader compile failed: ' + log);
    }
    return shader;
}

function buildProgram(gl, vertexSource, fragmentSource) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        throw new Error('Program link failed: ' + log);
    }

    const uniforms = {};
    UNIFORM_NAMES.forEach((name) => {
        uniforms[name] = gl.getUniformLocation(program, name);
    });
    const attributes = {
        aPosition: gl.getAttribLocation(program, 'aPosition'),
        aColor: gl.getAttribLocation(program, 'aColor'),
        aSize: gl.getAttribLocation(program, 'aSize'),
        aSeed: gl.getAttribLocation(program, 'aSeed'),
    };

    return { program, uniforms, attributes };
}

export function isWebGLAvailable() {
    try {
        const canvas = document.createElement('canvas');
        return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
    } catch (err) {
        return false;
    }
}

export class GalaxyRenderer {
    constructor(canvas) {
        const attributes = {
            alpha: true,
            antialias: false,       // point sprites are already soft; MSAA is wasted here
            depth: false,           // additive/multiply blending needs no depth buffer
            stencil: false,
            powerPreference: 'high-performance',
            preserveDrawingBuffer: false,
            failIfMajorPerformanceCaveat: false,
        };

        const gl = canvas.getContext('webgl2', attributes)
                || canvas.getContext('webgl', attributes);
        if (!gl) throw new Error('WebGL unavailable');

        this.canvas = canvas;
        this.gl = gl;
        this.additive = buildProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
        this.multiply = buildProgram(gl, VERTEX_SHADER, DUST_FRAGMENT_SHADER);
        this.layers = [];
        this.bloom = null;

        this.projection = mat4Identity(new Float32Array(16));
        this.view = mat4Identity(new Float32Array(16));

        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.clearColor(0, 0, 0, 0);
    }

    /**
     * Enable the bloom post-process. Safe to call once, after all layers
     * are added. Throws if the device can't support the extra
     * framebuffers — callers should catch this and continue without it.
     */
    enableBloom(options) {
        this.bloom = new BloomPipeline(this.gl, options);
    }

    disableBloom() {
        if (this.bloom) {
            this.bloom.dispose();
            this.bloom = null;
        }
    }

    /**
     * Upload one particle layer to the GPU.
     * `settings.blend` — 'additive' (default) or 'multiply'.
     */
    addLayer(data, settings = {}) {
        const gl = this.gl;
        const makeBuffer = (array) => {
            const buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.bufferData(gl.ARRAY_BUFFER, array, gl.STATIC_DRAW);
            return buffer;
        };

        this.layers.push({
            name: settings.name || 'layer',
            enabled: true,
            blend: settings.blend === 'multiply' ? 'multiply' : 'additive',
            count: data.count,
            position: makeBuffer(data.positions),
            color: makeBuffer(data.colors),
            size: makeBuffer(data.sizes),
            seed: makeBuffer(data.seeds),
            spin: settings.spin ?? 0.05,
            opacity: settings.opacity ?? 1.0,
            softness: settings.softness ?? 1.6,
            twinkle: settings.twinkle ?? 0.0,
            drift: settings.drift ?? 0.0,
            fogNear: settings.fogNear ?? 1.2,
            fogFar: settings.fogFar ?? 60.0,
        });
    }

    setLayerEnabled(name, enabled) {
        const layer = this.layers.find((l) => l.name === name);
        if (layer) layer.enabled = enabled;
    }

    /** Resize the drawing buffer to match the CSS box. Returns true if it changed. */
    resize(pixelRatio) {
        const canvas = this.canvas;
        const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
        const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
        const changed = canvas.width !== width || canvas.height !== height;
        if (changed) {
            canvas.width = width;
            canvas.height = height;
        }
        if (this.bloom) this.bloom.resize(width, height);
        return changed;
    }

    render(state) {
        const gl = this.gl;
        const { camera, time, pixelRatio, fade, ripple } = state;

        const aspect = this.canvas.width / Math.max(1, this.canvas.height);
        const shift = camera.screenOffset || [0, 0];
        mat4Perspective(this.projection, camera.fov, aspect, 0.1, 400, shift[0], shift[1]);
        mat4LookAt(this.view, camera.position, camera.target, [0, 1, 0]);

        if (this.bloom) {
            this.bloom.beginScene();
        } else {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, this.canvas.width, this.canvas.height);
            gl.clear(gl.COLOR_BUFFER_BIT);
        }

        for (let i = 0; i < this.layers.length; i++) {
            const layer = this.layers[i];
            if (!layer.enabled) continue;

            const ctx = layer.blend === 'multiply' ? this.multiply : this.additive;
            gl.useProgram(ctx.program);

            if (layer.blend === 'multiply') {
                gl.blendFunc(gl.ZERO, gl.SRC_COLOR); // dst = dst * src
            } else {
                gl.blendFunc(gl.ONE, gl.ONE);         // dst = dst + src
            }

            const u = ctx.uniforms;
            gl.uniformMatrix4fv(u.uProjection, false, this.projection);
            gl.uniformMatrix4fv(u.uView, false, this.view);
            gl.uniform1f(u.uTime, time);
            gl.uniform1f(u.uPixelRatio, pixelRatio);
            /* Projection scale in device pixels, derived from fov and buffer
               height, so a star keeps the same apparent size on a phone and
               a 4K display. */
            gl.uniform1f(u.uSizeScale, this.canvas.height / (2 * Math.tan(camera.fov / 2)));
            gl.uniform1f(u.uFade, fade);
            gl.uniform3f(u.uRippleOrigin, ripple.origin[0], ripple.origin[1], ripple.origin[2]);
            gl.uniform1f(u.uRippleAge, ripple.age);

            gl.uniform1f(u.uSpin, layer.spin);
            gl.uniform1f(u.uOpacity, layer.opacity);
            gl.uniform1f(u.uSoftness, layer.softness);
            gl.uniform1f(u.uTwinkle, layer.twinkle);
            gl.uniform1f(u.uDrift, layer.drift);
            gl.uniform1f(u.uFogNear, layer.fogNear);
            gl.uniform1f(u.uFogFar, layer.fogFar);

            this.bindAttribute(ctx.attributes.aPosition, layer.position, 3);
            this.bindAttribute(ctx.attributes.aColor, layer.color, 3);
            this.bindAttribute(ctx.attributes.aSize, layer.size, 1);
            this.bindAttribute(ctx.attributes.aSeed, layer.seed, 1);

            gl.drawArrays(gl.POINTS, 0, layer.count);
        }

        if (this.bloom) this.bloom.finish();
    }

    bindAttribute(location, buffer, components) {
        if (location < 0) return;
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, components, gl.FLOAT, false, 0, 0);
    }

    dispose() {
        const gl = this.gl;
        this.layers.forEach((layer) => {
            gl.deleteBuffer(layer.position);
            gl.deleteBuffer(layer.color);
            gl.deleteBuffer(layer.size);
            gl.deleteBuffer(layer.seed);
        });
        this.layers.length = 0;
        this.disableBloom();
        gl.deleteProgram(this.additive.program);
        gl.deleteProgram(this.multiply.program);
    }
}
