/* ============================================================
   galaxy/bloom.js
   A compact three-pass bloom, kept as its own module so the
   particle renderer doesn't have to know post-processing exists
   when a device can't afford it.

   Pipeline: scene (offscreen) -> bright-pass -> blur x N -> composite.
   The blur stages run at a fraction of the canvas resolution,
   which is where nearly all the cost saving comes from — a soft
   halo does not need full-resolution sampling to look right.
   ============================================================ */

import {
    FULLSCREEN_VERTEX_SHADER,
    BRIGHTPASS_FRAGMENT_SHADER,
    BLUR_FRAGMENT_SHADER,
    COMPOSITE_FRAGMENT_SHADER,
} from './shaders.js';

function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error('Bloom shader compile failed: ' + log);
    }
    return shader;
}

function link(gl, vs, fs) {
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        throw new Error('Bloom program link failed: ' + log);
    }
    return program;
}

/** One colour-texture framebuffer at a given size. */
function createTarget(gl, width, height) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteTexture(texture);
        gl.deleteFramebuffer(framebuffer);
        return null;
    }
    return { texture, framebuffer, width, height };
}

function deleteTarget(gl, target) {
    if (!target) return;
    gl.deleteTexture(target.texture);
    gl.deleteFramebuffer(target.framebuffer);
}

export class BloomPipeline {
    /**
     * @throws if the device cannot support the required GL features —
     * callers should catch this and run without bloom instead.
     */
    constructor(gl, options = {}) {
        this.gl = gl;
        this.threshold = options.threshold ?? 0.55;
        this.strength = options.strength ?? 0.85;
        this.blurScale = options.blurScale ?? 0.38; // fraction of canvas resolution
        this.blurPasses = options.blurPasses ?? 2;   // horizontal+vertical pairs

        const vs = compile(gl, gl.VERTEX_SHADER, FULLSCREEN_VERTEX_SHADER);
        const brightFs = compile(gl, gl.FRAGMENT_SHADER, BRIGHTPASS_FRAGMENT_SHADER);
        const blurFs = compile(gl, gl.FRAGMENT_SHADER, BLUR_FRAGMENT_SHADER);
        const compositeFs = compile(gl, gl.FRAGMENT_SHADER, COMPOSITE_FRAGMENT_SHADER);

        this.brightProgram = link(gl, vs, brightFs);
        this.blurProgram = link(gl, vs, blurFs);
        this.compositeProgram = link(gl, vs, compositeFs);
        gl.deleteShader(vs);
        gl.deleteShader(brightFs);
        gl.deleteShader(blurFs);
        gl.deleteShader(compositeFs);

        this.uniforms = {
            bright: { uScene: gl.getUniformLocation(this.brightProgram, 'uScene'),
                      uThreshold: gl.getUniformLocation(this.brightProgram, 'uThreshold') },
            blur: { uTex: gl.getUniformLocation(this.blurProgram, 'uTex'),
                    uTexelStep: gl.getUniformLocation(this.blurProgram, 'uTexelStep') },
            composite: { uScene: gl.getUniformLocation(this.compositeProgram, 'uScene'),
                         uBloom: gl.getUniformLocation(this.compositeProgram, 'uBloom'),
                         uBloomStrength: gl.getUniformLocation(this.compositeProgram, 'uBloomStrength') },
        };

        // One shared fullscreen-triangle vertex buffer for every pass.
        this.quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        this.aPosition = gl.getAttribLocation(this.brightProgram, 'aPosition');

        this.scene = null;
        this.bright = null;
        this.blurA = null;
        this.blurB = null;
        this.width = 0;
        this.height = 0;
    }

    resize(width, height) {
        if (width === this.width && height === this.height && this.scene) return;
        const gl = this.gl;
        this.width = width;
        this.height = height;

        deleteTarget(gl, this.scene);
        deleteTarget(gl, this.bright);
        deleteTarget(gl, this.blurA);
        deleteTarget(gl, this.blurB);

        const bw = Math.max(2, Math.round(width * this.blurScale));
        const bh = Math.max(2, Math.round(height * this.blurScale));

        this.scene = createTarget(gl, width, height);
        this.bright = createTarget(gl, bw, bh);
        this.blurA = createTarget(gl, bw, bh);
        this.blurB = createTarget(gl, bw, bh);

        if (!this.scene || !this.bright || !this.blurA || !this.blurB) {
            throw new Error('Bloom framebuffers unsupported on this device');
        }
    }

    /** Redirect the particle renderer's draw calls into the offscreen scene target. */
    beginScene() {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.framebuffer);
        gl.viewport(0, 0, this.scene.width, this.scene.height);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    drawFullscreen(program, uniforms, uniformSetup) {
        const gl = this.gl;
        gl.useProgram(program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        gl.enableVertexAttribArray(this.aPosition);
        gl.vertexAttribPointer(this.aPosition, 2, gl.FLOAT, false, 0, 0);
        uniformSetup(uniforms);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /** Run bright-pass + blur, then composite onto the real canvas. */
    finish() {
        const gl = this.gl;
        gl.disable(gl.BLEND); // every post pass is a full overwrite, not a blend

        // --- bright-pass: scene -> bright (downsampled) ---
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.bright.framebuffer);
        gl.viewport(0, 0, this.bright.width, this.bright.height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.scene.texture);
        this.drawFullscreen(this.brightProgram, this.uniforms.bright, (u) => {
            gl.uniform1i(u.uScene, 0);
            gl.uniform1f(u.uThreshold, this.threshold);
        });

        // --- separable blur, ping-ponging between blurA/blurB ---
        let source = this.bright;
        let destination = this.blurA;
        const texel = [1 / this.bright.width, 1 / this.bright.height];

        for (let pass = 0; pass < this.blurPasses; pass++) {
            // horizontal
            gl.bindFramebuffer(gl.FRAMEBUFFER, destination.framebuffer);
            gl.viewport(0, 0, destination.width, destination.height);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, source.texture);
            this.drawFullscreen(this.blurProgram, this.uniforms.blur, (u) => {
                gl.uniform1i(u.uTex, 0);
                gl.uniform2f(u.uTexelStep, texel[0], 0);
            });

            const horizontalResult = destination;
            source = horizontalResult;
            destination = source === this.blurA ? this.blurB : this.blurA;

            // vertical
            gl.bindFramebuffer(gl.FRAMEBUFFER, destination.framebuffer);
            gl.viewport(0, 0, destination.width, destination.height);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, source.texture);
            this.drawFullscreen(this.blurProgram, this.uniforms.blur, (u) => {
                gl.uniform1i(u.uTex, 0);
                gl.uniform2f(u.uTexelStep, 0, texel[1]);
            });

            source = destination;
            destination = source === this.blurA ? this.blurB : this.blurA;
        }

        // --- composite: scene + blurred highlights -> real canvas ---
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.width, this.height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.scene.texture);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, source.texture);
        this.drawFullscreen(this.compositeProgram, this.uniforms.composite, (u) => {
            gl.uniform1i(u.uScene, 0);
            gl.uniform1i(u.uBloom, 1);
            gl.uniform1f(u.uBloomStrength, this.strength);
        });

        gl.enable(gl.BLEND); // restore state for the next frame's particle draws
    }

    dispose() {
        const gl = this.gl;
        deleteTarget(gl, this.scene);
        deleteTarget(gl, this.bright);
        deleteTarget(gl, this.blurA);
        deleteTarget(gl, this.blurB);
        gl.deleteBuffer(this.quad);
        gl.deleteProgram(this.brightProgram);
        gl.deleteProgram(this.blurProgram);
        gl.deleteProgram(this.compositeProgram);
    }
}
