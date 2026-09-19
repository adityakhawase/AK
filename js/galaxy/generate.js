/* ============================================================
   galaxy/generate.js
   Procedural construction of every particle layer.

   Nothing here is hand-placed or loaded from a file: the whole
   galaxy is built from a seeded RNG plus a few closed-form
   distributions, so ~70k stars cost a few hundred KB of typed
   arrays and no network requests at all.
   ============================================================ */

import { TAU, createRandom, gaussian } from './math.js';

/** Radius of the visible disc, in world units. */
export const GALAXY_RADIUS = 6.0;

/* Colour ramp: hot young blue-white stars dominate the outer arms,
   cooler yellow/amber populations fill the core bulge. This mirrors
   real stellar populations (blue O/B stars in spiral arms, redder
   K/M-type stars concentrated toward an evolved galactic bulge). */
const CORE_COLOR = [1.00, 0.87, 0.68];
const MID_COLOR  = [1.00, 0.96, 0.91];
const EDGE_COLOR = [0.72, 0.82, 1.00];

/* Rare colour outliers — still within a believable stellar-temperature
   range (blue supergiant, red giant, faint solar-type yellow). No hue
   here strays into anything a real telescope wouldn't show. */
const ACCENT_COLORS = [
    [0.62, 0.80, 1.00], // O/B-type blue-white supergiant
    [1.00, 0.62, 0.48], // M-type red giant
    [1.00, 0.90, 0.68], // G-type sun-like yellow
];

/* Nebulae stay almost monochrome — the faintest whisper of blue or
   violet, the way ionised hydrogen and reflection nebulae actually
   read at this brightness, never a saturated cyberpunk hue. */
const NEBULA_COLORS = [
    [0.42, 0.52, 0.62], // pale steel blue
    [0.46, 0.44, 0.58], // muted violet-grey
    [0.50, 0.46, 0.42], // warm dust-lit grey
];

/* Dust is rendered with multiplicative blending (see renderer.js),
   so this is what the sky gets multiplied BY — near-white leaves a
   region untouched, this dark warm brown is what a true obscuring
   lane darkens it toward. */
const DUST_COLOR = [0.30, 0.22, 0.17];

function mix(a, b, t) {
    return [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ];
}

/** Allocate the four parallel attribute arrays a layer needs. */
function allocate(count) {
    return {
        count,
        positions: new Float32Array(count * 3),
        colors: new Float32Array(count * 3),
        sizes: new Float32Array(count),
        seeds: new Float32Array(count),
    };
}

function write(layer, i, x, y, z, color, size, seed) {
    const i3 = i * 3;
    layer.positions[i3] = x;
    layer.positions[i3 + 1] = y;
    layer.positions[i3 + 2] = z;
    layer.colors[i3] = color[0];
    layer.colors[i3 + 1] = color[1];
    layer.colors[i3 + 2] = color[2];
    layer.sizes[i] = size;
    layer.seeds[i] = seed;
}

/* ------------------------------------------------------------
   Spiral arms + central bulge
------------------------------------------------------------ */
export function generateStars(count, options = {}) {
    const {
        arms = 4,
        radius = GALAXY_RADIUS,
        spin = 1.45,         // radians of sweep per world unit of radius
        bulgeFraction = 0.07, // share of stars belonging to the core
        seed = 20260916,
    } = options;

    const random = createRandom(seed);
    const layer = allocate(count);
    const bulgeCount = Math.floor(count * bulgeFraction);

    for (let i = 0; i < count; i++) {
        let x, y, z, t;

        if (i < bulgeCount) {
            /* --- Core bulge ---------------------------------
               A flattened 3D gaussian ball. Cubing the radius
               concentrates stars hard toward the centre, which
               is what produces the bright galactic nucleus
               without needing a separate glow sprite.
            ------------------------------------------------ */
            const r = Math.pow(random(), 3) * radius * 0.15;
            const theta = random() * TAU;
            const phi = Math.acos(2 * random() - 1);
            x = r * Math.sin(phi) * Math.cos(theta);
            y = r * Math.cos(phi) * 0.55; // squashed into a lens
            z = r * Math.sin(phi) * Math.sin(theta);
            t = 0;
        } else {
            /* --- Spiral arms --------------------------------
               Logarithmic-ish spiral: each star picks an arm,
               then its angle advances linearly with radius.
               theta = armOffset + spin * r
               Scatter is raised to a power so most stars hug
               the arm ridge and a few stragglers fill the gaps
               between arms — that contrast is what makes the
               spiral structure legible.
            ------------------------------------------------ */
            /* A gentler exponent spreads stars further out, where the
               arms are wide enough apart to actually be resolved. A
               steep one piles everything into an unreadable core mush. */
            const radial = Math.pow(random(), 1.15);
            const r = radial * radius;
            const armIndex = i % arms;
            const armOffset = (armIndex / arms) * TAU;
            const theta = armOffset + spin * r;

            // Scatter widens with radius, mimicking arm fraying.
            const spread = 0.035 + 0.115 * radial;
            const offX = Math.pow(random(), 2.4) * spread * radius * (random() < 0.5 ? -1 : 1);
            const offZ = Math.pow(random(), 2.4) * spread * radius * (random() < 0.5 ? -1 : 1);

            // Disc thickness flares down as radius grows.
            const thickness = 0.30 * Math.exp(-radial * 2.0) + 0.02;

            x = Math.cos(theta) * r + offX;
            z = Math.sin(theta) * r + offZ;
            y = gaussian(random) * thickness;
            t = radial;
        }

        /* Colour: core warm -> mid white -> outer blue. */
        let color = t < 0.45
            ? mix(CORE_COLOR, MID_COLOR, t / 0.45)
            : mix(MID_COLOR, EDGE_COLOR, (t - 0.45) / 0.55);

        if (random() < 0.028) {
            color = mix(color, ACCENT_COLORS[(random() * ACCENT_COLORS.length) | 0], 0.75);
        }

        /* Size is a world-space diameter. A steep power curve gives
           thousands of pinpricks and a handful of bright standouts,
           which is what a real star field looks like. */
        const size = 0.028 + Math.pow(random(), 7) * 0.11;

        write(layer, i, x, y, z, color, size, random());
    }

    return layer;
}

