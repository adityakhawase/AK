/* ============================================================
   car-game.js — Neon Rush, an endless 3D night-highway driver.

   Real 3D via Three.js (CDN, pinned). Everything else is
   generated in code: road texture (canvas), all car geometry
   (boxes/cylinders), coin/star particles, engine/coin/crash
   sounds (WebAudio). No binary assets, no build step.

   Model: the player sits near z = 0 and steers in x; the world
   (traffic, coins, lamps, road texture) streams toward +z at the
   player's speed. Fog hides the spawn line.
   ============================================================ */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* ------------------------------------------------------------
   Config
------------------------------------------------------------ */
const ROAD_HALF = 6;          // asphalt half-width (3 lanes)
const LIMIT_X = 6.9;          // hard lateral clamp (rails at +-7.5)
const RAIL_SCRAPE_X = 6.25;   // rails start scraping here
const SPAWN_Z = -250;         // spawn line, deep inside the fog
const KILL_Z = 16;            // recycle line behind the camera
const LANES = [-4, 0, 4];
const BEST_KEY = 'neon-rush-best';
const BOARD_KEY = 'neon-rush-board-v1';
const NAME_KEY = 'neon-rush-name';
const DAY_LENGTH = 150;       // seconds per full daylight cycle
const IS_TOUCH_DEVICE =
    (typeof window !== 'undefined' && ('ontouchstart' in window || (navigator && navigator.maxTouchPoints > 0))) ||
    (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
if (IS_TOUCH_DEVICE && typeof document !== 'undefined') document.body.classList.add('is-touch');

const TRAFFIC_COLORS = [0xff2fb3, 0x38bdf8, 0xffa62b, 0xf5f5f5, 0xffd75e, 0x7c5cff];

/* Small math helpers */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
};
const damp = (cur, target, rate, dt) => lerp(cur, target, 1 - Math.exp(-rate * dt));

/* ------------------------------------------------------------
   Tiny DOM helpers
------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);

const holder = $('game-canvas-holder');
if (!holder) throw new Error('game holder missing');

const hudSpeed = $('hud-speed').querySelector('b');
const hudScore = $('hud-score').querySelector('b');
const hudCoins = $('hud-coins').querySelector('b');
const menuOverlay = $('game-menu');
const overOverlay = $('game-over');
const pauseOverlay = $('game-paused');
const flash = $('game-crash-flash');

/* ------------------------------------------------------------
   Audio — all synthesized, created on first user gesture
------------------------------------------------------------ */
const Sound = {
    ctx: null,
    engineOsc: null,
    engineGain: null,
    muted: false,

    init() {
        if (this.ctx) return;
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            this.ctx = new AC();
            // Engine hum: sawtooth through a lowpass, pitch follows speed.
            this.engineOsc = this.ctx.createOscillator();
            this.engineOsc.type = 'sawtooth';
            this.engineOsc.frequency.value = 60;
            const filter = this.ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 400;
            this.engineGain = this.ctx.createGain();
            this.engineGain.gain.value = 0.0;
            this.engineOsc.connect(filter).connect(this.engineGain).connect(this.ctx.destination);
            this.engineOsc.start();
        } catch (error) {
            this.ctx = null;
        }
    },

    resume() {
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },

    engine(ratio, on) {
        if (!this.ctx || !this.engineOsc) return;
        const t = this.ctx.currentTime;
        this.engineOsc.frequency.setTargetAtTime(55 + ratio * 160, t, 0.1);
        this.engineGain.gain.setTargetAtTime(!this.muted && on ? 0.045 : 0.0, t, 0.15);
    },

    blip(freq = 990, dur = 0.09, type = 'square', vol = 0.08) {
        if (!this.ctx || this.muted) return;
        try {
            const t = this.ctx.currentTime;
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, t);
            gain.gain.setValueAtTime(vol, t);
            gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
            osc.connect(gain).connect(this.ctx.destination);
            osc.start(t);
            osc.stop(t + dur + 0.02);
        } catch (error) { /* ignore */ }
    },

    coin() { this.blip(880, 0.08); setTimeout(() => this.blip(1320, 0.12), 70); },
    nearMiss() { this.blip(660, 0.07, 'sine', 0.06); },

    crash() {
        if (!this.ctx || this.muted) return;
        try {
            const t = this.ctx.currentTime;
            const len = this.ctx.sampleRate * 0.4;
            const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
            const noise = this.ctx.createBufferSource();
            noise.buffer = buffer;
            const gain = this.ctx.createGain();
            gain.gain.setValueAtTime(0.25, t);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
            const filter = this.ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 900;
            noise.connect(filter).connect(gain).connect(this.ctx.destination);
            noise.start(t);
        } catch (error) { /* ignore */ }
    },
};

/* ------------------------------------------------------------
   Renderer / scene / camera
------------------------------------------------------------ */
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, IS_TOUCH_DEVICE ? 1.75 : 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Filmic tone mapping + studio reflections: the single biggest
// realism win for the PBR car paint, zero HDR files needed.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
holder.appendChild(renderer.domElement);
renderer.domElement.style.touchAction = 'none';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05050a);
scene.fog = new THREE.FogExp2(0x05050a, 0.011);

// Image-based lighting so metals and car paint have real reflections.
try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
} catch (error) { /* non-fatal: flat lighting fallback */ }

const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 800);

const hemi = new THREE.HemisphereLight(0x8fb8ff, 0x0a0a12, 0.55);
scene.add(hemi);
// Key light doubles as the shadow caster (sun by day, moon by night);
// it follows the player (position updated per frame) so shadows stay
// crisp up close. 2048 map + normalBias = clean, acne-free shadows.
const sun = new THREE.DirectionalLight(0xbfd4ff, 1.6);
sun.castShadow = true;
sun.shadow.mapSize.set(IS_TOUCH_DEVICE ? 1024 : 2048, IS_TOUCH_DEVICE ? 1024 : 2048);
sun.shadow.camera.left = -20;
sun.shadow.camera.right = 20;
sun.shadow.camera.top = 22;
sun.shadow.camera.bottom = -32;
sun.shadow.camera.near = 5;
sun.shadow.camera.far = 160;
sun.shadow.bias = -0.0002;
sun.shadow.normalBias = 0.025;
scene.add(sun);
scene.add(sun.target);
// Soft fill so shadowed sides never go pitch black.
const fill = new THREE.DirectionalLight(0x6a7cff, 0.22);
fill.position.set(12, 18, 10);
scene.add(fill);

/* ------------------------------------------------------------
   Ground, road, rails, stars, lamps + environment
------------------------------------------------------------ */
function makeGlowTexture(inner, outer) {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 2, 64, 64, 62);
    grad.addColorStop(0, inner);
    grad.addColorStop(0.35, outer);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}
const TEX_HEAD_GLOW = makeGlowTexture('rgba(255,250,225,1)', 'rgba(255,220,150,0.35)');
const TEX_TAIL_GLOW = makeGlowTexture('rgba(255,70,90,1)', 'rgba(255,30,60,0.35)');
const TEX_SUN_GLOW = makeGlowTexture('rgba(255,244,214,1)', 'rgba(255,190,120,0.28)');
const TEX_CLOUD = makeGlowTexture('rgba(255,255,255,0.9)', 'rgba(255,255,255,0.28)');

