(function () {
  'use strict';

  const STEP_IDS = Object.freeze([
    'lecture', 'client', 'rappel-2', 'redirections', 'succes', 'rappel-4',
    'formats', 'autres', 'serveur', 'symfony', 'pieges', 'fiche'
  ]);
  const STORAGE_KEY = 's8-http-guide-v1';

  // Inject the storage accessor: even accessing localStorage may throw.
  function createProgress(getStorage) {
    let step = STEP_IDS[0];
    let storage;
    let persistence = 'ready';
    try {
      storage = getStorage();
      if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
        throw new TypeError('Storage unavailable');
      }
      const saved = storage.getItem(STORAGE_KEY);
      if (saved !== null) {
        try {
          const restored = JSON.parse(saved);
          if (!STEP_IDS.includes(restored)) throw new RangeError('Invalid saved step');
          step = restored;
          persistence = 'saved';
        } catch {
          persistence = 'corrupt';
        }
      }
    } catch {
      persistence = 'unavailable';
    }

    function snapshot() {
      const index = STEP_IDS.indexOf(step);
      return {
        step, position: index + 1, total: STEP_IDS.length, persistence,
        previous: STEP_IDS[index - 1] || null,
        next: STEP_IDS[index + 1] || null
      };
    }
    function visit(id) {
      if (!STEP_IDS.includes(id)) throw new RangeError('Unknown guide step');
      step = id;
      if (persistence === 'ready' || persistence === 'saved') {
        try {
          storage.setItem(STORAGE_KEY, JSON.stringify(step));
          persistence = 'saved';
        } catch {
          persistence = 'unavailable';
        }
      }
      return snapshot();
    }
    function next() { return visit(snapshot().next || step); }
    function previous() { return visit(snapshot().previous || step); }
    return { snapshot, visit, next, previous };
  }

  function hashTarget(document, hash) {
    if (!hash || hash === '#') return null;
    try {
      return document.getElementById(decodeURIComponent(hash.slice(1)));
    } catch (error) {
      if (error instanceof URIError) return null;
      throw error;
    }
  }

  function focusHash(document, hash) {
    const target = hashTarget(document, hash);
    if (target?.getAttribute('tabindex') === '-1') {
      // Native anchors own scrolling; only add keyboard focus to opted-in targets.
      target.focus({ preventScroll: true });
    }
    return target;
  }

  function sharedProgress(store) {
    function snapshot() {
      const step = store.snapshot().guide?.step || STEP_IDS[0];
      const index = STEP_IDS.indexOf(step);
      return { step, position: index + 1, total: STEP_IDS.length,
        persistence: store.status().persistence,
        previous: STEP_IDS[index - 1] || null, next: STEP_IDS[index + 1] || null };
    }
    function visit(step) { store.visitGuide(step); return snapshot(); }
    return { snapshot, visit, next: () => visit(snapshot().next || snapshot().step),
      previous: () => visit(snapshot().previous || snapshot().step) };
  }

  function mountGuide(document, window, getStorage = () => window.localStorage, store = null) {
    const status = document.getElementById('guide-status');
    if (!status) return null;
    const resume = document.getElementById('guide-resume');
    const steps = [...document.querySelectorAll('[data-step]')];
    const recallOrder = STEP_IDS.filter(id => !id.startsWith('rappel-'))
      .concat(['rappel-2', 'rappel-4']);
    const actualOrder = steps.map(node => node.id).join('|');
    if (!resume || ![STEP_IDS.join('|'), recallOrder.join('|')].includes(actualOrder)) {
      throw new Error('Guide structure does not match the ordered pilot steps');
    }
    const progress = store ? sharedProgress(store) : createProgress(getStorage);
    function render() {
      const state = progress.snapshot();
      // Persisted step IDs keep their old meaning; display order follows the page.
      const position = steps.findIndex(node => node.id === state.step) + 1;
      const label = steps[position - 1].dataset.step;
      const messages = {
        ready: 'Reprise locale disponible dès la prochaine étape visitée.',
        saved: 'Repère enregistré sur cet appareil.',
        unavailable: 'Progression non enregistrée : stockage indisponible ou refusé. Continuez avec les liens.',
        corrupt: 'Progression non enregistrée : repère stocké corrompu ou invalide ignoré. Navigation libre.'
      };
      status.textContent = `Repère ${position} / ${state.total} (checkpoints inclus) · ${label}. ${messages[state.persistence]}`;
      resume.setAttribute('href', `#${state.step}`);
      resume.textContent = `Reprendre · ${label}`;
    }
    function navigate() {
      const target = focusHash(document, window.location.hash);
      const step = target?.closest('[data-step]');
      if (step) progress.visit(step.id);
      render();
    }
    window.addEventListener('hashchange', navigate);
    document.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest('a[href]');
      // A repeated fragment does not emit hashchange. Never intercept details.
      if (link?.getAttribute('href') === window.location.hash) navigate();
    });
    navigate();
    if (store) store.subscribe(render);
    return progress;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { STEP_IDS, STORAGE_KEY, createProgress, sharedProgress, focusHash, mountGuide };
  } else if (typeof document !== 'undefined') {
    window.S8Guide = { mountGuide, sharedProgress };
    if (window.LearningState) return;
    try {
      mountGuide(document, window);
    } catch (error) {
      const status = document.getElementById('guide-status');
      if (status) status.textContent = 'Progression non enregistrée : guide indisponible. Les liens et corrections natifs restent utilisables.';
      console.error('Initialisation du parcours impossible.', error);
    }
  }
}());
