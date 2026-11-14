(function () {
  'use strict';
  const STORAGE_KEY = 's8-reading-v1';

  function createReadingProgress(getStorage, catalogue) {
    const allowed = new Set(catalogue);
    if (!allowed.size || catalogue.some(href => !/^(?:course-CRS-[A-Za-z0-9]+|cours-http)\.html(?:#(?:out-OUT-[A-Za-z0-9]+|s-[a-z0-9-]+))?$/.test(href))) {
      throw new TypeError('An explicit canonical reading catalogue is required');
    }
    let storage;
    let persistence = 'ready';
    let last = null;
    let visited = [];
    try {
      storage = getStorage();
      const saved = storage.getItem(STORAGE_KEY);
      if (saved !== null) {
        const data = JSON.parse(saved);
        if (data.version !== 1 || !allowed.has(data.last) || !Array.isArray(data.visited) ||
            data.visited.some(href => !allowed.has(href)) || new Set(data.visited).size !== data.visited.length) {
          throw new TypeError('Corrupt reading progress');
        }
        last = data.last;
        visited = data.visited;
        persistence = 'saved';
      }
    } catch (error) {
      persistence = error instanceof SyntaxError || error instanceof TypeError ? 'corrupt' : 'unavailable';
      storage = null;
    }
    const snapshot = () => ({ last, visited: [...visited], persistence });
    function visit(href) {
      if (!allowed.has(href)) throw new RangeError('Unknown canonical reading location');
      last = href;
      if (!visited.includes(href)) visited.push(href);
      if (storage) {
        try {
          storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, last, visited }));
          persistence = 'saved';
        } catch {
          persistence = 'unavailable';
          storage = null;
        }
      }
      return snapshot();
    }
    return { snapshot, visit };
  }

  function focusTarget(document, hash) {
    let id;
    try { id = decodeURIComponent(hash.replace(/^#/, '')); } catch { return null; }
    const target = document.getElementById(id);
    if (!target) return null;
    // OUT aliases are next to the teaching heading, never a generic page top.
    let passage = target;
    while (passage.classList.contains('outcome-anchor') && passage.nextElementSibling) passage = passage.nextElementSibling;
    const focus = passage.closest?.('h2,h3,h4,h5,h6,[data-concept]') || target;
    focus.setAttribute('tabindex', '-1');
    focus.focus({ preventScroll: true });
    return focus;
  }

  function sharedProgress(store, catalogue) {
    const allowed = new Set(catalogue);
    function snapshot() {
      const reads = store.snapshot().reads.filter(entry => allowed.has(entry.href)).sort((a, b) => b.at - a.at);
      return { last: reads[0]?.href || null, recent: reads.map(entry => entry.href),
        visited: reads.map(entry => entry.href), persistence: store.status().persistence };
    }
    function visit(href) {
      if (!allowed.has(href)) throw new RangeError('Unknown canonical reading location');
      // Non-OUT section anchors remain native navigation; portable progress records their course.
      store.markRead(href.includes('#s-') ? href.split('#')[0] : href);
      return snapshot();
    }
    return { snapshot, visit };
  }

  function readingSummary(state, members) {
    const allowed = new Set(members);
    const belongs = href => typeof href === 'string' && allowed.has(href.split('#')[0]);
    const visited = new Set(state.visited.filter(belongs).map(href => href.split('#')[0]));
    const recent = state.recent || [state.last, ...state.visited.slice().reverse()];
    return { last: recent.find(belongs) || null, visited, total: allowed.size };
  }

  function mountReader(document, window, catalogue, store = null) {
    if (!Array.isArray(catalogue)) throw new TypeError('Missing canonical reader catalogue');
    const progress = store ? sharedProgress(store, catalogue) : createReadingProgress(() => window.localStorage, catalogue);
    const status = document.getElementById('reading-status');
    const resume = document.getElementById('reading-resume');
    const pathResume = document.getElementById('path-resume');
    const pathStatus = document.getElementById('path-status');
    const courseCards = [...document.querySelectorAll('[data-reading-course]')];
    const members = courseCards.length
      ? courseCards.map(card => card.dataset.readingCourse)
      : catalogue.filter(href => !href.includes('#'));
    const defaultHref = pathResume?.getAttribute('data-default-href');
    const defaultLabel = pathResume?.textContent;
    const defaultModuleLabel = pathResume?.getAttribute('data-default-module-label');
    const messages = {
      ready: 'Reprise locale disponible après une visite.',
      saved: 'Repère de lecture enregistré sur cet appareil.',
      unavailable: 'Stockage indisponible : navigation libre, reprise en mémoire seulement.',
      corrupt: 'Ancien repère invalide ignoré : navigation libre, reprise en mémoire seulement.'
    };
    function render() {
      const state = progress.snapshot();
      if (status) status.textContent = `${messages[state.persistence]} Lire ne prouve pas la maîtrise à l’examen.`;
      if (resume && state.last) {
        resume.href = state.last;
        resume.textContent = 'Reprendre la dernière lecture';
      }
      if (pathResume) {
        const summary = readingSummary(state, members);
        pathResume.href = summary.last || defaultHref;
        pathResume.textContent = summary.last
          ? (courseCards.length ? 'Reprendre ce module' : 'Reprendre la lecture')
          : defaultLabel;
        const count = courseCards.length
          ? `${summary.visited.size} / ${summary.total} cours visités dans ce module. `
          : (summary.last ? 'Votre dernière lecture est disponible. '
            : `Aucune lecture enregistrée. ${defaultModuleLabel ? `Départ : ${defaultModuleLabel}. ` : ''}`);
        const warning = ['corrupt', 'unavailable'].includes(state.persistence) ? `${messages[state.persistence]} ` : '';
        if (pathStatus) pathStatus.textContent = `${warning}${count}Une visite ne prouve pas la maîtrise.`;
        for (const card of courseCards) {
          card.querySelector('.reading-state').textContent = summary.visited.has(card.dataset.readingCourse)
            ? 'Déjà visité · repère de lecture uniquement' : 'Pas encore visité';
        }
      }
    }
    function locationChanged() {
      const current = window.location.pathname.split('/').pop() + window.location.hash;
      if (catalogue.includes(current)) progress.visit(current);
      focusTarget(document, window.location.hash);
      render();
    }
    window.addEventListener('hashchange', locationChanged);
    // Landing without an explicit fragment offers the previous repère before recording this page.
    render();
    if (window.location.hash) locationChanged();
    else {
      const current = window.location.pathname.split('/').pop();
      if (catalogue.includes(current)) progress.visit(current);
    }
    document.addEventListener('click', event => {
      const link = event.target.closest('a[href]');
      if (!link) return;
      const href = link.getAttribute('href');
      const local = href.startsWith('#') ? window.location.pathname.split('/').pop() + href : href;
      if (catalogue.includes(local)) progress.visit(local);
    });
    if (store) store.subscribe(render);
    return progress;
  }

  if (typeof module !== 'undefined') module.exports = { STORAGE_KEY, createReadingProgress, sharedProgress, readingSummary, focusTarget, mountReader };
  if (typeof document !== 'undefined') {
    window.S8Reader = { mountReader, sharedProgress, focusTarget };
    if (!window.LearningState) mountReader(document, window, window.S8_READING_CATALOG);
    else {
      // Canonical correction focus must not depend on loading the progress bank.
      focusTarget(document, window.location.hash);
      window.addEventListener('hashchange', () => focusTarget(document, window.location.hash));
    }
  }
}());
