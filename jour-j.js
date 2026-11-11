(function (root) {
  'use strict';
  const State = typeof module !== 'undefined' && module.exports ? require('./learning-state.js') : root.LearningState;
  const Assessment = typeof module !== 'undefined' && module.exports ? require('./assessment.js') : root.Assessment;
  const CHECKLIST = Object.freeze([
    '75 questions, 90 minutes, in English.',
    'Read the requested answer count; distinguish one answer from multiple answers.',
    '90 × 60 ÷ 75 = 72 seconds per question on average: arithmetic, not an official strategy.',
    'Check your own invitation for the applicable technical requirements and logistics.',
  ]);
  const clone = value => JSON.parse(JSON.stringify(value));
  const requireThat = (condition, message) => { if (!condition) throw new RangeError(message); };

  function plan(bank, state, now = Date.now()) {
    const progress = Assessment.courseProgress(bank, state, now);
    const weakTopics = new Set(progress.filter(course => course.fragile).map(course => course.topic));
    const personalized = progress.some(course => course.attempt_count > 0);
    const order = [...bank.topics.filter(topic => weakTopics.has(topic)), ...bank.topics.filter(topic => !weakTopics.has(topic))];
    return {
      personalized, order,
      weak_ids: order.filter(topic => weakTopics.has(topic))
        .map(topic => bank.jour_j.find(card => card.topic === topic).id).slice(0, 6)
    };
  }

  function createJourney({ bank, store, now = Date.now }) {
    let revealed = null;
    function current() {
      const state = store.snapshot().jourj;
      requireThat(state, 'Start the review first');
      return state;
    }
    function start() {
      if (store.snapshot().jourj) return current();
      const initial = plan(bank, store.snapshot(), now());
      const state = { order: initial.order, visited: [], flagged: [], checkpoint: initial.order[0],
        weak_ids: initial.weak_ids, weak_visited: [], at: now() };
      store.saveJourJ(state);
      return current();
    }
    function cardFor(state) {
      if (state.checkpoint === 'checklist') return null;
      if (state.checkpoint === 'weak') {
        return bank.jour_j.find(card => card.id === state.weak_ids.find(id => !state.weak_visited.includes(id))) || null;
      }
      return bank.jour_j.find(card => card.topic === state.checkpoint);
    }
    function view() {
      const state = current();
      const card = cardFor(state);
      return {
        checkpoint: state.checkpoint, visited_count: state.visited.length, total: bank.topics.length,
        weak_count: state.weak_ids.length, weak_visited_count: state.weak_visited.length,
        personalized: plan(bank, store.snapshot(), now()).personalized,
        flagged_ids: state.flagged.filter(entry => entry.flagged).map(entry => entry.card_id),
        card: card ? { id: card.id, topic: card.topic, facts_fr: [...card.facts_fr], prompt_en: card.prompt_en,
          ...(revealed === card.id ? {
            answer_en: card.answer_en, explanation_fr: card.explanation_fr, target_href: card.target_href
          } : {}) } : null,
        checklist: state.checkpoint === 'checklist' ? [...CHECKLIST] : [],
      };
    }
    function reveal() {
      const card = cardFor(current());
      requireThat(card, 'No retrieval card at this checkpoint');
      revealed = card.id;
      return view();
    }
    function rate(rating) {
      requireThat(['clear', 'review'].includes(rating), 'Unknown self-rating');
      const state = current();
      const card = cardFor(state);
      requireThat(card && revealed === card.id, 'Reveal the answer before self-rating');
      const at = now();
      requireThat(at >= state.at, 'Clock moved backward; check your device clock');
      state.flagged = state.flagged.filter(entry => entry.card_id !== card.id)
        .concat([{ card_id: card.id, flagged: rating === 'review', at }]);
      if (state.checkpoint === 'weak') {
        state.weak_visited = [...new Set([...state.weak_visited, card.id])];
        if (state.weak_visited.length === state.weak_ids.length) state.checkpoint = 'checklist';
      } else {
        state.visited = state.visited.filter(entry => entry.topic !== card.topic)
          .concat([{ topic: card.topic, rating, at }]);
        const next = state.order.find(topic => !state.visited.some(entry => entry.topic === topic));
        if (next) state.checkpoint = next;
        else {
          const flags = state.flagged.filter(entry => entry.flagged).map(entry => entry.card_id);
          state.weak_ids = [...new Set([...flags, ...state.weak_ids])].slice(0, 6);
          state.checkpoint = state.weak_ids.length ? 'weak' : 'checklist';
        }
      }
      state.at = at;
      store.saveJourJ(state);
      revealed = null;
      return view();
    }
    return { start, view, reveal, rate };
  }

  function element(document, tag, text, attributes = {}) {
    const node = document.createElement(tag);
    if (text !== null && text !== undefined) node.textContent = text;
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  }

  async function mount(document, window) {
    const host = document.getElementById('jour-j-app');
    if (!host) return null;
    const response = await window.fetch('assessment-bank.json');
    if (!response.ok) throw new Error(`Bank unavailable (${response.status})`);
    const bank = await response.json();
    const store = State.createStore({ bank, getStorage: () => window.localStorage });
    const warnings = store.migrateLegacy();
    const error = document.getElementById('jour-j-error');
    if (warnings.length) error.textContent = warnings.join(' ');
    const journey = createJourney({ bank, store });
    const engine = Assessment.createEngine({ bank, store });
    const status = document.getElementById('jour-j-status');
    function safe(action) {
      return () => {
        error.textContent = '';
        try { action(); } catch (failure) { error.textContent = failure.message; }
      };
    }
    function render() {
      host.replaceChildren();
      const simulations = store.snapshot().sessions.filter(session => session.mode === 'simulation' && session.ended_at === null);
      simulations.forEach(session => engine.tick(session.id));
      const active = store.snapshot().sessions.find(session => session.mode === 'simulation' && session.ended_at === null);
      if (active) {
        status.textContent = 'Une simulation reste en cours. Aucun timer Jour J n’est démarré ; terminez ou reprenez la simulation avant le parcours interactif.';
        host.append(element(document, 'p',
          `La simulation expire le ${new Date(active.deadline).toLocaleString('fr-FR')}, même hors de sa page. Ce délai ne peut pas être mis en pause.`),
        element(document, 'a', 'Reprendre la simulation visible', { href: 'assessment.html?mode=simulation' }));
        const end = element(document, 'button', 'End simulation and enter Jour J', { type: 'button', lang: 'en' });
        end.addEventListener('click', safe(() => {
          if (!window.confirm('End the active simulation? Unanswered questions will remain unanswered.')) return;
          engine.finish(active.id); render(); host.focus();
        }));
        host.append(end);
        return;
      }
      journey.start();
      const view = journey.view();
      status.textContent = `${view.visited_count} / 14 domaines visités · ${view.weak_visited_count} / ${view.weak_count} cartes de reprise visitées. ` +
        (view.personalized ? 'Ordre initial éclairé par les tentatives locales.' : 'Départ sans historique : parcours équilibré, non personnalisé.');
      if (view.card) {
        const card = view.card;
        host.append(element(document, 'h2', `${view.checkpoint === 'weak' ? 'Reprise bornée — ' : ''}${card.topic}`));
        const facts = element(document, 'ul');
        card.facts_fr.forEach(fact => facts.append(element(document, 'li', fact)));
        host.append(facts, element(document, 'p', card.prompt_en, { lang: 'en' }));
        if (!card.answer_en) {
          const reveal = element(document, 'button', 'Reveal answer', { type: 'button', lang: 'en' });
          reveal.addEventListener('click', safe(() => { journey.reveal(); render(); host.focus(); }));
          host.append(reveal);
        } else {
          host.append(element(document, 'p', card.answer_en, { lang: 'en' }),
            element(document, 'p', card.explanation_fr),
            element(document, 'a', 'Relire le passage exact', { href: card.target_href }));
          host.append(element(document, 'p', 'Auto-évaluation de clarté uniquement : aucune tentative correcte ou réussite différée n’est ajoutée.'));
          for (const [text, rating] of [['Clair', 'clear'], ['À revoir', 'review']]) {
            const button = element(document, 'button', text, { type: 'button' });
            button.addEventListener('click', safe(() => { journey.rate(rating); render(); host.focus(); }));
            host.append(button);
          }
        }
      } else {
        host.append(element(document, 'h2', 'Checklist finale'));
        const list = element(document, 'ul');
        view.checklist.forEach(item => list.append(element(document, 'li', item, { lang: 'en' })));
        host.append(list, element(document, 'p',
          'Les 14 domaines ont été visités, pas les 163 cours relus. Ce parcours ne prédit aucun score. Les flags « À revoir » restent dans votre progression portable.'));
      }
    }
    State.mountTransfer(document, store, render);
    render();
    return { bank, store, journey };
  }
  const api = { CHECKLIST, plan, createJourney, mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.JourJ = api;
    if (root.document?.getElementById('jour-j-app')) mount(root.document, root).catch(error => {
      root.document.getElementById('jour-j-error').textContent =
        `Parcours interactif indisponible : ${error.message}. Le rappel natif des 14 domaines reste utilisable ci-dessous.`;
    });
  }
}(typeof globalThis === 'undefined' ? this : globalThis));