/* ------------------------------------------------------------
   Dust lanes — dim, warm, hugging the disc plane
------------------------------------------------------------ */
/* ------------------------------------------------------------
   Dust lanes — dark occluding lanes threaded along the arms

   Unlike every other layer, dust is drawn with MULTIPLICATIVE
   blending (see renderer.js): the colour written here is what
   the sky gets multiplied toward, not a light added on top. A
   near-white tint leaves a star untouched; DUST_COLOR darkens
   it. That is what makes these read as real obscuring lanes —
   stars behind them dim and desaturate instead of the dust
   just glowing on top of them.
------------------------------------------------------------ */
export function generateDust(count, options = {}) {
    const { arms = 4, radius = GALAXY_RADIUS, spin = 1.45, seed = 88121 } = options;
    const random = createRandom(seed);
    const layer = allocate(count);

    for (let i = 0; i < count; i++) {
        const radial = 0.12 + Math.pow(random(), 1.2) * 0.88;
        const r = radial * radius;

        // Threaded along the inner edge of the stellar arm, as real
        // dust lanes trail the density wave that triggers star formation.
        const armOffset = ((i % arms) / arms) * TAU + 0.16;
        const theta = armOffset + spin * r;

        const spread = 0.055 + 0.10 * radial;
        const x = Math.cos(theta) * r + gaussian(random) * spread * radius * 0.5;
        const z = Math.sin(theta) * r + gaussian(random) * spread * radius * 0.5;
        const y = gaussian(random) * (0.075 * Math.exp(-radial * 1.6) + 0.008);

        // Lanes are densest (darkest) near the core, thinning outward —
        // but kept well short of full black, since real dust reddens
        // and dims starlight rather than erasing it.
        const density = 0.30 + 0.30 * (1 - radial);
        const color = [DUST_COLOR[0] * density + (1 - density),
                        DUST_COLOR[1] * density + (1 - density),
                        DUST_COLOR[2] * density + (1 - density)];

        // Sprite size scales with radius: a lane a few percent of the
        // disc's width stays a thin thread near the core and a wider
        // ribbon toward the edge, instead of one size blobbing out a
        // structure that is, near the centre, only a fraction as wide.
        const size = (0.075 + random() * 0.16) * (0.4 + radial * 0.9);

        write(layer, i, x, y, z, color, size, random());
    }

    return layer;
}

/* ------------------------------------------------------------
   Nebulae — a few large, very faint coloured clouds
------------------------------------------------------------ */
export function generateNebula(count, options = {}) {
    const { arms = 4, radius = GALAXY_RADIUS, spin = 1.45, clusters = 9, seed = 4242 } = options;
    const random = createRandom(seed);
    const layer = allocate(count);

    // Seed each cloud on an arm, then scatter puffs around it.
    const centres = [];
    for (let c = 0; c < clusters; c++) {
        const radial = 0.25 + random() * 0.7;
        const r = radial * radius;
        const theta = ((c % arms) / arms) * TAU + spin * r + (random() - 0.5) * 0.5;
        centres.push({
            x: Math.cos(theta) * r,
            y: gaussian(random) * 0.12,
            z: Math.sin(theta) * r,
            color: NEBULA_COLORS[(random() * NEBULA_COLORS.length) | 0],
            scale: 0.5 + random() * 1.1,
        });
    }

    for (let i = 0; i < count; i++) {
        const c = centres[i % clusters];
        const x = c.x + gaussian(random) * c.scale;
        const z = c.z + gaussian(random) * c.scale;
        const y = c.y + gaussian(random) * c.scale * 0.18;

        // Vary each puff slightly so the cloud is not one flat colour,
        // but keep it inside a narrow, believable brightness band.
        const tint = 0.85 + random() * 0.3;
        const color = [c.color[0] * tint, c.color[1] * tint, c.color[2] * tint];
        const size = 0.75 + random() * 1.4;

        write(layer, i, x, y, z, color, size, random());
    }

    return layer;
}

