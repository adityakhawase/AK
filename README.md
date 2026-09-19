# Aditya Khawase - Portfolio Website

A professional portfolio website showcasing gaming content creation, Minecraft server development, and programming projects.

## About

This is the personal portfolio of Aditya Khawase, a gaming content creator and AI & Machine Learning engineering student from Chh. Sambhajinagar, Maharashtra, India.

## Features

- Responsive design that works on all devices
- Modern UI with smooth animations
- Organized sections: About, Skills, Projects, Contact
- Professional maintenance pages
- Clean and maintainable code structure

## Technologies Used

- HTML5
- CSS3
- Modern CSS features (Grid, Flexbox, Animations)
- Responsive design principles

## Project Structure

```
├── index.html              # Main homepage
├── css/
│   ├── styles.css         # Main stylesheet
│   └── maintenance.css    # Maintenance page styles
├── mcserverM.html         # Minecraft server page (under maintenance)
├── rblxM.html             # Roblox page (under maintenance)
├── ytM.html               # Programming projects page (under maintenance)
├── getintouc.html         # Contact page (redirects to main contact)
└── assets/                # Images and media files
    ├── smp.png
    ├── rblx.png
    ├── plg.png
    └── kaybe.jpg
```

## Contact

- **Email:** tadi7206@gmail.com
- **YouTube:** [@knockbackkk](https://youtube.com/@knockbackkk)
- **Instagram:** @aditya.pvp / @knockbackkk.exe

## License

© 2026 Aditya Khawase. All rights reserved.

## 2026 Redesign — Audit Fixes & Motion Pass

This version resolves every finding from the Floto usability audit and adds a
full animation layer.

### Audit fixes

| # | Finding | Fix |
|---|---------|-----|
| 1 | ~600px of dead vertical whitespace between sections (Major) | Removed `min-height: 100vh` + vertical centering from `section`. Sections now use one rhythm token, `--section-y: clamp(4.5rem, 8vw, 7rem)`, plus a hairline `.section-rule` divider and a marquee ribbon so the scroll never passes through empty space. |
| 2 | Uneven skill-card heights | Grids use `grid-auto-rows: 1fr` + `align-items: stretch`, cards are `height: 100%` flex columns, and the list/description gets `flex: 1` so every bottom edge is flush. |
| 3 | Centred multi-line About paragraphs | `.about-copy p` is left-aligned with a `68ch` measure. |
| 4 | Noisy high-contrast hero image strips | The slider now runs `blur(5px) saturate(55%) brightness(0.42)` under a radial scrim + vignette, and the strip blurs further as you scroll. |
| 5 | Mixed button radii | A single `--radius-pill` token drives `.btn`, `.btn-ghost`, `.btn-home` and every inner-page button. |

### Added animation & interaction

- Branded preloader with sweeping progress bar
- Gradient scroll-progress bar and a nav that shrinks on scroll
- Hero: letter-by-letter headline reveal, typing effect for roles, interactive
  particle constellation on canvas, parallax fade on scroll
- Drifting aurora background with a masked grid overlay
- Scroll-reveal with automatic per-grid stagger (IntersectionObserver)
- 3D tilt + cursor-following spotlight on skill and project cards
- Magnetic buttons, animated gradient headings, image zoom on project hover
- Count-up statistics, infinite skills marquee, back-to-top button
- Scroll-spy nav highlighting, working mobile hamburger menu
- Full `prefers-reduced-motion` support; particles pause when off-screen

No frameworks, no build step, no external JS. Still plain HTML/CSS/JS, so it
drops straight onto GitHub Pages.

## 3D Galaxy Background

A real-time, procedurally generated spiral galaxy renders behind the whole
site. It is written directly against WebGL2 (with a WebGL1 fallback) — no
Three.js, no bundler, no npm. The project has no build system, so a
dependency-free renderer drops onto GitHub Pages unchanged and ships ~30 KB
of JavaScript instead of ~600 KB of library.

### Modules — `js/galaxy/`

| File | Responsibility |
|------|----------------|
| `math.js` | mat4 perspective (with lens shift), look-at, seeded RNG, damping |
| `shaders.js` | GLSL: differential rotation, soft procedural sprites, fog, shockwave |
| `generate.js` | Procedural stars, core bulge, dust lanes, nebulae, deep field, nucleus |
| `renderer.js` | Program/buffer setup, one draw call per layer, additive blending |
| `controls.js` | Damped orbit camera: drag, pinch, parallax, scroll dolly |
| `fallback.js` | Canvas-2D starfield for when WebGL is unavailable |
| `index.js` | Quality tiers, lifecycle, adaptive degradation, page integration |

### How the galaxy is built

Everything comes from a seeded RNG (`mulberry32`) plus closed-form
distributions — nothing is hand-placed or loaded over the network.

- **Spiral arms** — each star picks an arm, then `theta = armOffset + spin * r`.
  Scatter is raised to a power so most stars hug the arm ridge while a few
  stragglers fill the gaps; that contrast is what makes the spiral legible.
- **Core bulge** — a flattened 3D gaussian ball with a cubed radius, which
  concentrates stars hard enough to form a real nucleus.
- **Differential rotation** — angular speed `w(r) ~ 1 / (r + k)`, so material
  near the core orbits faster than the outer arms, exactly as in a real galaxy.
  Computed in the vertex shader from a single `uTime` uniform.
- **Point size** — `aSize` is a true world-space diameter, scaled by
  `viewportHeight / (2 * tan(fov/2))`, so a star looks the same on a phone
  and a 4K display.
- **Composition** — a lens shift in the projection matrix (`out[8]`, `out[9]`)
  slides the galaxy off-centre for framing while the camera still orbits its
  actual core.

### Interaction

Drag to orbit, pinch to zoom on touch, mouse movement drives camera parallax,
page scroll dollies the camera back and dims the field, and a click sends a
decaying shockwave through nearby particles. Dragging never starts on top of
a link, button or form field, and the canvas is `pointer-events: none` so it
can never intercept a click.

### Performance

- Zero per-frame CPU work — all motion is GPU-side; five draw calls total.
- Quality tiers (`high` / `medium` / `low`) picked from pointer type, viewport,
  core count and device memory.
- Adaptive ladder: samples real frame times and steps down — first render
  scale, then the large soft-sprite layers, which dominate fill rate.
- Device pixel ratio capped per tier; the loop stops entirely when the tab is
  hidden.
- Measured fill rate was tuned from 13.3x screen overdraw down to 6.6x.

### Graceful degradation

1. **WebGL works** → full 3D galaxy.
2. **No WebGL, or the context is lost** → animated Canvas-2D starfield.
3. **The module never loads** → the original image-strip hero and 2D
   constellation revive automatically; nothing is lost.
4. **`prefers-reduced-motion`** → auto-rotation, parallax and drift are
   disabled; the scene renders as a still frame.

The preloader shows "Initializing universe..." and waits for the galaxy's
first frame before revealing the page, with a 5s safety timeout so the
loader can never trap the site.

## Realism pass — restrained palette, true dust occlusion, bloom

A follow-up pass on the galaxy, aimed specifically at reading as an actual
astronomical image rather than a particle-effect demo.

### 1. Files changed

- `js/galaxy/generate.js` — new colour constants (restrained blue-white/amber
  stellar palette, no neon), dust rewritten to emit an occlusion tint instead
  of a glow colour, dust sprite size now scales with radius, nebula and deep
  field brightness/colour retuned.
- `js/galaxy/shaders.js` — added `DUST_FRAGMENT_SHADER` (multiplicative
  occlusion) and four fullscreen shaders for the bloom pipeline
  (`FULLSCREEN_VERTEX_SHADER`, `BRIGHTPASS_FRAGMENT_SHADER`,
  `BLUR_FRAGMENT_SHADER`, `COMPOSITE_FRAGMENT_SHADER`).
- `js/galaxy/bloom.js` — new module, a self-contained three-pass bloom
  (bright-pass → separable blur → composite).
- `js/galaxy/renderer.js` — rewritten to run two shader programs (additive
  for stars/nebula/core/deep-field, multiplicative for dust) and to
  optionally redirect drawing through `BloomPipeline`.
- `js/galaxy/index.js` — layer draw order changed (dust now drawn *last*, so
  it can darken what's already been drawn), bloom wired in per quality tier,
  adaptive ladder now drops bloom before touching any particle layer.

### 2. Dependencies added

None. Still zero external libraries — the bright-pass/blur/composite bloom
and the multiply-blend dust are both plain WebGL, consistent with the rest
of the galaxy module.

### 3. How it's generated (what changed)

- **Dust is no longer a glow.** It's drawn last with
  `gl.blendFunc(gl.ZERO, gl.SRC_COLOR)` — a genuine multiplicative pass, so
  it darkens the stars already accumulated behind it instead of adding
  brightness on top of them. That's what makes it read as an occluding lane
  rather than warm haze.
- **Palette is restrained.** Every colour constant in `generate.js` was
  rewritten to stay inside real stellar-temperature and nebula-emission
  ranges — blue-white O/B stars, warm G/K/M outliers, near-white for the
  vast majority, pale steel-blue/violet-grey for nebulae. No green, no
  magenta, no saturated purple.
- **Bloom** is a real three-pass post-process: the whole particle scene
  renders into an offscreen framebuffer, a bright-pass shader isolates
  highlights above a threshold, a 5-tap separable Gaussian blurs them at
  ~38% resolution (most of the cost saving is here), and a composite shader
  adds the blurred highlights back over the full-resolution scene.

### 4. Performance optimizations

- Bloom's blur stages run at a fraction of canvas resolution
  (`blurScale: 0.38`), not full-res — this is most of what keeps a 3-pass
  post-process affordable.
- Bloom is gated by quality tier (on for `high`/`medium`, off for `low`) and
  wrapped in a `try/catch`: if a device can't allocate the framebuffers, the
  galaxy keeps rendering without it instead of failing.
- The adaptive ladder now drops bloom *first* — before lowering render
  scale, before disabling any particle layer — since it's the single most
  expensive thing to turn off.
- Dust's multiply pass costs the same one draw call as any other layer; no
  additional geometry or overdraw beyond what was already budgeted.

### 5. Tuning knobs

| Want to change | Where |
|---|---|
| Star count | `QUALITY_TIERS` in `index.js` (`stars` per tier) |
| Galaxy size | `GALAXY_RADIUS` in `generate.js` |
| Rotation speed | `spin` passed to each `renderer.addLayer(...)` call in `index.js` (higher = faster differential rotation) |
| Bloom brightness threshold | `threshold` in `renderer.enableBloom({...})`, `index.js` — lower catches more of the scene, higher isolates only the brightest core/stars |
| Bloom intensity | `strength` in that same call |
| Dust darkness | `opacity` on the `dust` layer in `index.js` (multiply layer — higher darkens more) and `DUST_COLOR` in `generate.js` (what it darkens toward) |
| Star/nebula colours | `CORE_COLOR` / `MID_COLOR` / `EDGE_COLOR` / `ACCENT_COLORS` / `NEBULA_COLORS` in `generate.js` |