function makeRoadTexture() {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#17171f';
    g.fillRect(0, 0, 256, 256);
    // Asphalt noise.
    for (let i = 0; i < 1100; i++) {
        const v = 20 + Math.random() * 16;
        g.fillStyle = `rgb(${v},${v},${v + 7})`;
        g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
    }
    // Subtle tyre-polish bands per lane for a lived-in highway.
    g.fillStyle = 'rgba(0,0,0,0.16)';
    [42, 128, 213].forEach((x) => {
        g.fillRect(x - 16, 0, 12, 256);
        g.fillRect(x + 4, 0, 12, 256);
    });
    // Edge lines.
    g.fillStyle = '#e8e8ef';
    g.fillRect(6, 0, 4, 256);
    g.fillRect(246, 0, 4, 256);
    // Lane dashes at the 1/3 and 2/3 marks (3 lanes).
    g.fillStyle = '#ffd75e';
    [85, 170].forEach((x) => {
        g.fillRect(x - 2, 20, 4, 90);
    });
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 60);
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 900),
    new THREE.MeshStandardMaterial({ color: 0x0b0f0c, roughness: 1, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.set(0, -0.05, -250);
ground.receiveShadow = true;
scene.add(ground);

const roadTexture = makeRoadTexture();
const road = new THREE.Mesh(
    new THREE.PlaneGeometry(ROAD_HALF * 2, 620),
    new THREE.MeshStandardMaterial({ map: roadTexture, roughness: 0.85, metalness: 0.05 })
);
road.rotation.x = -Math.PI / 2;
road.position.set(0, 0, -250);
road.receiveShadow = true;
scene.add(road);

// Grass verges + sidewalks frame the asphalt so day mode reads real.
(function addVerges() {
    const grassMat = new THREE.MeshStandardMaterial({ color: 0x14301c, roughness: 1 });
    const walkMat = new THREE.MeshStandardMaterial({ color: 0x23232e, roughness: 0.95 });
    [-1, 1].forEach((s) => {
        const grass = new THREE.Mesh(new THREE.PlaneGeometry(30, 620), grassMat);
        grass.rotation.x = -Math.PI / 2;
        grass.position.set(s * (ROAD_HALF + 16.5), -0.03, -250);
        grass.receiveShadow = true;
        scene.add(grass);
        const walk = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 620), walkMat);
        walk.rotation.x = -Math.PI / 2;
        walk.position.set(s * (ROAD_HALF + 1.6), -0.01, -250);
        walk.receiveShadow = true;
        scene.add(walk);
    });
})();

// Neon rails telegraph the lateral limits (emissive so bloom-like).
function makeRail(x, color) {
    const rail = new THREE.Mesh(
        new THREE.BoxGeometry(0.25, 0.5, 620),
        new THREE.MeshStandardMaterial({ color: 0x111116, emissive: color, emissiveIntensity: 1.4, roughness: 0.4 })
    );
    rail.position.set(x, 0.25, -250);
    scene.add(rail);
    const post = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.5, 620),
        new THREE.MeshStandardMaterial({ color: 0x1a1a22, roughness: 0.8 })
    );
    post.position.set(x, -0.05, -250);
    scene.add(post);
}
makeRail(-7.5, 0x00ff88);
makeRail(7.5, 0xff2fb3);

// Low-poly roadside trees (cheap cones) — recycled with the world.
const trees = [];
(function buildTrees() {
    const trunkGeo = new THREE.CylinderGeometry(0.12, 0.18, 1.2, 6);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3421, roughness: 1 });
    const leafGeo = new THREE.ConeGeometry(1.1, 2.6, 7);
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x1d5c2e, roughness: 1 });
    for (let i = 0; i < 30; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const t = new THREE.Group();
        const trunk = new THREE.Mesh(trunkGeo, trunkMat);
        trunk.position.y = 0.6;
        trunk.castShadow = true;
        const leaves = new THREE.Mesh(leafGeo, leafMat);
        leaves.position.y = 2.4;
        leaves.castShadow = true;
        t.add(trunk, leaves);
        t.position.set(side * (11 + Math.random() * 14), 0, -i * 20 - Math.random() * 8);
        const s = 0.8 + Math.random() * 0.9;
        t.scale.setScalar(s);
        scene.add(t);
        trees.push(t);
    }
})();

// Distant hills sit outside the fog edge and sell the horizon by day.
(function buildHills() {
    const mat = new THREE.MeshBasicMaterial({ color: 0x0d1626 });
    mat.fog = true;
    [[-90, -420, 120, 46], [70, -460, 150, 60], [0, -520, 220, 70]].forEach(([x, z, w, h]) => {
        const hill = new THREE.Mesh(new THREE.ConeGeometry(w / 2, h, 5), mat);
        hill.position.set(x, h / 2 - 4, z);
        scene.add(hill);
    });
})();

// Stars (fade out by day).
let starMat;
(function addStars() {
    const n = 420;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const r = 320 + Math.random() * 220;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.random() * Math.PI * 0.42;
        pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        pos[i * 3 + 1] = r * Math.cos(phi) + 8;
        pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta) - 120;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    starMat = new THREE.PointsMaterial({ color: 0xcfe0ff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 1 });
    scene.add(new THREE.Points(geo, starMat));
})();

// Sun + moon billboards orbit with the daylight cycle.
const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX_SUN_GLOW, color: 0xfff3cf, fog: false, depthWrite: false, transparent: true }));
sunSprite.scale.setScalar(90);
scene.add(sunSprite);
const moonSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX_SUN_GLOW, color: 0xcfe0ff, fog: false, depthWrite: false, transparent: true, opacity: 0.9 }));
moonSprite.scale.setScalar(34);
scene.add(moonSprite);

// Daytime clouds: soft drifting sprites, invisible at night.
const clouds = [];
(function buildClouds() {
    for (let i = 0; i < 10; i++) {
        const m = new THREE.SpriteMaterial({ map: TEX_CLOUD, transparent: true, opacity: 0, depthWrite: false, fog: false });
        const s = new THREE.Sprite(m);
        s.position.set((Math.random() - 0.5) * 360, 60 + Math.random() * 60, -120 - Math.random() * 320);
        s.scale.set(60 + Math.random() * 70, 16 + Math.random() * 14, 1);
        scene.add(s);
        clouds.push({ sprite: s, speed: 0.6 + Math.random() * 1.2 });
    }
})();

// Street lamps, recycled as the world streams past.
const lamps = [];
const lampGroup = new THREE.Group();
scene.add(lampGroup);
let lampHeadMat, lampPoolMat;
(function buildLamps() {
    const poleGeo = new THREE.CylinderGeometry(0.09, 0.12, 6, 6);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x23232e, roughness: 0.6, metalness: 0.6 });
    const headGeo = new THREE.BoxGeometry(0.9, 0.18, 0.4);
    lampHeadMat = new THREE.MeshBasicMaterial({ color: 0xffe6b0 });
    const poolGeo = new THREE.CircleGeometry(3.4, 20);
    lampPoolMat = new THREE.MeshBasicMaterial({
        color: 0xffdf9e, transparent: true, opacity: 0.10,
        blending: THREE.AdditiveBlending, depthWrite: false,
    });
    for (let i = 0; i < 22; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const lamp = new THREE.Group();
        const pole = new THREE.Mesh(poleGeo, poleMat);
        pole.position.y = 3;
        pole.castShadow = true;
        const arm = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.08, 0.12), poleMat);
        arm.position.set(-side * 0.5, 5.9, 0);
        const head = new THREE.Mesh(headGeo, lampHeadMat);
        head.position.set(-side * 0.9, 5.85, 0);
        const pool = new THREE.Mesh(poolGeo, lampPoolMat);
        pool.rotation.x = -Math.PI / 2;
        pool.position.set(-side * 0.9, 0.02, 0);
        lamp.add(pole, arm, head, pool);
        lamp.position.set(side * 9.5, 0, -i * 24);
        lampGroup.add(lamp);
        lamps.push(lamp);
    }
})();
// Two roaming warm lights fake lamp illumination without 22 draw lights.
const lampLights = [];
for (let i = 0; i < 2; i++) {
    const pl = new THREE.PointLight(0xffd9a0, 0, 40, 1.8);
    scene.add(pl);
    lampLights.push(pl);
}

