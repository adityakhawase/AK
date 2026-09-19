/* ============================================================
   galaxy/widget.js
   Tiny floating controls for the galaxy background.

   Two buttons, bottom-left (the back-to-top button owns
   bottom-right):
     - pause / resume: freezes the galaxy loop plus every overlay
       (meteors, motes, fallback starfield) in one tap. State is
       announced via aria-pressed and the icon swaps.
     - quality: cycles Auto -> High -> Medium -> Low. Switching
       tiers re-builds the galaxy at the new particle budget; the
       choice persists in localStorage.

   The widget is a singleton owned by index.js: it survives quality
   re-inits (only the galaxy instance is disposed, never the
   widget) and it degrades to nothing when there is no galaxy
   instance to drive.
   ============================================================ */

const QUALITY_ORDER = ['auto', 'high', 'medium', 'low'];
const QUALITY_LABEL = {
    auto: 'Auto',
    high: 'High',
    medium: 'Med',
    low: 'Low',
};

export function createGalaxyWidget(hooks = {}) {
    const { getPaused, setPaused, getQuality, setQuality } = hooks;

    // Singleton: a second initGalaxy() call rebinds, never duplicates.
    let root = document.getElementById('galaxy-widget');
    if (root) return { element: root, sync: () => {}, dispose: () => {} };

    root = document.createElement('div');
    root.id = 'galaxy-widget';
    root.setAttribute('role', 'toolbar');
    root.setAttribute('aria-label', 'Galaxy background controls');

    const pauseBtn = document.createElement('button');
    pauseBtn.type = 'button';
    pauseBtn.id = 'galaxy-pause';
    pauseBtn.setAttribute('aria-pressed', 'false');
    pauseBtn.title = 'Pause galaxy motion';
    pauseBtn.setAttribute('aria-label', 'Pause galaxy motion');

    const pauseIcon = document.createElement('span');
    pauseIcon.className = 'galaxy-widget-icon';
    pauseIcon.setAttribute('aria-hidden', 'true');
    pauseBtn.appendChild(pauseIcon);

    const qualityBtn = document.createElement('button');
    qualityBtn.type = 'button';
    qualityBtn.id = 'galaxy-quality';
    qualityBtn.title = 'Cycle render quality (Auto / High / Medium / Low)';
    qualityBtn.setAttribute('aria-label', 'Cycle galaxy render quality');

    const qualityText = document.createElement('span');
    qualityText.className = 'galaxy-quality-text';
    qualityText.setAttribute('aria-hidden', 'true');
    qualityBtn.appendChild(qualityText);

    root.append(pauseBtn, qualityBtn);
    document.body.appendChild(root);

    function renderPause() {
        const paused = getPaused ? !!getPaused() : false;
        pauseBtn.setAttribute('aria-pressed', String(paused));
        pauseBtn.title = paused ? 'Resume galaxy motion' : 'Pause galaxy motion';
        pauseBtn.setAttribute('aria-label', paused ? 'Resume galaxy motion' : 'Pause galaxy motion');
        pauseIcon.textContent = paused ? '▶' : '❚❚';
    }

    function renderQuality() {
        const q = getQuality ? getQuality() : 'auto';
        qualityText.textContent = QUALITY_LABEL[q] || 'Auto';
        qualityBtn.title = `Galaxy quality: ${QUALITY_LABEL[q] || 'Auto'} (click to change)`;
    }

    pauseBtn.addEventListener('click', () => {
        if (!setPaused) return;
        setPaused(!(getPaused && getPaused()));
        renderPause();
    });

    qualityBtn.addEventListener('click', () => {
        if (!setQuality) return;
        const current = getQuality ? getQuality() : 'auto';
        const next = QUALITY_ORDER[(QUALITY_ORDER.indexOf(current) + 1) % QUALITY_ORDER.length];
        setQuality(next);
        renderQuality();
    });

    renderPause();
    renderQuality();

    // Refresh once the galaxy reports in (instance swaps on re-init).
    const onReady = () => {
        renderPause();
        renderQuality();
    };
    window.addEventListener('galaxy:ready', onReady);

    return {
        element: root,
        sync: onReady,
        dispose() {
            window.removeEventListener('galaxy:ready', onReady);
            root.remove();
        },
    };
}
