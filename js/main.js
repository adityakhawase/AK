/* ============================================================
   Aditya Khawase — Portfolio
   main.js  ·  motion + interaction layer (no dependencies)
   ============================================================ */

(function () {
    'use strict';

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const finePointer  = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const $  = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    /* ---------------------------------------------------------
       1. Preloader
    --------------------------------------------------------- */
    function initPreloader() {
        const pre = $('#preloader');
        if (!pre) return;

        let done = false;
        const hide = () => {
            if (done) return;
            done = true;
            pre.classList.add('done');
            document.body.style.overflow = '';
            setTimeout(() => pre.remove(), 700);
        };

        document.body.style.overflow = 'hidden';

        /* When the galaxy is in play, hold the loader until its first
           frame is on screen — otherwise the reveal lands on an empty
           canvas. Everything below is a guard against that never firing. */
        const waitingForGalaxy = document.documentElement.dataset.galaxy === 'on';
        let pageLoaded = document.readyState === 'complete';
        let galaxyReady = !waitingForGalaxy;

        const maybeHide = () => {
            if (pageLoaded && galaxyReady) setTimeout(hide, reduceMotion ? 0 : 450);
        };

        window.addEventListener('load', () => { pageLoaded = true; maybeHide(); });
        window.addEventListener('galaxy:ready', () => { galaxyReady = true; maybeHide(); });
        maybeHide();

        // Safety net: never trap the page behind the loader.
        setTimeout(hide, 5000);
    }

    /* ---------------------------------------------------------
       3. Scroll progress bar + sticky nav state + back-to-top
    --------------------------------------------------------- */
    function initScrollChrome() {
        const bar   = $('#scroll-progress');
        const nav   = $('nav');
        const toTop = $('#to-top');
        let ticking = false;

        function update() {
            const y   = window.scrollY;
            const max = document.documentElement.scrollHeight - window.innerHeight;
            if (bar) bar.style.transform = `scaleX(${max > 0 ? y / max : 0})`;
            if (nav) nav.classList.toggle('scrolled', y > 40);
            if (toTop) toTop.classList.toggle('show', y > 600);
            ticking = false;
        }

        window.addEventListener('scroll', () => {
            if (!ticking) {
                ticking = true;
                requestAnimationFrame(update);
            }
        }, { passive: true });

        update();

        if (toTop) {
            toTop.addEventListener('click', () => {
                window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
            });
        }
    }

    /* ---------------------------------------------------------
       4. Mobile nav toggle + smooth anchor scrolling
    --------------------------------------------------------- */
    function initNav() {
        const toggle = $('.nav-toggle');
        const list   = $('nav ul');

        if (toggle && list) {
            const nav = $('nav');
            toggle.addEventListener('click', () => {
                const open = list.classList.toggle('open');
                toggle.setAttribute('aria-expanded', String(open));
                if (nav) nav.classList.toggle('menu-open', open);
            });
        }

        $$('a[href^="#"]').forEach((a) => {
            a.addEventListener('click', (e) => {
                const id = a.getAttribute('href');
                if (id.length < 2) return;
                const target = document.querySelector(id);
                if (!target) return;
                e.preventDefault();
                target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
                if (list && list.classList.contains('open')) {
                    list.classList.remove('open');
                    const navEl = $('nav');
                    if (navEl) navEl.classList.remove('menu-open');
                    if (toggle) toggle.setAttribute('aria-expanded', 'false');
                    if (window.__closeSubmenus) window.__closeSubmenus();
                }
                history.replaceState(null, '', id);
            });
        });
    }

    /* ---------------------------------------------------------
        4b. "More" submenu — click toggle (touch/keyboard), hover
        works via CSS on desktop. One open at a time; Escape or an
        outside click closes it.
    --------------------------------------------------------- */
    function initSubmenu() {
        const items = $$('.has-submenu');
        if (!items.length) return;

        const closeAll = (except) => {
            items.forEach((li) => {
                if (li === except) return;
                li.classList.remove('open');
                const btn = $('.submenu-toggle', li);
                if (btn) btn.setAttribute('aria-expanded', 'false');
            });
        };

        items.forEach((li) => {
            const btn = $('.submenu-toggle', li);
            if (!btn) return;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const willOpen = !li.classList.contains('open');
                closeAll(li);
                li.classList.toggle('open', willOpen);
                btn.setAttribute('aria-expanded', String(willOpen));
            });
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.has-submenu')) closeAll();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeAll();
        });

        // Exposed so the mobile menu can reset submenus when it closes.
        window.__closeSubmenus = () => closeAll();
    }
    /* ---------------------------------------------------------
       5. Scroll-spy (IntersectionObserver, no scroll math)
    --------------------------------------------------------- */
    function initScrollSpy() {
        const links = $$('nav a[href^="#"]');
        if (!links.length) return;

        const sections = links
            .map((l) => document.querySelector(l.getAttribute('href')))
            .filter(Boolean);
        if (!sections.length) return;

        const spy = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;
                links.forEach((l) => {
                    l.classList.toggle('active', l.getAttribute('href') === '#' + entry.target.id);
                });
            });
        }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });

        sections.forEach((s) => spy.observe(s));
    }

    /* ---------------------------------------------------------
       6. Scroll reveal with stagger
    --------------------------------------------------------- */
    function initReveal() {
        const items = $$('[data-reveal]');
        if (!items.length) return;

        if (reduceMotion || !('IntersectionObserver' in window)) {
            items.forEach((el) => el.classList.add('revealed'));
            return;
        }

        const io = new IntersectionObserver((entries, obs) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;
                const el = entry.target;
                const delay = Number(el.dataset.delay || 0);
                el.style.setProperty('--delay', delay + 'ms');
                el.classList.add('revealed');
                obs.unobserve(el);
            });
        }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });

        items.forEach((el) => io.observe(el));

        // auto-stagger children of any grid
        $$('.skills-grid, .projects-grid, .stat-grid, .contact-info').forEach((grid) => {
            $$('[data-reveal]', grid).forEach((child, i) => {
                if (!child.dataset.delay) child.dataset.delay = String(i * 110);
            });
        });
    }

    /* ---------------------------------------------------------
       7. Headline: split into animated letters
    --------------------------------------------------------- */
    function initSplitText() {
        const el = $('[data-split]');
        if (!el || reduceMotion) return;

        const text = el.textContent.trim();
        el.textContent = '';
        el.setAttribute('aria-label', text);

        [...text].forEach((ch, i) => {
            const span = document.createElement('span');
            span.className = 'letter';
            span.setAttribute('aria-hidden', 'true');
            span.textContent = ch === ' ' ? '\u00A0' : ch;
            span.style.animationDelay = (250 + i * 55) + 'ms';
            el.appendChild(span);
        });
    }

    /* ---------------------------------------------------------
       8. Typing effect for the hero roles
    --------------------------------------------------------- */
    function initTyping() {
        const el = $('#typed');
        if (!el) return;

        let roles = [];
        try {
            roles = JSON.parse(el.dataset.words || '[]');
        } catch (err) {
            roles = [];
        }
        if (!roles.length) return;

        if (reduceMotion) {
            el.textContent = roles[0];
            return;
        }

        let word = 0, char = 0, deleting = false;

        (function tick() {
            const current = roles[word];
            char += deleting ? -1 : 1;
            el.textContent = current.slice(0, char);

            let wait = deleting ? 45 : 85;
            if (!deleting && char === current.length) {
                wait = 1600;
                deleting = true;
            } else if (deleting && char === 0) {
                deleting = false;
                word = (word + 1) % roles.length;
                wait = 320;
            }
            setTimeout(tick, wait);
        })();
    }

    /* ---------------------------------------------------------
       9. Hero particle field
    --------------------------------------------------------- */
    /* The galaxy module owns the hero background when it loads. This
       waits for it to confirm, and only revives the original constellation
       if the module never reports in (script blocked, 404, etc.). */
    function initParticles() {
        const canvas = $('#hero-particles');
        if (!canvas || reduceMotion) return;

        if (document.documentElement.dataset.galaxy === 'pending') {
            let settled = false;
            const takeOver = () => {
                if (settled) return;
                settled = true;
                canvas.remove();
            };
            const revive = () => {
                if (settled) return;
                settled = true;
                document.documentElement.dataset.galaxy = 'off';
                startParticles(canvas);
            };
            window.addEventListener('galaxy:ready', takeOver, { once: true });
            setTimeout(revive, 2500);
            return;
        }

        startParticles(canvas);
    }

    function startParticles(canvas) {

        const ctx = canvas.getContext('2d');
        let w = 0, h = 0, dots = [], raf = null;
        const mouse = { x: -9999, y: -9999 };

        function size() {
            const rect = canvas.parentElement.getBoundingClientRect();
            const dpr  = Math.min(window.devicePixelRatio || 1, 2);
            w = rect.width;
            h = rect.height;
            canvas.width  = w * dpr;
            canvas.height = h * dpr;
            canvas.style.width  = w + 'px';
            canvas.style.height = h + 'px';
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            const count = Math.min(90, Math.round((w * h) / 16000));
            dots = Array.from({ length: count }, () => ({
                x: Math.random() * w,
                y: Math.random() * h,
                vx: (Math.random() - 0.5) * 0.32,
                vy: (Math.random() - 0.5) * 0.32,
                r: Math.random() * 1.7 + 0.6
            }));
        }

        function frame() {
            ctx.clearRect(0, 0, w, h);

            for (let i = 0; i < dots.length; i++) {
                const d = dots[i];
                d.x += d.vx;
                d.y += d.vy;
                if (d.x < 0 || d.x > w) d.vx *= -1;
                if (d.y < 0 || d.y > h) d.vy *= -1;

                ctx.beginPath();
                ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(0, 255, 136, 0.65)';
                ctx.fill();

                for (let j = i + 1; j < dots.length; j++) {
                    const o  = dots[j];
                    const dx = d.x - o.x;
                    const dy = d.y - o.y;
                    const dist = Math.hypot(dx, dy);
                    if (dist < 118) {
                        ctx.beginPath();
                        ctx.moveTo(d.x, d.y);
                        ctx.lineTo(o.x, o.y);
                        ctx.strokeStyle = `rgba(0, 255, 136, ${(1 - dist / 118) * 0.16})`;
                        ctx.lineWidth = 1;
                        ctx.stroke();
                    }
                }

                const mdx = d.x - mouse.x;
                const mdy = d.y - mouse.y;
                const mdist = Math.hypot(mdx, mdy);
                if (mdist < 150) {
                    ctx.beginPath();
                    ctx.moveTo(d.x, d.y);
                    ctx.lineTo(mouse.x, mouse.y);
                    ctx.strokeStyle = `rgba(255, 0, 255, ${(1 - mdist / 150) * 0.35})`;
                    ctx.lineWidth = 1;
                    ctx.stroke();
                }
            }
            raf = requestAnimationFrame(frame);
        }

        size();
        frame();

        window.addEventListener('resize', size);
        canvas.parentElement.addEventListener('mousemove', (e) => {
            const r = canvas.getBoundingClientRect();
            mouse.x = e.clientX - r.left;
            mouse.y = e.clientY - r.top;
        }, { passive: true });
        canvas.parentElement.addEventListener('mouseleave', () => {
            mouse.x = mouse.y = -9999;
        });

        // pause the loop when the hero is off screen
        new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting && !raf) {
                    frame();
                } else if (!entry.isIntersecting && raf) {
                    cancelAnimationFrame(raf);
                    raf = null;
                }
            });
        }, { threshold: 0 }).observe(canvas.parentElement);
    }

    /* ---------------------------------------------------------
       10. Card 3D tilt + spotlight
    --------------------------------------------------------- */
    function initTilt() {
        if (!finePointer || reduceMotion) return;

        $$('.skill-item, .project-item').forEach((card) => {
            card.addEventListener('mousemove', (e) => {
                const r  = card.getBoundingClientRect();
                const px = (e.clientX - r.left) / r.width;
                const py = (e.clientY - r.top) / r.height;

                card.style.setProperty('--mx', (px * 100) + '%');
                card.style.setProperty('--my', (py * 100) + '%');
                card.style.transform =
                    `perspective(900px) rotateX(${(0.5 - py) * 7}deg) ` +
                    `rotateY(${(px - 0.5) * 9}deg) translateY(-8px) scale(1.015)`;
            });

            card.addEventListener('mouseleave', () => {
                card.style.transform = '';
            });
        });
    }

    /* ---------------------------------------------------------
       11. Magnetic buttons
    --------------------------------------------------------- */
    function initMagnetic() {
        if (!finePointer || reduceMotion) return;

        $$('.btn, .btn-ghost, #to-top').forEach((btn) => {
            btn.addEventListener('mousemove', (e) => {
                const r = btn.getBoundingClientRect();
                const x = e.clientX - r.left - r.width / 2;
                const y = e.clientY - r.top - r.height / 2;
                btn.style.transform =
                    `translate(${x * 0.22}px, ${y * 0.32 - 3}px) scale(1.03)`;
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.transform = '';
            });
        });
    }

    /* ---------------------------------------------------------
       12. Count-up stats
    --------------------------------------------------------- */
    function initCounters() {
        const nums = $$('[data-count]');
        if (!nums.length) return;

        const run = (el) => {
            const target = Number(el.dataset.count);
            const suffix = el.dataset.suffix || '';
            if (reduceMotion) {
                el.textContent = target + suffix;
                return;
            }
            const dur = 1400;
            const t0  = performance.now();
            (function step(now) {
                const p = Math.min((now - t0) / dur, 1);
                const eased = 1 - Math.pow(1 - p, 3);
                el.textContent = Math.round(target * eased) + suffix;
                if (p < 1) requestAnimationFrame(step);
            })(t0);
        };

        const io = new IntersectionObserver((entries, obs) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    run(entry.target);
                    obs.unobserve(entry.target);
                }
            });
        }, { threshold: 0.5 });

        nums.forEach((n) => io.observe(n));
    }

    /* ---------------------------------------------------------
       13. Hero parallax on scroll
    --------------------------------------------------------- */
    function initParallax() {
        const inner  = $('.hero-inner');
        const slider = $('.hero-slider');
        if ((!inner && !slider) || reduceMotion) return;

        let ticking = false;
        window.addEventListener('scroll', () => {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                const y = window.scrollY;
                if (y < window.innerHeight * 1.2) {
                    if (inner) {
                        inner.style.transform = `translateY(${y * 0.22}px)`;
                        inner.style.opacity = String(Math.max(0, 1 - y / (window.innerHeight * 0.72)));
                    }
                    if (slider) slider.style.filter =
                        `blur(${5 + y / 110}px) saturate(55%) brightness(${Math.max(0.2, 0.42 - y / 2600)})`;
                }
                ticking = false;
            });
        }, { passive: true });
    }

    /* ---------------------------------------------------------
       14. Marquee: duplicate the track so the loop is seamless
    --------------------------------------------------------- */
    function initMarquee() {
        $$('.marquee-track').forEach((track) => {
            track.innerHTML += track.innerHTML;
        });
    }

    /* ---------------------------------------------------------
       Boot
    --------------------------------------------------------- */
    function boot() {
        initPreloader();
        initScrollChrome();
        initNav();
        initSubmenu();
        initScrollSpy();
        initMarquee();
        initReveal();
        initSplitText();
        initTyping();
        initParticles();
        initTilt();
        initMagnetic();
        initCounters();
        initParallax();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