/* ------------------------------------------------------------
   Cars — fixed proportions, real light rigs, true shadows
------------------------------------------------------------ */
function makeBlobShadow(w, l, opacity = 0.5) {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 4, 32, 32, 30);
    grad.addColorStop(0, `rgba(0,0,0,${opacity})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(w, l),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.02;
    mesh.renderOrder = 1;
    return mesh;
}

function headlightSprite(scale = 0.9) {
    const m = new THREE.SpriteMaterial({ map: TEX_HEAD_GLOW, color: 0xfff6d8, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending });
    const s = new THREE.Sprite(m);
    s.scale.setScalar(scale);
    return s;
}

function taillightSprite(scale = 1.1) {
    const m = new THREE.SpriteMaterial({ map: TEX_TAIL_GLOW, color: 0xff3040, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
    const s = new THREE.Sprite(m);
    s.scale.setScalar(scale);
    return s;
}

function buildCar(color, isPlayer) {
    const car = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({
        color, metalness: 0.7, roughness: 0.32,
        emissive: color, emissiveIntensity: isPlayer ? 0.08 : 0.04,
        envMapIntensity: 1.25,
    });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x0b0b12, metalness: 0.4, roughness: 0.6, envMapIntensity: 0.8 });
    const glassMat = new THREE.MeshPhysicalMaterial({
        color: 0x101722, metalness: 0.1, roughness: 0.08,
        transparent: true, opacity: 0.92, envMapIntensity: 1.6,
        clearcoat: 1, clearcoatRoughness: 0.08,
    });

    // Lower body + sculpted nose + side skirts (no more floating box).
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.55, 4.2), paint);
    body.position.y = 0.62;
    const nose = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.34, 0.9), paint);
    nose.position.set(0, 0.48, -2.35);
    const skirtGeo = new THREE.BoxGeometry(0.14, 0.22, 3.4);
    const skirtL = new THREE.Mesh(skirtGeo, darkMat);
    skirtL.position.set(-1.02, 0.32, 0);
    const skirtR = new THREE.Mesh(skirtGeo, darkMat);
    skirtR.position.set(1.02, 0.32, 0);
    // Windshield + cabin glass + roof so it reads as a car, not a box.
    const shield = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.42, 0.9), glassMat);
    shield.position.set(0, 1.02, -0.75);
    shield.rotation.x = -0.28;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.42, 1.5), glassMat);
    cabin.position.set(0, 1.1, 0.45);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.08, 1.1), paint);
    roof.position.set(0, 1.34, 0.4);
    // Front grille + bumper + mirrors + spoiler + exhausts.
    const grille = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.2, 0.08), darkMat);
    grille.position.set(0, 0.42, -2.81);
    const mirrorGeo = new THREE.BoxGeometry(0.22, 0.1, 0.14);
    const mirL = new THREE.Mesh(mirrorGeo, darkMat);
    mirL.position.set(-1.05, 1.0, -0.6);
    const mirR = new THREE.Mesh(mirrorGeo, darkMat);
    mirR.position.set(1.05, 1.0, -0.6);
    car.add(body, nose, skirtL, skirtR, shield, cabin, roof, grille, mirL, mirR);
    if (isPlayer) {
        const wingMat = darkMat;
        const wing = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.08, 0.4), wingMat);
        wing.position.set(0, 1.15, 2.0);
        const strutGeo = new THREE.BoxGeometry(0.08, 0.4, 0.12);
        const s1 = new THREE.Mesh(strutGeo, wingMat);
        s1.position.set(-0.6, 0.95, 2.0);
        const s2 = new THREE.Mesh(strutGeo, wingMat);
        s2.position.set(0.6, 0.95, 2.0);
        car.add(wing, s1, s2);
        const exGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.18, 10);
        const exMat = new THREE.MeshStandardMaterial({ color: 0x888890, metalness: 0.9, roughness: 0.3 });
        [-0.35, 0.35].forEach((x) => {
            const ex = new THREE.Mesh(exGeo, exMat);
            ex.rotation.x = Math.PI / 2;
            ex.position.set(x, 0.32, 2.14);
            car.add(ex);
        });
    }

    // Wheels: tyre + rim + hub, tucked under the arches (no clip).
    const wheelGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.32, 16);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111116, roughness: 0.9 });
    const rimGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.34, 8);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xb8bec9, metalness: 0.9, roughness: 0.3 });
    const wheels = [];
    [[-1.0, -1.4], [1.0, -1.4], [-1.0, 1.4], [1.0, 1.4]].forEach(([x, z]) => {
        const w = new THREE.Group();
        const tyre = new THREE.Mesh(wheelGeo, wheelMat);
        tyre.rotation.z = Math.PI / 2;
        tyre.castShadow = true;
        const rim = new THREE.Mesh(rimGeo, rimMat);
        rim.rotation.z = Math.PI / 2;
        w.add(tyre, rim);
        w.position.set(x, 0.38, z);
        car.add(w);
        wheels.push(w);
    });

    // Rear light bar: emissive mesh + red halo sprites (brake-boostable).
    const tailMat = new THREE.MeshStandardMaterial({
        color: 0x330000, emissive: 0xff1a2e, emissiveIntensity: 2.2, roughness: 0.3,
    });
    const tail = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.16, 0.1), tailMat);
    tail.position.set(0, 0.72, 2.12);
    car.add(tail);
    const tailGlowL = taillightSprite(1.0);
    tailGlowL.position.set(-0.6, 0.72, 2.2);
    const tailGlowR = taillightSprite(1.0);
    tailGlowR.position.set(0.6, 0.72, 2.2);
    car.add(tailGlowL, tailGlowR);

    // Headlights: bright lens + halo sprite at the nose.
    const headMat = new THREE.MeshStandardMaterial({
        color: 0x444422, emissive: 0xfff3cf, emissiveIntensity: 3.2, roughness: 0.2,
    });
    const headGlows = [];
    [-0.62, 0.62].forEach((x) => {
        const housing = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.18, 0.1), darkMat);
        housing.position.set(x, 0.62, -2.79);
        const lens = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 12), headMat);
        lens.position.set(x, 0.62, -2.84);
        const glow = headlightSprite(0.85);
        glow.position.set(x, 0.62, -2.95);
        car.add(housing, lens, glow);
        headGlows.push(glow);
    });

    car.add(makeBlobShadow(3.0, 5.2, 0.5));
    car.userData.wheels = wheels;
    car.userData.tailMat = tailMat;
    car.userData.tailGlows = [tailGlowL, tailGlowR];
    car.userData.headMat = headMat;
    car.userData.headGlows = headGlows;
    // Real shadows: every solid part casts; sprites and the blob stay
    // catcher-only so the car grounds even where the map is soft.
    car.traverse((o) => {
        if (o.isMesh) {
            const transparent = o.material && o.material.transparent;
            const additive = o.material && o.material.blending === THREE.AdditiveBlending;
            o.castShadow = !transparent && !additive;
        }
        if (o.isSprite) o.castShadow = false;
    });
    return car;
}

// Volumetric-feel headlight beams: additive cones + a road pool.
// The cone apex sits at the headlight and widens down-road (like a
// real beam). Opacity is driven by the daylight cycle (strong at night).
const beamMats = [];
function addBeams(car) {
    const beamMat = new THREE.MeshBasicMaterial({
        color: 0xfff2c0, transparent: true, opacity: 0.10,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        fog: false,
    });
    beamMats.push(beamMat);
    [-0.62, 0.62].forEach((x) => {
        const beam = new THREE.Mesh(new THREE.ConeGeometry(1.05, 15, 12, 1, true), beamMat);
        // +PI/2 puts the apex (narrow end) at the headlight and the
        // wide base far down-road; the small extra tilt aims it at
        // the asphalt so it never rears up over the car like a shell.
        beam.rotation.x = Math.PI / 2 - 0.06;
        beam.position.set(x, 0.42, -10);
        beam.renderOrder = 2;
        car.add(beam);
    });
    const poolMat = new THREE.MeshBasicMaterial({
        color: 0xfff2c0, transparent: true, opacity: 0.10,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    beamMats.push(poolMat);
    const pool = new THREE.Mesh(new THREE.CircleGeometry(5.5, 24), poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, 0.03, -9);
    car.add(pool);
}

/* The rig is what physics, collisions and the camera drive.
   Its visible child starts as the detailed fallback and is swapped
   for the real 911 the moment the GLB finishes loading — seamless,
   even mid-race. */
const playerRig = new THREE.Group();
scene.add(playerRig);
const player = playerRig;
let playerVisual = buildCar(0x00ff88, true);
playerRig.add(playerVisual);
addBeams(playerRig);
// Real headlight throw: one spotlight lighting the asphalt ahead.
const headSpot = new THREE.SpotLight(0xfff0c4, 180, 75, 0.55, 0.55, 1.4);
headSpot.position.set(0, 1.4, -1.5);
const headSpotTarget = new THREE.Object3D();
headSpotTarget.position.set(0, 0, -30);
playerRig.add(headSpotTarget);
headSpot.target = headSpotTarget;
playerRig.add(headSpot);
// Red brake glow felt on the road behind.
const brakeLight = new THREE.PointLight(0xff2233, 0, 9, 1.8);
brakeLight.position.set(0, 0.9, 2.6);
playerRig.add(brakeLight);
// Neon underglow: a soft radial pool (no hard rectangle edges).
let underglowMat;
(function addGlow() {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 6, 64, 64, 62);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.28)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const glowTex = new THREE.CanvasTexture(c);
    underglowMat = new THREE.MeshBasicMaterial({
        map: glowTex,
        color: 0x00ff88, transparent: true, opacity: 0.30,
        blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 5.4), underglowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.05;
    glow.renderOrder = 1;
    playerRig.add(glow);
})();
playerRig.position.set(0, 0, 0);

/* ------------------------------------------------------------
   Porsche 911 GT3 RS (models/porsche_gt3_rs.glb, Sketchfab,
   CC-BY-4.0 by Black Snow). Auto-normalized: longest axis to Z,
   rear wing auto-detects which way is forward, scaled to a real
   4.4 m length, planted on the ground. Anything fails → the box
   car keeps driving like nothing happened.
------------------------------------------------------------ */
const MODEL_YAW_FALLBACK = Math.PI; // used only if no wing is found
const carStatus = $('car-status');

function fitPorsche(model) {
    const wrap = new THREE.Group();
    wrap.add(model);

    // 1. Longest horizontal axis becomes Z (length).
    let box = new THREE.Box3().setFromObject(model);
    let size = box.getSize(new THREE.Vector3());
    if (size.x > size.z) {
        model.rotation.y = Math.PI / 2;
        wrap.updateMatrixWorld(true);
        box = new THREE.Box3().setFromObject(wrap);
        size = box.getSize(new THREE.Vector3());
    }

    // 2. Which way is forward? The GT3 RS wears a huge rear wing —
    //    whichever side it sits on is the rear (+z in game space, since
    //    forward is -z). No wing found → assume a Sketchfab +z-front
    //    model and yaw 180° (harmless if the model already faces -z,
    //    still length-aligned on Z).
    wrap.updateMatrixWorld(true);
    const center = box.getCenter(new THREE.Vector3());
    let wingZ = 0;
    let wingCount = 0;
    wrap.traverse((o) => {
        if (o.isMesh && /spoiler|wing/i.test(o.name)) {
            const p = new THREE.Vector3();
            o.getWorldPosition(p);
            wingZ += p.z;
            wingCount++;
        }
    });
    const rearAtPlusZ = wingCount > 0 ? wingZ / wingCount > center.z : false;
    if (!rearAtPlusZ) {
        wrap.rotation.y += MODEL_YAW_FALLBACK;
    }

    // 3. Real-world scale: 4.4 m long.
    wrap.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(wrap);
    size = box.getSize(new THREE.Vector3());
    wrap.scale.setScalar(4.4 / Math.max(size.z, 0.001));

    // 4. Center over the origin and plant the tyres on y = 0.
    wrap.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(wrap);
    const c = box.getCenter(new THREE.Vector3());
    wrap.position.x -= c.x;
    wrap.position.z -= c.z;
    wrap.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(wrap);
    wrap.position.y -= box.min.y;

    return wrap;
}

function collectSpinners(wrap) {
    // True rotating hardware only: tyres, rims, barrels, brake discs.
    // NOTE: "rubbertrim" contains the substring "rim" — a bare /rim/
    // test once spun the 4.75 m body trim (plus door trims + shifter)
    // end-over-end above the car. So this is an allowlist with an
    // explicit deny, and every match is re-hung on a pivot placed at
    // its own bbox center — off-center orbiting is impossible by
    // construction. Calipers stay fixed, like real brakes.
    const allow = /chrome_wheels|wheels_chrome|GT3RS_black|Object_4|Scene_-_Root|brakedisc|brake_disc/i;
    const deny = /caliper|trim|rubber|steer|pedal|line|mirror|glass|interior|shifter|stalk|seat|dash/i;
    const cands = [];
    wrap.traverse((o) => {
        if (!o.isMesh) return;
        if (o.parent && o.parent.name.indexOf('spin-pivot') === 0) return;
        if (deny.test(o.name)) return;
        if (!allow.test(o.name)) return;
        cands.push(o);
    });
    const spinners = [];
    for (const o of cands) {
        if (!o.parent) continue;
        o.geometry.computeBoundingBox();
        const c = o.geometry.boundingBox.getCenter(new THREE.Vector3());
        // Clone: geometries can be shared between corners, and each
        // corner needs its own centering shift.
        const geo = o.geometry.clone();
        geo.translate(-c.x, -c.y, -c.z);
        geo.computeBoundingBox();
        o.geometry = geo;
        const pivot = new THREE.Group();
        pivot.name = 'spin-pivot:' + o.name;
        pivot.position.copy(o.position);
        pivot.quaternion.copy(o.quaternion);
        pivot.scale.copy(o.scale);
        o.position.set(0, 0, 0);
        o.quaternion.identity();
        o.scale.set(1, 1, 1);
        o.parent.add(pivot);
        pivot.add(o);
        pivot.updateMatrixWorld(true);
        spinners.push(pivot);
    }
    return spinners;
}

try {
    new GLTFLoader().load(
        'models/porsche_gt3_rs.glb',
        (gltf) => {
            try {
                const wrap = fitPorsche(gltf.scene);
                wrap.traverse((o) => {
                    if (o.isMesh) {
                        const m = o.material;
                        const transparent = m && m.transparent;
                        const additive = m && m.blending === THREE.AdditiveBlending;
                        o.castShadow = !transparent && !additive;
                        o.receiveShadow = false;
                        if (m && 'envMapIntensity' in m && m.envMapIntensity < 1) m.envMapIntensity = 1.1;
                        // Wake up the real lights: emissive lenses stay bright.
                        if (m && m.emissive && /light|lamp|tail|head|brake|lens/i.test(o.name + ' ' + (m.name || ''))) {
                            m.emissiveIntensity = Math.max(m.emissiveIntensity || 0, 2.0);
                        }
                    }
                    if (o.isSprite) o.castShadow = false;
                });
                // Keep the soft blob under the real car too: it grounds
                // the tyres even outside the shadow camera's crisp core.
                wrap.add(makeBlobShadow(3.0, 5.2, 0.5));
                const spinners = collectSpinners(wrap);
                wrap.userData.wheels = spinners;
                // Re-use the fallback's light rig data so beams/brake
                // code keeps working after the swap.
                wrap.userData.tailMat = playerVisual.userData.tailMat;
                wrap.userData.tailGlows = playerVisual.userData.tailGlows;
                wrap.userData.headMat = playerVisual.userData.headMat;
                wrap.userData.headGlows = playerVisual.userData.headGlows;
                // The real 911 has no sprite halos of its own — graft two
                // headlight + two taillight glows at the shell extremes so
                // it reads at night exactly like the fallback does.
                try {
                    const bb = new THREE.Box3().setFromObject(wrap);
                    const min = bb.min, max = bb.max;
                    const fz = min.z - 0.15, rz = max.z + 0.12;
                    const hy = 0.7, ty = 0.75;
                    [[-0.65, fz, hy, true], [0.65, fz, hy, true], [-0.6, rz, ty, false], [0.6, rz, ty, false]].forEach(([x, z, y, head]) => {
                        const s = head ? headlightSprite(0.85) : taillightSprite(1.0);
                        s.position.set(x, y, z);
                        wrap.add(s);
                        (head ? wrap.userData.headGlows : wrap.userData.tailGlows).push(s);
                    });
                } catch (glowErr) { /* cosmetic only */ }
                if (spinners.length === 0) {
                    console.warn('[neon-rush] no spinning wheels found, car will not show wheel spin');
                }
                wrap.visible = false; // revealed below, first rendered frame
                playerRig.add(wrap);
                playerVisual.visible = false;
                wrap.visible = true;
                playerVisual = wrap;
                if (carStatus) carStatus.textContent = 'Porsche 911 GT3 RS ready.';
            } catch (error) {
                console.warn('[neon-rush] porsche setup failed, keeping box car:', error.message);
                if (carStatus) carStatus.textContent = '';
            }
        },
        undefined,
        (error) => {
            console.warn('[neon-rush] porsche failed to load, keeping box car:', error && error.message);
            if (carStatus) carStatus.textContent = '';
        }
    );
} catch (error) {
    if (carStatus) carStatus.textContent = '';
}

/* ------------------------------------------------------------
   Traffic + coins (pooled, recycled, always solvable)
------------------------------------------------------------ */
const traffic = [];
for (let i = 0; i < 9; i++) {
    const color = TRAFFIC_COLORS[i % TRAFFIC_COLORS.length];
    const mesh = buildCar(color, false);
    mesh.visible = false;
    scene.add(mesh);
    // Traffic gets a forward light pool too so headlights read at night.
    const pool = new THREE.Mesh(
        new THREE.CircleGeometry(3.2, 18),
        new THREE.MeshBasicMaterial({ color: 0xfff2c0, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, 0.03, -6);
    mesh.add(pool);
    mesh.userData.lightPool = pool;
    traffic.push({ mesh, active: false, speed: 18, counted: false, lane: 0, wobble: Math.random() * Math.PI * 2 });
}

function lanesBlockedNear(z, band) {
    const blocked = new Set();
    for (const t of traffic) {
        if (!t.active) continue;
        if (Math.abs(t.mesh.position.z - z) < band) {
            // Map x back to nearest lane index.
            let best = 0, bd = 1e9;
            LANES.forEach((lx, i) => {
                const d = Math.abs(t.mesh.position.x - lx);
                if (d < bd) { bd = d; best = i; }
            });
            if (bd < 2.5) blocked.add(best);
        }
    }
    return blocked;
}

function trafficGapOk(laneX) {
    for (const t of traffic) {
        if (!t.active) continue;
        if (Math.abs(t.mesh.position.x - laneX) < 3 && t.mesh.position.z < SPAWN_Z + 70) return false;
    }
    return true;
}

function spawnTraffic() {
    // Pick a lane, but never seal all three lanes in the same z band —
    // there must always be a way through.
    const order = [0, 1, 2].sort(() => Math.random() - 0.5);
    const blocked = lanesBlockedNear(SPAWN_Z + 20, 55);
    let laneIdx = order.find((i) => !blocked.has(i));
    if (laneIdx === undefined) return; // all lanes busy near spawn: wait
    if (blocked.size >= 2 && Math.random() < 0.75) {
        // When two lanes are already taken, strongly prefer the free one.
        const free = [0, 1, 2].filter((i) => !blocked.has(i));
        if (free.length) laneIdx = free[(Math.random() * free.length) | 0];
    }
    const laneX = LANES[laneIdx];
    if (!trafficGapOk(laneX)) return;
    const t = traffic.find((t) => !t.active);
    if (!t) return;
    t.active = true;
    t.counted = false;
    t.lane = laneIdx;
    t.speed = 14 + Math.random() * 9;
    t.wobble = Math.random() * Math.PI * 2;
    t.mesh.visible = true;
    t.mesh.position.set(laneX + (Math.random() - 0.5) * 0.6, 0, SPAWN_Z - Math.random() * 30);
}

const coins = [];
const coinGeo = new THREE.TorusGeometry(0.55, 0.22, 10, 20);
const coinMat = new THREE.MeshStandardMaterial({
    color: 0xffd75e, metalness: 0.8, roughness: 0.25,
    emissive: 0xffd75e, emissiveIntensity: 0.45,
});
for (let i = 0; i < 14; i++) {
    const m = new THREE.Mesh(coinGeo, coinMat);
    m.visible = false;
    m.position.y = 1.0;
    scene.add(m);
    coins.push({ mesh: m, active: false });
}

function spawnCoin() {
    const c = coins.find((c) => !c.active);
    if (!c) return;
    c.active = true;
    c.mesh.visible = true;
    c.mesh.position.set((Math.random() - 0.5) * (ROAD_HALF * 2 - 2), 1.0, SPAWN_Z - Math.random() * 40);
}

/* ------------------------------------------------------------
   Game state + leaderboard (local top-5)
------------------------------------------------------------ */
const state = {
    mode: 'menu',       // menu | playing | paused | over
    speed: 0,
    maxSpeed: 38,
    elapsed: 0,
    score: 0,
    coins: 0,
    best: 0,
    crashed: false,
    crashTimer: 0,
    shake: 0,
    flash: 0,
    steer: 0,           // smoothed -1..1 steering
    vx: 0,              // smoothed lateral velocity
    bob: 0,             // suspension phase
    dayT: 0.84,         // time of day 0..1 (start late-night → dawn soon)
    dayFactor: 0,       // 0 = night, 1 = full day
    camMode: 0,         // 0 chase, 1 hood, 2 top
    camToast: 0,
    pendingEntry: -1,
};

try {
    state.best = Number(localStorage.getItem(BEST_KEY)) || 0;
} catch (error) { /* private mode */ }

function loadBoard() {
    try {
        const raw = localStorage.getItem(BOARD_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter((e) => e && typeof e.score === 'number').slice(0, 5) : [];
    } catch (error) { return []; }
}
function saveBoard(board) {
    try { localStorage.setItem(BOARD_KEY, JSON.stringify(board.slice(0, 5))); } catch (error) { /* ignore */ }
}
function lastName() {
    try { return localStorage.getItem(NAME_KEY) || 'YOU'; } catch (error) { return 'YOU'; }
}
function boardRank(score) {
    const board = loadBoard();
    let rank = board.length;
    for (let i = 0; i < board.length; i++) {
        if (score > board[i].score) { rank = i; break; }
    }
    return { board, rank };
}
function renderBoard() {
    const board = loadBoard();
    const ol = $('leaderboard');
    if (ol) {
        ol.innerHTML = '';
        if (!board.length) {
            const li = document.createElement('li');
            li.className = 'lb-empty';
            li.textContent = 'No runs yet — be the first.';
            ol.appendChild(li);
        }
        board.forEach((e, i) => {
            const li = document.createElement('li');
            if (i === state.pendingEntry) li.className = 'lb-new';
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
            li.innerHTML = '';
            const m = document.createElement('span');
            m.className = 'lb-medal';
            m.textContent = medal;
            const n = document.createElement('span');
            n.className = 'lb-name';
            n.textContent = String(e.name || 'YOU').slice(0, 12);
            const s = document.createElement('b');
            s.className = 'lb-score';
            s.textContent = String(Math.floor(e.score));
            const c = document.createElement('span');
            c.className = 'lb-coins';
            c.textContent = `🪙${e.coins | 0}`;
            li.append(m, n, s, c);
            ol.appendChild(li);
        });
    }
    const menuBoard = $('menu-board');
    if (menuBoard) {
        menuBoard.innerHTML = '';
        const top = board.slice(0, 3);
        if (!top.length) {
            menuBoard.textContent = 'No lap times yet — set one.';
        } else {
            top.forEach((e, i) => {
                const div = document.createElement('div');
                div.className = 'menu-lb-row';
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
                div.textContent = `${medal} ${String(e.name || 'YOU').slice(0, 12)} — ${Math.floor(e.score)}`;
                menuBoard.appendChild(div);
            });
        }
    }
    const subBoard = $('pill-board');
    if (subBoard) subBoard.textContent = `🏆 ${state.best}`;
}

const input = { left: false, right: false, gas: false, brake: false };

function resetGame() {
    state.speed = 0;
    state.maxSpeed = 38;
    state.elapsed = 0;
    state.score = 0;
    state.coins = 0;
    state.crashed = false;
    state.crashTimer = 0;
    state.shake = 0;
    state.flash = 0;
    state.steer = 0;
    state.vx = 0;
    state.bob = 0;
    state.pendingEntry = -1;
    player.position.x = 0;
    player.rotation.set(0, 0, 0);
    traffic.forEach((t) => { t.active = false; t.mesh.visible = false; });
    coins.forEach((c) => { c.active = false; c.mesh.visible = false; });
    updateHud(true);
}

function startGame() {
    Sound.init();
    Sound.resume();
    resetGame();
    state.mode = 'playing';
    menuOverlay.classList.add('hidden');
    overOverlay.classList.add('hidden');
    pauseOverlay.classList.add('hidden');
}

function endGame() {
    state.mode = 'over';
    const finalScore = Math.floor(state.score);
    if (finalScore > state.best) {
        state.best = finalScore;
        try { localStorage.setItem(BEST_KEY, String(state.best)); } catch (error) { /* ignore */ }
    }
    // Persist to the local top-5 leaderboard.
    const { board, rank } = boardRank(finalScore);
    if (finalScore > 0 && (board.length < 5 || rank < 5)) {
        board.splice(Math.min(rank, board.length), 0, { name: lastName(), score: finalScore, coins: state.coins, date: Date.now() });
        saveBoard(board);
        state.pendingEntry = Math.min(rank, 4);
    } else {
        state.pendingEntry = -1;
    }
    $('final-score').textContent = finalScore;
    $('final-coins').textContent = state.coins;
    $('best-score').textContent = state.best;
    const nameInput = $('lb-name');
    if (nameInput) {
        nameInput.value = lastName();
        nameInput.maxLength = 12;
    }
    const rankNote = $('lb-note');
    if (rankNote) {
        rankNote.textContent = state.pendingEntry >= 0
            ? `New #${state.pendingEntry + 1} on the leaderboard — edit your name and it saves.`
            : (finalScore > 0 ? 'Outside the top 5 this time — one more run?' : 'Score some points to join the board.');
    }
    renderBoard();
    overOverlay.classList.remove('hidden');
    Sound.engine(0, false);
}

