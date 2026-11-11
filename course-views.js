(function (root) {
  'use strict';

  function mountMenus(document, window) {
    const menus = [...document.querySelectorAll('.lot-course-menu, .course-section-disclosure')];
    if (!menus.length) return;
    const desktop = window.matchMedia('(min-width: 900px)');
    const update = () => menus.forEach(menu => { menu.open = desktop.matches; });
    update();
    desktop.addEventListener('change', update);
  }

  function mount(document, window) {
    mountMenus(document, window);
    const navigation = document.querySelector('.course-actions');
    if (!navigation) return null;
    const tabs = [...navigation.querySelectorAll('a[href]')];
    const panels = tabs.map(tab => document.getElementById(tab.getAttribute('href').slice(1)));
    if (panels.length !== 3 || panels.some(panel => !panel)) throw new Error('Vues du cours incomplètes');
    const toc = document.querySelector('.course-section-menu');
    let passageHash = '#view-course';
    let highlighted = null;

    function select(panel) {
      panels.forEach((candidate, index) => {
        const active = candidate === panel;
        candidate.hidden = !active;
        tabs[index].setAttribute('aria-selected', String(active));
        tabs[index].setAttribute('tabindex', active ? '0' : '-1');
      });
      if (toc) toc.hidden = panel !== panels[0];
    }

    function revealHash() {
      let id;
      try { id = decodeURIComponent(window.location.hash.slice(1)); }
      catch { select(panels[0]); return; }
      const target = document.getElementById(id);
      const panel = target?.closest('[data-course-panel]') || panels[0];
      select(panel);
      if (panel === panels[0]) passageHash = target ? window.location.hash : '#view-course';
      if (highlighted) highlighted.classList.remove('course-target');
      if (!target) return;
      for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.tagName === 'DETAILS') ancestor.open = true;
      }
      if (target.tagName === 'DETAILS') target.open = true;
      let passage = target;
      while (passage.classList.contains('outcome-anchor') && passage.nextElementSibling) {
        passage = passage.nextElementSibling;
      }
      highlighted = passage;
      passage.classList.add('course-target');
      passage.setAttribute('tabindex', '-1');
      passage.focus({ preventScroll: true });
      passage.scrollIntoView({ block: 'start' });
    }

    navigation.setAttribute('role', 'tablist');
    tabs.forEach((tab, index) => {
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', panels[index].id);
      panels[index].setAttribute('role', 'tabpanel');
      panels[index].setAttribute('aria-labelledby', tab.id);
      tab.addEventListener('click', event => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
        event.preventDefault();
        const hash = index === 0 ? passageHash : tab.getAttribute('href');
        if (window.location.hash !== hash) window.history.pushState(null, '', hash);
        select(panels[index]);
        tab.focus();
      });
      tab.addEventListener('keydown', event => {
        const next = {
          ArrowRight: (index + 1) % tabs.length,
          ArrowLeft: (index + tabs.length - 1) % tabs.length,
          Home: 0, End: tabs.length - 1,
        }[event.key];
        if (next !== undefined) {
          event.preventDefault();
          tabs.forEach((item, position) => item.setAttribute('tabindex', position === next ? '0' : '-1'));
          tabs[next].focus();
        } else if (event.key === ' ') {
          event.preventDefault();
          tab.click();
        }
      });
    });
    window.addEventListener('hashchange', revealHash);
    window.addEventListener('popstate', revealHash);
    // Same-fragment links do not emit hashchange after returning from another tab.
    document.addEventListener('click', event => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
      const link = event.target.closest('a[href]');
      if (!link || link.closest('.course-actions')) return;
      const url = new URL(link.getAttribute('href'), window.location.href);
      if (url.pathname === window.location.pathname && url.origin === window.location.origin &&
          url.hash && url.hash === window.location.hash) revealHash();
    });
    revealHash();
    return { revealHash, select };
  }

  async function mountQuiz(document, window, stateReady) {
    const status = document.getElementById('course-quiz-status');
    if (!status) return null;
    try {
      const { bank, store } = await stateReady;
      const moduleId = document.body.dataset.moduleId;
      const result = moduleId
        ? await window.Assessment.mountModule(document, window, {
          bank, store, moduleId, moduleTitle: document.querySelector('h1').textContent,
        })
        : await window.Assessment.mountCourse(document, window, {
          bank, store, courseId: document.body.dataset.courseId,
        });
      document.getElementById('course-quiz-controls').hidden = false;
      document.getElementById('course-quiz-native').hidden = true;
      store.subscribe(value => { status.textContent = value.message; });
      return result;
    } catch (error) {
      status.textContent = `Quiz indisponible : ${error.message}. Utilisez le contenu de consultation disponible ci-dessous ou les flashcards, sans notation.`;
      return null;
    }
  }

  const api = { mount, mountMenus, mountQuiz };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.CourseViews = api;
    mount(root.document, root);
    mountQuiz(root.document, root, root.S8SiteState);
  }
}(typeof globalThis === 'undefined' ? this : globalThis));
