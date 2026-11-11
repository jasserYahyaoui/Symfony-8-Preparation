(function (root) {
  'use strict';
  const State = typeof module !== 'undefined' && module.exports ? require('./learning-state.js') : root.LearningState;
  const DELAY_MS = 24 * 60 * 60 * 1000;
  const ERROR_DELAY_MS = 10 * 60 * 1000;
  const SIMULATION_MS = 90 * 60 * 1000;
  const clone = value => JSON.parse(JSON.stringify(value));
  const requireThat = (condition, message) => { if (!condition) throw new RangeError(message); };
  const idFactory = () => `s-${root.crypto.randomUUID()}`;

  function score(question, answer) {
    if (!answer) return { correct: false, status: 'unanswered', fragile: true };
    if (answer.unknown) return { correct: false, status: 'unknown', fragile: true };
    const expected = question.choices.filter(choice => choice.correct).map(choice => choice.id).sort();
    const selected = answer.selected;
    const correct = Array.isArray(selected) && new Set(selected).size === selected.length &&
      [...selected].sort().join('|') === expected.join('|');
    return { correct, status: correct ? 'correct' : 'incorrect',
      fragile: !correct || answer.confidence !== 'confident' };
  }

  function shuffled(items, random = Math.random) {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index--) {
      const sample = random();
      requireThat(Number.isFinite(sample) && sample >= 0 && sample < 1, 'Invalid random source');
      const other = Math.floor(sample * (index + 1));
      [copy[index], copy[other]] = [copy[other], copy[index]];
    }
    return copy;
  }

  function interleave(items, topics, limit = 14) {
    const queues = new Map(topics.map(topic => [topic, []]));
    for (const item of items) {
      requireThat(queues.has(item.topic), 'Unknown domain');
      queues.get(item.topic).push(item);
    }
    const result = [];
    while (result.length < limit) {
      let advanced = false;
      for (const topic of topics) {
        const next = queues.get(topic).shift();
        if (next && result.length < limit) { result.push(next); advanced = true; }
      }
      if (!advanced) break;
    }
    return result;
  }

  function selectDiagnostic(bank, random = Math.random) {
    return bank.topics.map(topic => {
      const eligible = bank.items.filter(question => question.pool === 'learning' && question.topic === topic);
      requireThat(eligible.length, `No learning item for ${topic}`);
      return shuffled(eligible, random)[0];
    });
  }

  function selectLearning(bank, { courseId = null, moduleId = null } = {}, random = Math.random) {
    requireThat(!courseId || !moduleId, 'Choose a course or module, not both');
    if (courseId !== null) requireThat(bank.courses.some(course => course.id === courseId), 'Unknown course');
    const members = bank.courses.filter(course => course.lot === moduleId);
    if (moduleId !== null) requireThat(members.length, 'Unknown module');
    const ids = new Set(members.map(course => course.id));
    const eligible = bank.items.filter(question => question.pool === 'learning' &&
      (courseId === null || question.course_id === courseId) &&
      (moduleId === null || ids.has(question.course_id)));
    requireThat(eligible.length, 'No eligible learning questions for this context');
    return interleave(shuffled(eligible, random), bank.topics, 14);
  }

  function selectSimulation(bank, random = Math.random) {
    const eligible = bank.items.filter(question => question.pool === 'validation');
    requireThat(new Set(eligible.map(question => question.id)).size >= 75, '75 unique validation questions required');
    // Include every domain and all available response formats, without claiming
    // these local balancing choices are official examination weights.
    const candidates = shuffled(eligible, random);
    const mandatory = new Map();
    for (const topic of bank.topics) {
      const question = candidates.find(item => item.topic === topic);
      requireThat(question, `No validation item for ${topic}`);
      mandatory.set(question.id, question);
    }
    for (const format of ['single', 'multiple', 'true_false', 'predict']) {
      const question = candidates.find(item => item.format === format);
      if (question) mandatory.set(question.id, question);
    }
    for (const question of interleave(candidates, bank.topics, candidates.length)) {
      if (mandatory.size < 75) mandatory.set(question.id, question);
    }
    return shuffled([...mandatory.values()], random);
  }

  function courseProgress(bank, state, now = Date.now()) {
    const questions = new Map(bank.items.map(question => [question.id, question]));
    const grouped = new Map(bank.courses.map(course => [course.id, []]));
    for (const attempt of state.attempts) {
      const question = questions.get(attempt.question_id);
      if (question && attempt.at <= now) grouped.get(question.course_id).push({ ...attempt, question });
    }
    return bank.courses.map(course => {
      const attempts = grouped.get(course.id).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id, 'en'));
      let anchor = null;
      let immediate = false;
      let delayed = false;
      let fragile = false;
      let due = null;
      let errors = 0;
      let last = null;
      for (const attempt of attempts) {
        const result = score(attempt.question, attempt);
        last = attempt;
        if (!result.correct || result.fragile) {
          if (!result.correct) errors++;
          anchor = null; immediate = false; delayed = false;
          fragile = true;
          due = attempt.at + ERROR_DELAY_MS;
        } else if (attempt.mode !== 'simulation') {
          immediate = true;
          if (anchor && attempt.at - anchor.at >= DELAY_MS &&
            attempt.question_id !== anchor.question_id &&
            (attempt.question.variant_group || attempt.question_id) !==
              (anchor.question.variant_group || anchor.question_id)) {
            delayed = true;
          }
          if (!anchor) anchor = attempt;
          fragile = !delayed;
          due = attempt.at + (delayed ? 3 * DELAY_MS : DELAY_MS);
        }
      }
      const read = state.reads.some(entry => entry.href === course.href || entry.href.startsWith(course.href + '#'));
      return {
        course_id: course.id, topic: course.topic, read, immediate, delayed,
        fragile,
        due_at: due, attempt_count: attempts.length, error_count: errors,
        last_confidence: last?.confidence || null, last_question_id: last?.question_id || null,
        anchor_question_id: anchor?.question_id || null,
      };
    });
  }

  function selectReview(bank, state, now = Date.now(), limit = 14) {
    requireThat(Number.isInteger(limit) && limit >= 1 && limit <= 14, 'Review bound is 1–14');
    const progress = courseProgress(bank, state, now)
      .filter(course => course.due_at !== null && course.due_at <= now)
      .sort((a, b) => Number(b.fragile) - Number(a.fragile) || a.due_at - b.due_at || a.course_id.localeCompare(b.course_id, 'en'));
    const candidates = progress.map(course => {
      const eligible = bank.items.filter(question => question.pool === 'learning' && question.course_id === course.course_id);
      const previous = bank.items.find(question => question.id === (course.anchor_question_id || course.last_question_id));
      return eligible.find(question => question.id !== previous?.id && question.variant_group !== previous?.variant_group) || eligible[0];
    }).filter(Boolean);
    const topicOrder = [...new Set(progress.map(course => course.topic)), ...bank.topics.filter(topic => !progress.some(course => course.topic === topic))];
    return interleave(candidates, topicOrder, limit);
  }

  function responseControl(question) {
    requireThat(Array.isArray(question.choices) && question.choices.length >= 2 &&
      question.choices.every(choice => typeof choice.correct === 'boolean'), 'Invalid question choices');
    const count = question.choices.filter(choice => choice.correct).length;
    requireThat(count > 0 && count < question.choices.length, 'Question needs correct and incorrect choices');
    requireThat(question.format !== 'true_false' || (question.choices.length === 2 && count === 1),
      'True/False requires two choices and one correct answer');
    return count === 1 ? { type: 'radio', instruction: 'Select one answer' }
      : { type: 'checkbox', instruction: 'Select all correct answers' };
  }

  function sessionContext(bank, session) {
    requireThat(State.MODES.includes(session.mode), 'Unknown assessment mode');
    const questions = session.question_ids.map(id => bank.items.find(item => item.id === id));
    requireThat(questions.length && questions.every(item => item &&
      item.pool === (session.mode === 'simulation' ? 'validation' : 'learning')), 'Invalid session pool');
    if (session.mode !== 'learning') return { mode: session.mode, courseId: null, moduleId: null };
    const tagged = session.id.match(/^(course|module):([^:]+):/);
    if (tagged) {
      const members = bank.courses.filter(course => tagged[1] === 'course'
        ? course.id === tagged[2] : course.lot === tagged[2]);
      requireThat(members.length && questions.every(item => members.some(course => course.id === item.course_id)),
        'Invalid session context');
      return { mode: 'learning', courseId: tagged[1] === 'course' ? tagged[2] : null,
        moduleId: tagged[1] === 'module' ? tagged[2] : null };
    }
    // Legacy sessions have no scope metadata. Prefer the narrowest provable context.
    const courses = [...new Set(questions.map(item => item.course_id))];
    if (courses.length === 1) return { mode: 'learning', courseId: courses[0], moduleId: null };
    const modules = [...new Set(courses.map(id => bank.courses.find(course => course.id === id)?.lot))];
    requireThat(modules.every(Boolean), 'Unknown session course');
    return { mode: 'learning', courseId: null, moduleId: modules.length === 1 ? modules[0] : null };
  }

  function sessionDestination(bank, session) {
    const context = sessionContext(bank, session);
    if (context.courseId) {
      const course = bank.courses.find(item => item.id === context.courseId);
      requireThat(course, 'Unknown session course');
      return { href: `${course.href}#view-quiz`, label: `Quiz — ${course.title}` };
    }
    if (context.moduleId) return { href: `${context.moduleId}.html#view-quiz`,
      label: `Pratique — Module ${context.moduleId.slice(-2)}` };
    return { href: `assessment.html?mode=${context.mode}`,
      label: { diagnostic: 'Diagnostic', review: 'Réviser', simulation: 'Examen blanc',
        learning: 'Entraînement intercalé historique' }[context.mode] };
  }

  function publicQuestion(question) {
    // Active sessions never render facts, target links, correctness or rationale.
    return {
      id: question.id, topic: question.topic, format: question.format, response_control: responseControl(question),
      prompt_en: question.prompt_en, ...(question.code ? {
        code: question.code,
        code_language: question.code_language || question.execution?.language || 'text',
      } : {}),
      choices: question.choices.map(({ id, text_en }) => ({ id, text_en })),
    };
  }

  function summarize(bank, session) {
    requireThat(session.ended_at !== null, 'Finish the session before viewing corrections');
    const counts = { correct: 0, incorrect: 0, unknown: 0, unanswered: 0, answered: session.answers.length,
      total: session.question_ids.length };
    const domains = Object.fromEntries(bank.topics.map(topic => [topic, { correct: 0, incorrect: 0, unknown: 0, unanswered: 0 }]));
    const corrections = session.question_ids.map(key => {
      const question = bank.items.find(item => item.id === key);
      const answer = session.answers.find(item => item.question_id === key);
      const result = score(question, answer);
      counts[result.status]++;
      domains[question.topic][result.status]++;
      return { question, answer: answer || null, result };
    });
    return { counts, domains, corrections };
  }

  // Session facade composes a storage repository, a clock and a selection strategy.
  function createEngine({ bank, store, now = Date.now, random = Math.random, makeId = idFactory }) {
    function find(sessionId) {
      const session = store.snapshot().sessions.find(item => item.id === sessionId);
      requireThat(session, 'Unknown session');
      return session;
    }
    function finish(sessionId) {
      const session = find(sessionId);
      if (session.ended_at !== null) return session;
      const at = now();
      requireThat(at >= session.started_at, 'Clock moved before session start; check your device clock');
      const expired = session.deadline !== null && at >= session.deadline;
      session.ended_at = expired ? session.deadline : at;
      session.end_reason = expired ? 'expired' : 'finished';
      const attempts = session.answers.map(answer => ({
        ...answer, id: `${session.id}.${answer.question_id}`, mode: session.mode, session_id: session.id
      }));
      store.saveSession(session, attempts);
      return find(sessionId);
    }
    function tick(sessionId) {
      const session = find(sessionId);
      return session.ended_at === null && session.deadline !== null && now() >= session.deadline
        ? finish(sessionId) : session;
    }
    function start(mode, { courseId = null, moduleId = null } = {}) {
      requireThat(State.MODES.includes(mode), 'Unknown assessment mode');
      requireThat(mode === 'learning' || (courseId === null && moduleId === null),
        'Context filters are only available in learning mode');
      // Only resuming the proper context may expire a session and expose corrections.
      requireThat(!store.snapshot().sessions.some(session => session.ended_at === null),
        'Resume or finish the existing session first');
      const selectors = {
        diagnostic: () => selectDiagnostic(bank, random),
        simulation: () => selectSimulation(bank, random),
        review: () => selectReview(bank, store.snapshot(), now()),
        learning: () => selectLearning(bank, { courseId, moduleId }, random),
      };
      const questions = selectors[mode]();
      requireThat(questions.length, mode === 'review'
        ? 'No review is due yet. Use learning mode or return after the real delay.' : 'No eligible questions');
      const at = now();
      questions.forEach(responseControl);
      const prefix = courseId ? `course:${courseId}:` : moduleId ? `module:${moduleId}:` : '';
      const session = { id: prefix + makeId(), mode, question_ids: questions.map(question => question.id),
        started_at: at, deadline: mode === 'simulation' ? at + SIMULATION_MS : null,
        ended_at: null, end_reason: null, answers: [] };
      requireThat(!store.snapshot().sessions.some(item => item.id === session.id), 'Duplicate session ID');
      store.saveSession(session);
      return session;
    }
    function answer(sessionId, questionId, response) {
      const session = tick(sessionId);
      requireThat(session.ended_at === null, 'This session has ended');
      requireThat(session.question_ids.includes(questionId), 'Question is not part of this session');
      const existing = session.answers.find(entry => entry.question_id === questionId);
      requireThat(session.mode === 'simulation' || !existing, 'A verified answer cannot be changed');
      const control = responseControl(bank.items.find(item => item.id === questionId));
      requireThat(Array.isArray(response.selected) &&
        (control.type !== 'radio' || response.selected.length <= 1), 'Expected one choice');
      const at = now();
      requireThat(at >= session.started_at, 'Clock moved before session start; check your device clock');
      const entry = { question_id: questionId, selected: [...response.selected].sort(),
        unknown: response.unknown, confidence: response.confidence, at };
      session.answers = session.answers.filter(item => item.question_id !== questionId).concat([entry]);
      const attempts = session.mode === 'simulation' ? [] :
        [{ ...entry, id: `${session.id}.${questionId}`, mode: session.mode, session_id: session.id }];
      store.saveSession(session, attempts);
      return view(sessionId);
    }
    function view(sessionId) {
      const session = tick(sessionId);
      return { ...session,
        remaining_ms: session.deadline === null ? null : Math.max(0, session.deadline - now()),
        questions: session.question_ids.map(key => publicQuestion(bank.items.find(item => item.id === key))),
        can_correct: session.ended_at !== null
      };
    }
    function correction(sessionId, questionId) {
      const session = tick(sessionId);
      const response = session.answers.find(answer => answer.question_id === questionId);
      requireThat(session.question_ids.includes(questionId), 'Question is not part of this session');
      requireThat(session.ended_at !== null || (session.mode !== 'simulation' && response),
        'Correction is not available before verification/session end');
      const question = bank.items.find(item => item.id === questionId);
      return { question: clone(question), answer: response || null, result: score(question, response) };
    }
    return { start, answer, finish, tick, view, correction, results: sessionId => summarize(bank, tick(sessionId)) };
  }

  function element(document, tag, text, attributes = {}) {
    const node = document.createElement(tag);
    if (text !== null && text !== undefined) node.textContent = text;
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  }

  function renderCorrection(document, host, correction, bank) {
    const { question, answer, result } = correction;
    const labels = { correct: 'Ensemble exact', incorrect: 'Réponse incorrecte', unknown: 'Notion à revoir',
      unanswered: 'Non traitée — aucune tentative comptabilisée' };
    host.append(element(document, 'h3', labels[result.status], { lang: 'fr' }));
    if (answer) host.append(element(document, 'p', `Confidence: ${answer.confidence}`, { lang: 'en' }));
    if (result.correct && result.fragile) host.append(element(document, 'p',
      'Réussite devinée ou incertaine : repère fragile, pas une réussite différée.'));
    host.append(element(document, 'p', question.explanation_fr));
    const list = element(document, 'ul');
    for (const choice of question.choices) {
      const row = element(document, 'li');
      row.append(element(document, 'strong', `${choice.correct ? 'Correct' : 'Distractor'}: ${choice.text_en}`, { lang: 'en' }),
        element(document, 'p', choice.explanation_fr));
      list.append(row);
    }
    const course = bank?.courses.find(item => item.id === question.course_id);
    const outcome = course?.outcomes.find(item => item.href === question.target_href);
    host.append(list, element(document, 'h4', 'À revoir dans le cours', { lang: 'fr' }),
      element(document, 'a', outcome ? `${course.title} — ${outcome.text || outcome.heading}`
        : question.prompt_en, { href: question.target_href }));
  }

  async function mount(document, window, options = {}) {
    const rootNode = document.getElementById('assessment-app');
    if (!rootNode) return null;
    const errorNode = document.getElementById('assessment-error');
    let bank = options.bank;
    if (!bank) {
      const response = await window.fetch('assessment-bank.json');
      if (!response.ok) throw new Error(`Bank unavailable (${response.status})`);
      bank = await response.json();
    }
    const store = options.store || State.createStore({ bank, getStorage: () => window.localStorage });
    const warnings = options.store ? [] : store.migrateLegacy();
    if (warnings.length) errorNode.textContent = warnings.join(' ');
    const engine = createEngine({ bank, store });
    const parameters = new URLSearchParams(window.location.search);
    const modeSelect = document.getElementById('assessment-mode');
    const requested = options.local ? 'learning' : (parameters.get('mode') || 'review');
    requireThat(State.MODES.includes(requested), 'Session indisponible : choisissez Diagnostic, Révision ou un examen blanc.');
    requireThat(options.local || (!parameters.has('module') && !parameters.has('lot')),
      'Pour vous entraîner sur un module, ouvrez son Quiz depuis le parcours.');
    modeSelect.value = requested;
    modeSelect.hidden = true;
    const courseId = options.local ? options.courseId : parameters.get('course');
    requireThat(!courseId || requested === 'learning', 'Pour vous entraîner sur un cours, ouvrez son Quiz.');
    const moduleId = options.moduleId ?? null;
    const course = bank.courses.find(item => item.id === courseId);
    if (moduleId !== null) {
      selectLearning(bank, { moduleId });
    } else if (options.local || courseId !== null) {
      requireThat(course, 'Cours inconnu : aucun quiz chargé.');
      requireThat(bank.items.some(item => item.pool === 'learning' && item.course_id === courseId),
        'Aucune question d’entraînement disponible pour ce cours.');
    }
    const moduleCourses = new Set(bank.courses.filter(item => item.lot === moduleId).map(item => item.id));
    const inContext = item => moduleId !== null ? moduleCourses.has(item.course_id) : item.course_id === courseId;
    const scoped = options.local || courseId !== null;
    document.getElementById('training-scope').textContent = moduleId !== null
      ? `${options.moduleTitle} — questions de ce module uniquement (14 au maximum par session).`
      : course ? `Entraînement ciblé : ${course.title}. Questions de ce cours uniquement.`
        : { diagnostic: 'Diagnostic — repérez les notions à retravailler dans les 14 domaines.',
          review: 'Réviser — erreurs et rappels arrivés à échéance, sans examen blanc.',
          simulation: 'Examen blanc — 75 questions, 90 minutes. Corrections uniquement après la fin.',
          learning: 'Entraînement — révisez plusieurs cours avec une explication après chaque réponse.' }[requested];
    function renderPresentation() {
      if (options.local) return;
      const title = course ? `Entraînement — ${course.title}` : {
        simulation: 'Examen blanc Symfony 8.0', diagnostic: 'Diagnostic',
        review: 'Révision', learning: 'Entraînement',
      }[requested];
      const intro = {
        simulation: 'Answer 75 questions in 90 minutes. Select one answer or select all correct answers, as indicated. Corrections are available only after the session ends or time expires.',
        diagnostic: 'Identify topics to revisit across the 14 domains. Select one answer or all correct answers, as indicated, then check the French explanation.',
        review: 'Revisit your mistakes and questions due for review. Select one answer or all correct answers, as indicated, then check the French explanation.',
        learning: 'Practise the course topics. Select one answer or all correct answers, as indicated, then check the French explanation.',
      }[requested];
      document.title = title;
      const heading = document.getElementById('assessment-title');
      const introduction = document.getElementById('assessment-intro');
      if (heading) heading.textContent = title;
      if (introduction) introduction.textContent = intro;
    }
    let activeId = null;
    let position = 0;
    let interval = null;
    const timer = document.getElementById('assessment-timer');
    const navigation = document.getElementById('session-navigation');
    const progress = document.getElementById('session-progress');
    const startButton = document.getElementById('start-assessment');
    const finishButton = document.getElementById('finish-assessment');
    const belongsToContext = session => {
      const context = sessionContext(bank, session);
      return context.mode === requested && context.courseId === (courseId ?? null) &&
        context.moduleId === moduleId;
    };
    let updating = false;

    function safe(action) {
      return () => {
        errorNode.textContent = '';
        try { updating = true; action(); } catch (error) { errorNode.textContent = error.message; }
        finally { updating = false; }
      };
    }
    function focus() { rootNode.focus(); }
    function stopTimer() { if (interval !== null) window.clearInterval(interval); interval = null; }
    function updateTimer() {
      if (!activeId) return;
      const session = engine.view(activeId);
      timer.hidden = session.remaining_ms === null;
      if (session.remaining_ms !== null) {
        const seconds = Math.ceil(session.remaining_ms / 1000);
        timer.textContent = session.can_correct ? 'Session ended.' :
          `Time remaining: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      }
      if (session.can_correct) { stopTimer(); render(); }
    }
    function renderSummary() {
      const summary = engine.results(activeId);
      const counts = summary.counts;
      rootNode.append(element(document, 'h2', 'Session ended — corrections available', { lang: 'en' }));
      rootNode.append(element(document, 'p',
        `${counts.correct} correct · ${counts.incorrect} incorrect · ${counts.unknown} unknown · ${counts.unanswered} unanswered / ${counts.total}.`,
        { lang: 'en' }));
      rootNode.append(element(document, 'p', 'Ces comptes décrivent cette session, sans seuil officiel, prédiction de score ou mesure de préparation.'));
      const domains = element(document, 'ul');
      for (const [topic, count] of Object.entries(summary.domains)) {
        domains.append(element(document, 'li',
          `${topic}: ${count.correct} correct, ${count.incorrect} incorrect, ${count.unknown} unknown, ${count.unanswered} unanswered.`,
          { lang: 'en' }));
      }
      rootNode.append(domains);
      for (const correction of summary.corrections) {
        const details = element(document, 'details');
        details.append(element(document, 'summary', correction.question.prompt_en, { lang: 'en' }));
        if (correction.question.code) details.append(element(document, 'pre', correction.question.code, {
          lang: 'en', 'data-language': publicQuestion(correction.question).code_language,
        }));
        renderCorrection(document, details, correction, bank);
        rootNode.append(details);
      }
      const another = store.snapshot().sessions.find(session => session.ended_at === null);
      if (another && belongsToContext(another)) {
        const resumeButton = element(document, 'button', 'Resume another imported active session', { type: 'button', lang: 'en' });
        resumeButton.addEventListener('click', safe(() => { resume(); focus(); }));
        rootNode.append(resumeButton);
      }
      renderProgress();
    }
    function renderProgress() {
      const host = document.getElementById('learning-overview');
      host.replaceChildren();
      const rows = courseProgress(bank, store.snapshot()).filter(row => !scoped || inContext(row));
      host.append(element(document, 'p',
        `${rows.filter(row => row.read).length} cours lus · ${rows.filter(row => row.immediate).length} réussites immédiates · ${rows.filter(row => row.delayed).length} réussites différées sur un autre fait/question · ${rows.filter(row => row.fragile).length} repères fragiles.`));
      const list = element(document, 'ul');
      for (const row of rows.filter(item => item.attempt_count)) {
        const course = bank.courses.find(item => item.id === row.course_id);
        const label = row.delayed ? 'réussite différée observée' : row.immediate ? 'réussite immédiate seulement' : 'à reprendre';
        list.append(element(document, 'li', `${course.topic} — ${course.title} : ${label} ; ${row.error_count} erreur(s) conservée(s)` +
          (row.due_at === null ? '.' : ` ; révision à partir du ${new Date(row.due_at).toLocaleString('fr-FR')}.`)));
      }
      host.append(list);
    }
    function render() {
      renderPresentation();
      rootNode.replaceChildren();
      navigation.replaceChildren();
      const foreign = store.snapshot().sessions.filter(session => session.ended_at === null && !belongsToContext(session));
      for (const session of foreign) {
        const destination = sessionDestination(bank, session);
        const notice = element(document, 'div', null, { role: 'status' });
        notice.append(element(document, 'p',
          'Une autre session est en cours. Reprenez-la et terminez-la avant de démarrer ici ; aucune réponse ne sera écrasée.'),
        element(document, 'a', `Reprendre : ${destination.label}`, { href: destination.href }));
        rootNode.append(notice);
      }
      if (!activeId) {
        rootNode.append(element(document, 'p', 'Start this session when ready. The exam timer starts only when you start an exam.', { lang: 'en' }));
        finishButton.hidden = true; startButton.disabled = false;
        progress.textContent = ''; timer.hidden = true;
        renderProgress();
        return;
      }
      const session = engine.view(activeId);
      startButton.disabled = !session.can_correct;
      finishButton.hidden = session.can_correct;
      if (session.can_correct) {
        stopTimer(); progress.textContent = '';
        timer.hidden = session.mode !== 'simulation';
        timer.textContent = 'Session ended.';
        renderSummary(); return;
      }
      position = Math.min(position, session.questions.length - 1);
      const question = session.questions[position];
      const saved = session.answers.find(item => item.question_id === question.id);
      progress.textContent = `Question ${position + 1} / ${session.questions.length} · ${session.answers.length} recorded.`;
      rootNode.append(element(document, 'h2', question.topic, { lang: 'en' }));
      const form = element(document, 'form');
      const fieldset = element(document, 'fieldset');
      fieldset.append(element(document, 'legend', question.prompt_en, { lang: 'en' }));
      fieldset.append(element(document, 'p', question.response_control.instruction, { lang: 'en' }));
      if (question.code) fieldset.append(element(document, 'pre', question.code, {
        lang: 'en', 'data-language': question.code_language,
      }));
      const inputs = [];
      for (const choice of question.choices) {
        const label = element(document, 'label', null, { class: 'answer-choice', lang: 'en' });
        const input = element(document, 'input', null, { type: question.response_control.type,
          name: 'answer', value: choice.id });
        input.checked = saved?.selected.includes(choice.id) || false;
        inputs.push(input);
        label.append(input, document.createTextNode(' ' + choice.text_en)); fieldset.append(label);
      }
      const unknownLabel = element(document, 'label', null, { class: 'answer-choice', lang: 'en' });
      const unknown = element(document, 'input', null, { type: 'checkbox', name: 'unknown' });
      unknown.checked = saved?.unknown || false;
      unknownLabel.append(unknown, document.createTextNode(" I don't know"));
      fieldset.append(unknownLabel);
      unknown.addEventListener('change', () => { if (unknown.checked) inputs.forEach(input => { input.checked = false; }); });
      inputs.forEach(input => input.addEventListener('change', () => { if (input.checked) unknown.checked = false; }));
      const confidenceLabel = element(document, 'label', 'Confidence ', { lang: 'en' });
      const confidence = element(document, 'select', null, { name: 'confidence', required: '' });
      confidence.append(element(document, 'option', 'Choose confidence', { value: '' }));
      for (const value of State.CONFIDENCES) confidence.append(element(document, 'option', value, { value }));
      confidence.value = saved?.confidence || '';
      confidenceLabel.append(confidence); fieldset.append(confidenceLabel);
      const submit = element(document, 'button', session.mode === 'simulation' ? 'Save answer' : 'Verify / see explained solution',
        { type: 'submit', lang: 'en' });
      fieldset.append(submit);
      if (saved && session.mode !== 'simulation') fieldset.disabled = true;
      form.append(fieldset);
      form.addEventListener('submit', event => {
        event.preventDefault();
        safe(() => {
          engine.answer(activeId, question.id, { selected: inputs.filter(input => input.checked).map(input => input.value),
            unknown: unknown.checked, confidence: confidence.value });
          render(); focus();
        })();
      });
      rootNode.append(form);
      if (saved && session.mode !== 'simulation') renderCorrection(document, rootNode, engine.correction(activeId, question.id), bank);
      for (const [text, offset] of [['Previous question', -1], ['Next question', 1]]) {
        const button = element(document, 'button', text, { type: 'button', lang: 'en' });
        button.disabled = position + offset < 0 || position + offset >= session.questions.length;
        button.addEventListener('click', safe(() => { position += offset; render(); focus(); }));
        navigation.append(button);
      }
      renderProgress();
    }
    function resume() {
      stopTimer();
      const sessions = store.snapshot().sessions.filter(belongsToContext);
      sessions.filter(session => session.ended_at === null).forEach(session => engine.tick(session.id));
      const pending = store.snapshot().sessions.filter(session => belongsToContext(session) && session.ended_at === null);
      const hasForeign = store.snapshot().sessions.some(session => session.ended_at === null && !belongsToContext(session));
      const latest = pending.sort((a, b) => b.started_at - a.started_at)[0] ||
        (!hasForeign && store.snapshot().sessions.filter(belongsToContext).sort((a, b) => b.started_at - a.started_at)[0]);
      activeId = latest?.id || null;
      position = latest ? Math.max(0, latest.question_ids.findIndex(key => !latest.answers.some(answer => answer.question_id === key))) : 0;
      render();
      if (latest?.mode === 'simulation' && latest.ended_at === null) {
        updateTimer();
        interval = window.setInterval(safe(updateTimer), 1000);
      }
    }
    if (!options.local) State.mountTransfer(document, store, resume);
    startButton.addEventListener('click', safe(() => {
      const mode = requested;
      const session = engine.start(mode, {
        courseId: mode === 'learning' ? (courseId ?? null) : null,
        moduleId: mode === 'learning' ? moduleId : null,
      });
      activeId = session.id; position = 0; render(); focus();
      stopTimer();
      if (session.mode === 'simulation') { updateTimer(); interval = window.setInterval(safe(updateTimer), 1000); }
    }));
    finishButton.addEventListener('click', safe(() => {
      if (!window.confirm('End this session now? Unanswered questions stay unanswered. Corrections will become available.')) return;
      engine.finish(activeId); stopTimer(); render(); focus();
    }));
    window.addEventListener('pagehide', stopTimer);
    window.addEventListener('pageshow', () => {
      renderPresentation();
      if (activeId) {
        stopTimer(); updateTimer();
        const session = engine.view(activeId);
        if (!session.can_correct && session.mode === 'simulation') interval = window.setInterval(safe(updateTimer), 1000);
      }
    });
    resume();
    if (options.local) {
      let sessions = JSON.stringify(store.snapshot().sessions);
      store.subscribe(() => {
        const next = JSON.stringify(store.snapshot().sessions);
        const changed = next !== sessions;
        sessions = next;
        if (changed && !updating) safe(resume)();
        else renderProgress();
      });
    }
    document.getElementById('assessment-controls').hidden = false;
    return { bank, store, engine };
  }

  function mountContext(document, window, options) {
    // Adapter: scope the existing UI, while sharing its engine and repository.
    const scopedDocument = {
      getElementById: id => document.getElementById(`course-quiz-${id}`),
      createElement: tag => document.createElement(tag),
      createTextNode: text => document.createTextNode(text),
      body: document.body,
    };
    return mount(scopedDocument, window, { ...options, local: true });
  }

  const mountCourse = (document, window, options) => mountContext(document, window, options);
  const mountModule = (document, window, options) => mountContext(document, window, options);

  const api = { DELAY_MS, ERROR_DELAY_MS, SIMULATION_MS, score, shuffled, interleave, selectDiagnostic,
    selectLearning, selectSimulation, selectReview, courseProgress, responseControl, sessionContext, sessionDestination,
    publicQuestion, summarize, createEngine, renderCorrection, mount, mountCourse, mountModule };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.Assessment = api;
    if (root.document?.getElementById('assessment-app')) mount(root.document, root).catch(error => {
      root.document.getElementById('assessment-error').textContent =
        `Assessment unavailable: ${error.message}. Native course links remain usable.`;
    });
  }
}(typeof globalThis === 'undefined' ? this : globalThis));