function pauseGame() {
    if (state.mode !== 'playing') return;
    state.mode = 'paused';
    pauseOverlay.classList.remove('hidden');
    Sound.engine(0, false);
}

function resumeGame() {
    if (state.mode !== 'paused') return;
    state.mode = 'playing';
    pauseOverlay.classList.add('hidden');
    Sound.resume();
}

/* ------------------------------------------------------------
   Input — keyboard + touch buttons + camera modes
------------------------------------------------------------ */
const CAM_NAMES = ['Chase', 'Hood', 'Top'];
function cycleCamera() {
    state.camMode = (state.camMode + 1) % CAM_NAMES.length;
    state.camToast = 2.2;
    const pill = $('pill-cam');
    if (pill) pill.textContent = `📷 ${CAM_NAMES[state.camMode]}`;
    Sound.blip(520, 0.06, 'sine', 0.05);
}

const KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left', KeyQ: 'left',
    ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'gas', KeyW: 'gas', KeyZ: 'gas',
    ArrowDown: 'brake', KeyS: 'brake',
};

window.addEventListener('keydown', (e) => {
    if (KEYMAP[e.code]) {
        input[KEYMAP[e.code]] = true;
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault();
    }
    if (e.code === 'KeyP') state.mode === 'paused' ? resumeGame() : pauseGame();
    if (e.code === 'KeyM') toggleMute();
    if (e.code === 'KeyC') cycleCamera();
    if (e.code === 'Enter' && state.mode === 'menu') startGame();
    if (e.code === 'Enter' && state.mode === 'over') startGame();
    if (e.code === 'KeyR' && (state.mode === 'over' || state.mode === 'playing')) startGame();
});

