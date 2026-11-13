(function (root) {
  'use strict';
  const Fixed = typeof module !== 'undefined' && module.exports ? require('./fixed-exams.js') : root.FixedExams;
  async function mount(document, window) {
    const response = await window.fetch('assessment-bank.json');
    if (!response.ok) throw new Error('Catalogue de progression indisponible');
    const bank = await response.json();
    const exams = Fixed.defaultCatalog(bank);
    const store = window.LearningState.createStore({ bank, exams, getStorage: () => window.localStorage });
    const warnings = store.migrateLegacy();
    const reader = window.S8Reader.mountReader(document, window, window.S8_READING_CATALOG, store);
    const guide = window.S8Guide.mountGuide(document, window, () => window.localStorage, store);
    window.LearningState.mountTransfer(document, store, () => {
      const resume = document.getElementById('guide-resume');
      if (resume && store.snapshot().guide) resume.href = '#' + store.snapshot().guide.step;
    });
    if (warnings.length) document.getElementById('transfer-status').textContent = warnings.join(' ');
    return { bank, store, reader, guide };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { mount };
  else {
    root.S8SiteState = mount(root.document, root);
    root.S8SiteState.catch(error => {
    const status = root.document.getElementById('reading-status');
    if (status) status.textContent = `Progression non enregistrée : ${error.message}. Lecture et corrections natives disponibles.`;
    const pathStatus = root.document.getElementById('path-status');
    if (pathStatus) pathStatus.textContent = `Historique indisponible : ${error.message}. Le lien de départ reste utilisable.`;
    });
  }
}(typeof globalThis === 'undefined' ? this : globalThis));