/* ------------------------------------------------------------
   Deep field — distant stars and far-off galaxies
------------------------------------------------------------ */
export function generateDeepField(count, options = {}) {
    const { innerRadius = 26, outerRadius = 95, distantGalaxies = 7, seed = 90210 } = options;
    const random = createRandom(seed);
    const layer = allocate(count);

    // Reserve part of the budget for small distant galaxy discs.
    const galaxyPoints = Math.min(Math.floor(count * 0.1), distantGalaxies * 160);
    const perGalaxy = Math.max(1, Math.floor(galaxyPoints / distantGalaxies));
    const starCount = count - perGalaxy * distantGalaxies;

    /* Background stars on a thick spherical shell so they read as
       genuinely far away from every camera angle. */
    for (let i = 0; i < starCount; i++) {
        const r = innerRadius + random() * (outerRadius - innerRadius);
        const theta = random() * TAU;
        const phi = Math.acos(2 * random() - 1);

        const warm = random();
        const color = warm < 0.08
            ? [1.0, 0.82, 0.68]
            : warm > 0.92
                ? [0.76, 0.85, 1.0]
                : [0.92, 0.94, 0.99];

        write(
            layer, i,
            r * Math.sin(phi) * Math.cos(theta),
            r * Math.cos(phi),
            r * Math.sin(phi) * Math.sin(theta),
            color,
            0.045 + Math.pow(random(), 5) * 0.20,
            random()
        );
    }

    /* Distant galaxies: tiny inclined discs, randomly oriented. */
    let idx = starCount;
    for (let g = 0; g < distantGalaxies; g++) {
        const r = innerRadius * 1.4 + random() * (outerRadius - innerRadius);
        const theta = random() * TAU;
        const phi = Math.acos(2 * random() - 1);
        const cx = r * Math.sin(phi) * Math.cos(theta);
        const cy = r * Math.cos(phi);
        const cz = r * Math.sin(phi) * Math.sin(theta);

        const discRadius = 1.4 + random() * 2.6;
        const tilt = random() * Math.PI;
        const cosT = Math.cos(tilt);
        const sinT = Math.sin(tilt);
        const hue = random() < 0.5 ? [0.85, 0.88, 1.0] : [1.0, 0.88, 0.78];

        for (let k = 0; k < perGalaxy; k++, idx++) {
            const rr = Math.pow(random(), 2) * discRadius;
            const aa = random() * TAU;
            const lx = Math.cos(aa) * rr;
            const lz = Math.sin(aa) * rr;
            const ly = gaussian(random) * discRadius * 0.08;

            write(
                layer, idx,
                cx + lx,
                cy + ly * cosT - lz * sinT,
                cz + ly * sinT + lz * cosT,
                hue,
                0.05 + random() * 0.10,
                random()
            );
        }
    }

    return layer;
}

/* ------------------------------------------------------------
   Core glow — the galactic nucleus

   A handful of very large, very soft warm sprites stacked at
   the centre. Additive blending turns them into one smooth
   bloom, which is far cheaper than a real post-process bloom
   pass and reads just as well at this scale.
------------------------------------------------------------ */
export function generateCoreGlow(count = 130, options = {}) {
    const { seed = 5150 } = options;
    const random = createRandom(seed);
    const layer = allocate(count);

    for (let i = 0; i < count; i++) {
        // Concentrate hard at the centre; a few outliers soften the edge.
        const spread = Math.pow(random(), 2.2) * 0.9;
        const theta = random() * TAU;
        const x = Math.cos(theta) * spread;
        const z = Math.sin(theta) * spread;
        const y = gaussian(random) * 0.10;

        // Warm white at the very centre, fading to amber outward.
        const t = spread / 0.9;
        const color = mix([1.0, 0.94, 0.82], [1.0, 0.68, 0.38], t);
        const size = 0.9 + (1 - t) * 2.0 + random() * 0.5;

        write(layer, i, x, y, z, color, size, random());
    }

    return layer;
}