window.addEventListener('keyup', (e) => {
    if (KEYMAP[e.code]) input[KEYMAP[e.code]] = false;
});

function bindHold(id, key) {
    const el = $(id);
    if (!el) return;
    const on = (e) => { e.preventDefault(); try { el.setPointerCapture(e.pointerId); } catch (err) {} input[key] = true; };
    const off = (e) => { e.preventDefault(); input[key] = false; };
    el.addEventListener('pointerdown', on);
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('lostpointercapture', off);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
}
bindHold('touch-left', 'left');
bindHold('touch-right', 'right');
bindHold('touch-gas', 'gas');
bindHold('touch-brake', 'brake');

// Swipe-to-steer on the canvas itself (mobile): drag left/right.
(function bindSwipe() {
    const el = renderer.domElement;
    let swipeX = null;
    el.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) swipeX = e.touches[0].clientX;
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
        if (swipeX === null || e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - swipeX;
        if (dx > 24) { input.right = true; input.left = false; }
        else if (dx < -24) { input.left = true; input.right = false; }
        else { input.left = false; input.right = false; }
    }, { passive: true });
    const end = () => { swipeX = null; input.left = false; input.right = false; };
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
})();

$('btn-start').addEventListener('click', startGame);
$('btn-restart').addEventListener('click', startGame);
$('btn-resume').addEventListener('click', resumeGame);
$('btn-pause').addEventListener('click', () => (state.mode === 'paused' ? resumeGame() : pauseGame()));
const btnCam = $('btn-cam');
if (btnCam) btnCam.addEventListener('click', cycleCamera);
const touchCam = $('touch-cam');
if (touchCam) touchCam.addEventListener('click', (e) => { e.preventDefault(); cycleCamera(); });
// Leaderboard name edit: renames the pending entry live.
const lbNameInput = $('lb-name');
if (lbNameInput) {
    lbNameInput.addEventListener('input', () => {
        const clean = lbNameInput.value.slice(0, 12) || 'YOU';
        try { localStorage.setItem(NAME_KEY, clean); } catch (error) { /* ignore */ }
        if (state.pendingEntry >= 0) {
            const board = loadBoard();
            if (board[state.pendingEntry]) {
                board[state.pendingEntry].name = clean;
                saveBoard(board);
                renderBoard();
            }
        }
    });
}

function toggleMute() {
    Sound.muted = !Sound.muted;
    $('btn-mute').textContent = Sound.muted ? '🔇' : '🔊';
    $('btn-mute').setAttribute('aria-label', Sound.muted ? 'Unmute sound' : 'Mute sound');
}
$('btn-mute').addEventListener('click', () => { Sound.init(); toggleMute(); });

document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.mode === 'playing') pauseGame();
});

/* ------------------------------------------------------------
   HUD (scoreboard) + daylight cycle + cameras
------------------------------------------------------------ */
const hudBest = $('hud-best') ? $('hud-best').querySelector('b') : null;
let hudTimer = 0;
function updateHud() {
    hudSpeed.textContent = Math.round(state.speed * 4);
    hudScore.textContent = Math.floor(state.score);
    hudCoins.textContent = state.coins;
    if (hudBest) hudBest.textContent = state.best;
}

const C_NIGHT_BG = new THREE.Color(0x05050a);
const C_DAY_BG = new THREE.Color(0x87b5e0);
const C_DUSK_BG = new THREE.Color(0x3a2b55);
const C_NIGHT_FOG = new THREE.Color(0x05050a);
const C_DAY_FOG = new THREE.Color(0x9fc3e2);
const C_NIGHT_SUN = new THREE.Color(0xbfd4ff);
const C_DAY_SUN = new THREE.Color(0xfff2dd);
const C_DUSK_SUN = new THREE.Color(0xff9a4d);
const tmpColor = new THREE.Color();
const tmpColor2 = new THREE.Color();

function dayLabel(t) {
    // t: 0 = midnight … 0.25 = sunrise, 0.5 = noon, 0.75 = sunset
    if (t < 0.18 || t >= 0.82) return '🌙 Night';
    if (t < 0.30) return '🌅 Dawn';
    if (t < 0.45) return '🌤️ Morning';
    if (t < 0.60) return '☀️ Day';
    if (t < 0.72) return '🌇 Evening';
    return '🌆 Dusk';
}

/* Daylight cycle: sun orbits, sky/fog/lamps/beams follow. The cycle
   always advances (even in the menu) so the world feels alive. */
function updateDaylight(dt, driving) {
    state.dayT = (state.dayT + dt / DAY_LENGTH) % 1;
    const t = state.dayT;
    const ang = t * Math.PI * 2 - Math.PI / 2; // t=0.25 → sunrise east
    const elev = Math.sin(ang);                // -1 night … +1 noon
    const dayF = smoothstep(-0.08, 0.35, elev);
    const duskF = clamp(1 - Math.abs(elev) * 3.2, 0, 1) * (elev > -0.25 ? 1 : 0);
    state.dayFactor = dayF;

    const px = player.position.x;
    // Sun path across the sky, glued to the player.
    const sx = Math.cos(ang) * 60;
    const sy = Math.max(elev, -0.35) * 55 + 8;
    sun.position.set(px * 0.5 + sx * 0.4 - 10, Math.max(sy, 6), -20 - Math.abs(sx) * 0.2);
    sun.target.position.set(px * 0.5, 0, -14);
    sun.target.updateMatrixWorld();
    // Night = cool moonlight, day = strong warm sun, dusk = orange kiss.
    tmpColor.lerpColors(C_NIGHT_SUN, C_DAY_SUN, dayF);
    tmpColor2.copy(C_DUSK_SUN);
    tmpColor.lerp(tmpColor2, duskF * 0.55);
    sun.color.copy(tmpColor);
    sun.intensity = lerp(0.55, 2.7, dayF) + duskF * 0.5;
    hemi.intensity = lerp(0.32, 0.95, dayF);
    fill.intensity = lerp(0.22, 0.35, dayF);
    // Sky + fog + exposure follow the same blend.
    tmpColor.lerpColors(C_NIGHT_BG, C_DAY_BG, dayF);
    tmpColor2.copy(C_DUSK_BG);
    tmpColor.lerp(tmpColor2, duskF * 0.45);
    scene.background.copy(tmpColor);
    tmpColor.lerpColors(C_NIGHT_FOG, C_DAY_FOG, dayF);
    tmpColor2.copy(C_DUSK_BG);
    tmpColor.lerp(tmpColor2, duskF * 0.35);
    scene.fog.color.copy(tmpColor);
    scene.fog.density = lerp(0.011, 0.0068, dayF);
    renderer.toneMappingExposure = lerp(1.15, 1.0, dayF);
    // Stars out by day, clouds in.
    if (starMat) starMat.opacity = 1 - dayF;
    clouds.forEach((c) => { c.sprite.material.opacity = dayF * 0.55; });
    // Celestial billboards.
    sunSprite.position.set(px * 0.5 + Math.cos(ang) * 320, Math.max(elev * 260, -60) + 40, -480);
    sunSprite.material.opacity = clamp(elev * 3 + 0.4, 0, 1) * 0.95;
    const mang = ang + Math.PI;
    moonSprite.position.set(px * 0.5 + Math.cos(mang) * 300, Math.max(Math.sin(mang) * 240, -40) + 60, -460);
    moonSprite.material.opacity = clamp(-elev * 3 + 0.4, 0, 1) * 0.9;
    // Lamps + headlight beams only matter after dark.
    const nightF = 1 - dayF;
    lampPoolMat.opacity = 0.012 + nightF * 0.11;
    beamMats[0].opacity = 0.015 + nightF * 0.11;
    beamMats[1].opacity = 0.015 + nightF * 0.10;
    headSpot.intensity = 12 + nightF * 220;
    playerVisual.userData.headGlows?.forEach((s) => { s.material.opacity = 0.25 + nightF * 0.7; });
    if (playerVisual.userData.headMat) playerVisual.userData.headMat.emissiveIntensity = 0.7 + nightF * 2.8;
    traffic.forEach((tr) => {
        if (tr.mesh.userData.lightPool) tr.mesh.userData.lightPool.material.opacity = 0.01 + nightF * 0.07;
        tr.mesh.userData.headGlows?.forEach((s) => { s.material.opacity = 0.2 + nightF * 0.7; });
    });
    // Roaming lamp lights: snap to the two nearest lamps ahead at night.
    let placed = 0;
    if (nightF > 0.15) {
        for (const l of lamps) {
            if (l.position.z > -60 && l.position.z < 8 && placed < lampLights.length) {
                lampLights[placed].position.set(l.position.x * 0.82, 5.4, l.position.z);
                lampLights[placed].intensity = nightF * 28;
                placed++;
            }
        }
    }
    for (let i = placed; i < lampLights.length; i++) lampLights[i].intensity = 0;
    // Brake lights flare when braking (and slightly with speed).
    const braking = !!input.brake;
    const tailBoost = braking ? 2.2 : 0;
    if (playerVisual.userData.tailMat) playerVisual.userData.tailMat.emissiveIntensity = 1.6 + nightF * 1.2 + tailBoost;
    playerVisual.userData.tailGlows?.forEach((s) => {
        s.material.opacity = clamp(0.45 + nightF * 0.4 + (braking ? 0.35 : 0), 0, 1);
        s.scale.setScalar(braking ? 1.35 : 1.0);
    });
    brakeLight.intensity = braking ? 14 : nightF * 3;
    // HUD day pill.
    const pill = $('pill-day');
    if (pill && (driving || hudTimer <= 0)) pill.textContent = dayLabel(t);
}

/* Keep the shadow frustum glued to the action (legacy entry). */
function updateLight(px) {
    sun.target.position.set(px * 0.5, 0, -14);
    sun.target.updateMatrixWorld();
}

/* Camera modes: 0 Chase · 1 Hood · 2 Top — press C or tap 📷. */
const camDesired = new THREE.Vector3(0, 5.2, 8.5);
const camLook = new THREE.Vector3(0, 1.2, -14);
function updateCamera(dt, px, ratio) {
    let fx = 0, fy = 5.2, fz = 8.5, lx = px * 0.7, ly = 1.2, lz = -14, fovT = 62 + ratio * 14;
    if (state.camMode === 1) {          // hood / driver
        fx = px; fy = 1.5; fz = -0.4;
        lx = px + state.steer * 3.0; ly = 1.15; lz = -32;
        fovT = 70 + ratio * 10;
    } else if (state.camMode === 2) {   // top-down chase
        fx = px * 0.6; fy = 15; fz = 7;
        lx = px * 0.6; ly = 0; lz = -12;
        fovT = 58 + ratio * 8;
    }
    const k = 1 - Math.exp(-dt * (state.camMode === 1 ? 14 : 5));
    camDesired.set(fx, fy, fz);
    camLook.set(lx, ly, lz);
    const shX = state.camMode === 2 ? 0 : (Math.random() - 0.5) * state.shake * 0.5;
    const shY = state.camMode === 2 ? 0 : (Math.random() - 0.5) * state.shake * 0.35;
    camera.position.x = damp(camera.position.x, camDesired.x + shX, state.camMode === 1 ? 14 : 5, dt);
    camera.position.y = damp(camera.position.y, camDesired.y + shY, state.camMode === 1 ? 14 : 5, dt);
    camera.position.z = damp(camera.position.z, camDesired.z, state.camMode === 1 ? 14 : 5, dt);
    camera.lookAt(camLook);
    if (Math.abs(camera.fov - fovT) > 0.05) {
        camera.fov = damp(camera.fov, fovT, 3, dt);
        camera.updateProjectionMatrix();
    }
    // Camera toast.
    const toast = $('cam-toast');
    if (toast) {
        if (state.camToast > 0) {
            state.camToast -= dt;
            toast.textContent = `📷 ${CAM_NAMES[state.camMode]}`;
            toast.classList.add('show');
        } else {
            toast.classList.remove('show');
        }
    }
}

/* ------------------------------------------------------------
   Per-frame update — fixed car feel, solvable traffic
------------------------------------------------------------ */
function streamWorld(speed, dt) {
    roadTexture.offset.y += (speed * dt) / 10.35;
    lamps.forEach((l) => {
        l.position.z += speed * dt;
        if (l.position.z > 20) l.position.z -= 22 * 24;
    });
    trees.forEach((t) => {
        t.position.z += speed * dt;
        if (t.position.z > 20) t.position.z -= 30 * 20;
    });
    clouds.forEach((c) => {
        c.sprite.position.x += c.speed * dt;
        if (c.sprite.position.x > 220) c.sprite.position.x = -220;
    });
}

function update(dt) {
    updateDaylight(dt, state.mode === 'playing');

    if (state.mode === 'menu') {
        // Attract mode: slow cruise behind the menu.
        const cruise = 16;
        streamWorld(cruise, dt);
        player.position.x = damp(player.position.x, 0, 2, dt);
        player.rotation.y = damp(player.rotation.y, 0, 4, dt);
        spinWheels(cruise, dt);
        updateCamera(dt, player.position.x, cruise / 72);
        Sound.engine(0.2, false);
        return;
    }

    if (state.mode !== 'playing') return;

    state.elapsed += dt;

    if (!state.crashed) {
        state.maxSpeed = Math.min(72, 38 + state.elapsed * 0.45);
        // Auto-accelerate toward max; gas pushes harder, brake drags down.
        let target = state.maxSpeed;
        if (input.brake) target = 12;
        else if (input.gas) target = state.maxSpeed + 6;
        const rate = input.brake ? 34 : input.gas ? 16 : 5;
        state.speed += Math.sign(target - state.speed) * Math.min(Math.abs(target - state.speed), rate * dt);

        // Steering: smoothed input → velocity (no more teleport twitch).
        const rawSteer = (input.left ? -1 : 0) + (input.right ? 1 : 0);
        state.steer = damp(state.steer, rawSteer, 9, dt);
        if (rawSteer === 0) state.steer = damp(state.steer, 0, 12, dt);
        const targetVx = state.steer * (9 + state.speed * 0.26);
        state.vx = damp(state.vx, targetVx, 8, dt);
        player.position.x += state.vx * dt;
        // Rail scrape: sparks-free slow-down + rumble, never pass-through.
        if (Math.abs(player.position.x) > RAIL_SCRAPE_X) {
            state.speed = Math.max(13, state.speed - 20 * dt);
            state.shake = Math.max(state.shake, 0.5);
        }
        player.position.x = clamp(player.position.x, -LIMIT_X, LIMIT_X);
        player.rotation.y = damp(player.rotation.y, -state.steer * 0.2, 8, dt);
        player.rotation.z = damp(player.rotation.z, state.steer * 0.055, 8, dt);

        // Off-road drag + rumble.
        if (Math.abs(player.position.x) > ROAD_HALF) {
            state.speed = Math.max(14, state.speed - 26 * dt);
            state.shake = Math.max(state.shake, 0.35);
        }

        // Suspension: subtle speed bob + steering lean on the visual only,
        // so the rig (physics) never leaves the ground plane.
        state.bob += dt * (4 + state.speed * 0.25);
        const bobAmp = 0.008 + (state.speed / 72) * 0.02 + (Math.abs(player.position.x) > ROAD_HALF ? 0.02 : 0);
        playerVisual.position.y = Math.sin(state.bob) * bobAmp;
        playerVisual.rotation.z = damp(playerVisual.rotation.z || 0, state.steer * 0.03, 6, dt);

        state.score += state.speed * dt;
    } else {
        // Crash: slide to a stop with a spin, then show the game-over card.
        state.speed = Math.max(0, state.speed - 60 * dt);
        state.crashTimer += dt;
        player.rotation.y = damp(player.rotation.y, 0.7, 3, dt);
        if (state.crashTimer > 1.1) endGame();
    }

    const speed = state.speed;
    const ratio = speed / 72;

    // Stream the world past.
    streamWorld(speed, dt);

    // Traffic density ramps with survival time.
    if (!state.crashed) {
        const want = Math.min(4 + Math.floor(state.elapsed / 12), traffic.length);
        const activeCount = traffic.filter((t) => t.active).length;
        if (activeCount < want && Math.random() < dt * 1.6) spawnTraffic();
    }

    const px = player.position.x;
    for (const t of traffic) {
        if (!t.active) continue;
        const prevZ = t.mesh.position.z;
        t.mesh.position.z += (speed - t.speed) * dt;
        // Gentle lane wobble so traffic feels driven, not railed.
        t.mesh.position.x += Math.sin(state.elapsed * 0.6 + t.wobble) * dt * 0.35;
        t.mesh.position.x = clamp(t.mesh.position.x, LANES[t.lane] - 1.1, LANES[t.lane] + 1.1);
        const z = t.mesh.position.z;

        if (z > KILL_Z || z < SPAWN_Z - 120) {
            t.active = false;
            t.mesh.visible = false;
            continue;
        }

        // Near-miss bonus when it slips past alongside.
        if (!t.counted && prevZ < 1 && z >= 1) {
            t.counted = true;
            const dx = Math.abs(t.mesh.position.x - px);
            if (!state.crashed && dx > 1.7 && dx < 3.2) {
                state.score += 10;
                Sound.nearMiss();
            }
        }

        // Brake flare when the player is right behind (reads as AI).
        const behind = z < -2 && z > -14 && Math.abs(t.mesh.position.x - px) < 1.8;
        if (t.mesh.userData.tailMat) t.mesh.userData.tailMat.emissiveIntensity = behind ? 3.6 : 1.8 + (1 - state.dayFactor) * 0.8;

        // Collision (AABB, forgiving but tunnel-proof window).
        if (!state.crashed && Math.abs(z) < 3.6 && Math.abs(t.mesh.position.x - px) < 1.7) {
            state.crashed = true;
            state.crashTimer = 0;
            state.shake = 1.4;
            state.flash = 1;
            Sound.crash();
            Sound.engine(0, false);
        }

        spinWheelsOn(t.mesh, t.speed, dt);
    }

    // Coins.
    if (!state.crashed && Math.random() < dt * 2.2) spawnCoin();
    for (const c of coins) {
        if (!c.active) continue;
        c.mesh.position.z += speed * dt;
        c.mesh.rotation.y += dt * 3.2;
        const dz = c.mesh.position.z;
        if (dz > KILL_Z) {
            c.active = false;
            c.mesh.visible = false;
            continue;
        }
        if (!state.crashed && Math.abs(dz) < 1.8 && Math.abs(c.mesh.position.x - px) < 1.5) {
            c.active = false;
            c.mesh.visible = false;
            state.coins++;
            state.score += 25;
            Sound.coin();
        }
    }

    spinWheels(speed, dt);

    // Shake + crash flash decay.
    state.shake = Math.max(0, state.shake - dt * 2.2);
    state.flash = Math.max(0, state.flash - dt * 1.4);
    flash.style.opacity = state.flash.toFixed(2);

    updateCamera(dt, px, ratio);

    Sound.engine(ratio, !state.crashed);

    hudTimer -= dt;
    if (hudTimer <= 0) {
        hudTimer = 0.1;
        updateHud();
    }
}

function spinWheels(speed, dt) {
    spinWheelsOn(playerVisual, speed, dt);
}

function spinWheelsOn(car, speed, dt) {
    const wheels = car.userData.wheels;
    if (!wheels) return;
    // Forward is -z, so the tops of the tyres move -z: negative
    // rotation about +x. (Positive here visibly rolled backwards.)
    // Angular velocity is capped: past ~30 rad/s a 60 fps renderer
    // just strobes, which reads as flicker/flipping, not speed.
    const spin = Math.min((speed * dt) / 0.38, 30 * dt);
    for (const w of wheels) w.rotation.x -= spin;
}

/* ------------------------------------------------------------
   Resize + main loop (mobile-aware)
------------------------------------------------------------ */
function resize() {
    const w = holder.clientWidth || 16;
    const h = holder.clientHeight || 9;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, IS_TOUCH_DEVICE ? 1.75 : 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 120));
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
resize();

// Resting camera for the menu attract mode.
camera.position.set(0, 5.2, 8.5);
camera.lookAt(0, 1.2, -14);
renderBoard();

let lastTime = performance.now();
let booted = false;

function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden) {
        lastTime = now;
        return;
    }
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    update(dt);
    renderer.render(scene, camera);
    if (!booted) {
        booted = true;
        window.__neonRushBooted = true;
    }
}
requestAnimationFrame(frame);
