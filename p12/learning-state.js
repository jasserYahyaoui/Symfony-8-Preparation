(function (root) {
  'use strict';

  const STORAGE_KEY = 's8-learning-state-v1';
  const MAX_BYTES = 4 * 1024 * 1024;
  const LIMITS = Object.freeze({ attempts: 5000, reads: 1000 });
  const GUIDE_STEPS = Object.freeze(['lecture', 'client', 'rappel-2', 'redirections', 'succes',
    'rappel-4', 'formats', 'autres', 'serveur', 'symfony', 'pieges', 'fiche']);
  const CONFIDENCES = Object.freeze(['unsure', 'guess', 'confident']);
  const MODES = Object.freeze(['diagnostic', 'learning', 'review', 'simulation']);
  const LEGACY_REVISION = 'legacy-v1';
  const clone = value => JSON.parse(JSON.stringify(value));
  const fail = message => { throw new TypeError(message); };
  const check = (condition, message) => { if (!condition) fail(message); };
  const stamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
  const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value);
  const bytes = text => new TextEncoder().encode(text).length;
  function releaseConfig(document) {
    const data = document.documentElement?.dataset || {};
    if (!data.releaseId) return null;
    check(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(data.releaseId) &&
      typeof data.assessmentBankUrl === 'string' && data.assessmentBankUrl.length > 0 &&
      /^[0-9a-f]{64}$/.test(data.assessmentBankSha256 || ''),
    'Versioned assessment assets are incomplete.');
    return { id: data.releaseId, bankUrl: data.assessmentBankUrl,
      bankSha256: data.assessmentBankSha256 };
  }
  async function loadBank(document, window, provided = null) {
    const release = releaseConfig(document);
    if (release) check(RELEASE_ID === release.id,
      'Assessment assets belong to different releases; reload the page.');
    if (provided) return provided;
    const response = await window.fetch(release?.bankUrl || 'assessment-bank.json');
    if (!response.ok) throw new Error(`Bank unavailable (${response.status})`);
    if (!release) return response.json();
    check(typeof response.arrayBuffer === 'function' && window.crypto?.subtle,
      'Versioned bank verification is unavailable.');
    const raw = new Uint8Array(await response.arrayBuffer());
    const digest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', raw));
    const hash = [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
    check(hash === release.bankSha256, 'Assessment bank belongs to a different release.');
    return JSON.parse(new TextDecoder().decode(raw));
  }
  const canonical = value => JSON.stringify(value, (key, entry) =>
    entry && !Array.isArray(entry) && typeof entry === 'object'
      ? Object.fromEntries(Object.keys(entry).sort().map(name => [name, entry[name]])) : entry);
  const capacityMessage = kind =>
    `${kind} exceeds the 4 MiB safety limit; export a compact backup or archive older data before retrying.`;

  function shape(value, keys) {
    check(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
    check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
      'Unexpected object prototype');
    check(Object.keys(value).sort().join('|') === [...keys].sort().join('|'), 'Unexpected or missing fields');
  }

  function list(value, limit, key = entry => entry) {
    check(Array.isArray(value) && (limit === null || value.length <= limit), 'Collection exceeds its bound');
    check(new Set(value.map(key)).size === value.length, 'Duplicate identifiers');
  }

  function emptyState() {
    return { version: 1, reads: [], guide: null, attempts: [], sessions: [], jourj: null };
  }

  // A small repository facade: storage and the canonical catalogue are injected,
  // so persistence failures never prevent an in-memory/manual-backup workflow.
  function createValidator(bank, exams = null) {
    const questions = new Map(bank.items.map(question => [question.id, question]));
    const revisions = question => {
      const accepted = [LEGACY_REVISION, question.contract_revision,
        ...(question.contract_revision ? ['p8-security-core-boundary-v1', 'p9-security-core-boundary-v1'] : [])];
      const match = typeof question.contract_revision === 'string' &&
        question.contract_revision.match(/^(.*)-v([2-9][0-9]*)$/);
      if (match) {
        for (let version = Number(match[2]) - 1; version >= 1; version--) {
          accepted.push(`${match[1]}-v${version}`);
        }
      }
      return new Set(accepted.filter(Boolean));
    };
    const topics = new Set(bank.topics);
    const cards = new Set(bank.jour_j.map(card => card.id));
    const hrefs = new Set(bank.courses.flatMap(course => [course.href, ...course.outcomes.map(outcome => outcome.href)]));
    function answer(value, questionRevision = undefined) {
      const fields = Object.hasOwn(value, 'question_revision')
        ? ['question_id', 'selected', 'unknown', 'confidence', 'at', 'question_revision']
        : ['question_id', 'selected', 'unknown', 'confidence', 'at'];
      shape(value, fields);
      const question = questions.get(value.question_id);
      check(question, 'Unknown question');
      list(value.selected, question.choices.length);
      check(value.selected.every(choice => question.choices.some(item => item.id === choice)), 'Unknown choice');
      check(typeof value.unknown === 'boolean' && CONFIDENCES.includes(value.confidence) && stamp(value.at),
        'Invalid answer metadata');
      if (Object.hasOwn(value, 'question_revision')) {
        check(typeof value.question_revision === 'string' &&
          /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value.question_revision),
        'Invalid question revision');
        check(revisions(question).has(value.question_revision), 'Unknown question revision');
        check(questionRevision === undefined || value.question_revision === questionRevision,
          'Question revision does not match the session contract');
      }
      check(questionRevision === undefined || questionRevision === null ||
        Object.hasOwn(value, 'question_revision') && value.question_revision === questionRevision,
      'Missing question revision for session contract');
      check(value.unknown ? value.selected.length === 0 : value.selected.length > 0, 'Unknown/selection mismatch');
      check(question.format === 'multiple' || value.selected.length <= 1, 'Expected one choice');
      return question;
    }
    function session(value) {
      const fixed = Object.hasOwn(value, 'exam_id') || Object.hasOwn(value, 'exam_version');
      shape(value, ['id', 'mode', 'question_ids', 'started_at', 'deadline', 'ended_at', 'end_reason', 'answers',
        ...(fixed ? ['exam_id', 'exam_version'] : []),
        ...(Object.hasOwn(value, 'question_revisions') ? ['question_revisions'] : [])]);
      if (fixed) {
        check(exams, 'Fixed exam catalogue unavailable');
        exams.validateSession(value);
      }
      check(id(value.id) && MODES.includes(value.mode) && stamp(value.started_at), 'Invalid session');
      list(value.question_ids, 75);
      check(value.question_ids.length > 0, 'Empty session');
      const pool = value.mode === 'simulation' ? 'validation' : 'learning';
      check(value.question_ids.every(key => questions.get(key)?.pool === pool), 'Invalid session pool');
      check(value.question_ids.every(key => id(`${value.id}.${key}`)), 'Session ID leaves no room for attempt IDs');
      if (value.mode === 'simulation') {
        check(value.question_ids.length === 75 && stamp(value.deadline) &&
          value.deadline === value.started_at + 5400000,
          'Simulation requires 75 questions and 90 minutes');
      } else {
        check(value.deadline === null, 'Only simulation has a deadline');
      }
      if (value.mode === 'diagnostic') {
        check(value.question_ids.length === topics.size &&
          new Set(value.question_ids.map(key => questions.get(key).topic)).size === topics.size,
        'Diagnostic must represent every domain');
      }
      check(value.ended_at === null
        ? value.end_reason === null
        : stamp(value.ended_at) && value.ended_at >= value.started_at &&
          ['finished', 'expired'].includes(value.end_reason), 'Invalid session ending');
      if (value.end_reason === 'expired') {
        check(value.mode === 'simulation' && value.ended_at === value.deadline, 'Invalid expiry');
      }
      if (value.deadline !== null && value.ended_at !== null) {
        check(value.ended_at <= value.deadline, 'Ending exceeds deadline');
      }
      list(value.answers, 75, item => item.question_id);
      let sessionRevisions = null;
      if (Object.hasOwn(value, 'question_revisions')) {
        sessionRevisions = new Map();
        list(value.question_revisions, 75, entry => entry.question_id);
        for (const entry of value.question_revisions) {
          shape(entry, ['question_id', 'revision']);
          check(value.question_ids.includes(entry.question_id), 'Unknown session contract question');
          check(entry.revision === null || (typeof entry.revision === 'string' &&
            /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(entry.revision) &&
            revisions(questions.get(entry.question_id)).has(entry.revision)),
          'Invalid session contract revision');
          sessionRevisions.set(entry.question_id, entry.revision);
        }
        check(sessionRevisions.size === value.question_ids.length, 'Incomplete session contract');
      }
      for (const entry of value.answers) {
        check(sessionRevisions || !Object.hasOwn(entry, 'question_revision'),
          'Unbound question revision');
        answer(entry, sessionRevisions?.get(entry.question_id));
        check(value.question_ids.includes(entry.question_id) && entry.at >= value.started_at &&
          (value.ended_at === null || entry.at <= value.ended_at) &&
          (value.deadline === null || entry.at < value.deadline), 'Answer outside session');
      }
    }
    function jourj(value) {
      shape(value, ['order', 'visited', 'flagged', 'checkpoint', 'weak_ids', 'weak_visited', 'at']);
      list(value.order, topics.size);
      check(value.order.length === topics.size && value.order.every(topic => topics.has(topic)), 'Incomplete Jour J sweep');
      list(value.visited, topics.size, entry => entry.topic);
      for (const entry of value.visited) {
        shape(entry, ['topic', 'rating', 'at']);
        check(topics.has(entry.topic) && ['clear', 'review'].includes(entry.rating) && stamp(entry.at), 'Invalid visit');
      }
      list(value.flagged, cards.size, entry => entry.card_id);
      for (const entry of value.flagged) {
        shape(entry, ['card_id', 'flagged', 'at']);
        check(cards.has(entry.card_id) && typeof entry.flagged === 'boolean' && stamp(entry.at), 'Invalid flag');
      }
      list(value.weak_ids, 6);
      list(value.weak_visited, 6);
      check(value.weak_ids.every(key => cards.has(key)) &&
        value.weak_visited.every(key => value.weak_ids.includes(key)), 'Invalid weak segment');
      check([...topics, 'weak', 'checklist'].includes(value.checkpoint) && stamp(value.at), 'Invalid checkpoint');
      if (['weak', 'checklist'].includes(value.checkpoint)) {
        check(value.visited.length === topics.size, 'Finish all 14 domains before the final segment');
      }
      if (value.checkpoint === 'weak') {
        check(value.weak_ids.length > value.weak_visited.length, 'Weak segment has no remaining card');
      }
      if (value.checkpoint === 'checklist') {
        check(value.weak_visited.length === value.weak_ids.length, 'Finish the bounded weak segment first');
      }
      check(value.visited.every(entry => entry.at <= value.at) &&
        value.flagged.every(entry => entry.at <= value.at), 'Invalid Jour J chronology');
    }
    function validate(value) {
      shape(value, ['version', 'reads', 'guide', 'attempts', 'sessions', 'jourj']);
      check(value.version === 1, 'Unsupported progress version');
      list(value.reads, LIMITS.reads, entry => entry.href);
      for (const entry of value.reads) {
        shape(entry, ['href', 'at']);
        check(hrefs.has(entry.href) && stamp(entry.at), 'Unknown reading location');
      }
      if (value.guide !== null) {
        shape(value.guide, ['step', 'at']);
        check(GUIDE_STEPS.includes(value.guide.step) && stamp(value.guide.at), 'Invalid guide checkpoint');
      }
      list(value.sessions, null, entry => entry.id);
      value.sessions.forEach(session);
      list(value.attempts, LIMITS.attempts, entry => entry.id);
      for (const entry of value.attempts) {
        shape(entry, ['id', 'question_id', 'selected', 'unknown', 'confidence', 'at', 'mode', 'session_id',
          ...(Object.hasOwn(entry, 'question_revision') ? ['question_revision'] : [])]);
        const { id: attemptId, mode, session_id: sessionId, ...response } = entry;
        const question = answer(response);
        check(id(attemptId) && id(sessionId) && MODES.includes(mode), 'Invalid attempt');
        check(question.pool === (mode === 'simulation' ? 'validation' : 'learning'), 'Attempt pool mismatch');
        const related = value.sessions.find(item => item.id === sessionId);
        if (related) {
          check(related.mode === mode && related.question_ids.includes(question.id) &&
            entry.at >= related.started_at && (related.ended_at === null || entry.at <= related.ended_at) &&
            (mode !== 'simulation' || related.ended_at !== null), 'Attempt contradicts session');
          const recorded = related.answers.find(item => item.question_id === question.id);
          check(recorded && canonical(recorded) === canonical(response), 'Attempt contradicts recorded answer');
        }
      }
      if (value.jourj !== null) jourj(value.jourj);
      check(bytes(JSON.stringify(value)) <= MAX_BYTES, capacityMessage('Progress'));
      return clone(value);
    }
    return { validate, hrefs };
  }

  function parseImport(text, validate) {
    check(typeof text === 'string' && bytes(text) <= MAX_BYTES, capacityMessage('Import file'));
    return validate(JSON.parse(text, (key, value) => {
      check(!['__proto__', 'prototype', 'constructor'].includes(key), 'Forbidden object key');
      return value;
    }));
  }

  function latest(left, right) {
    if (!left) return right;
    if (!right) return left;
    return (left.at || 0) > (right.at || 0) ? left :
      (left.at || 0) < (right.at || 0) ? right : canonical(left) >= canonical(right) ? left : right;
  }

  function union(left, right, key, resolve = latest) {
    const result = new Map(left.map(entry => [key(entry), entry]));
    for (const entry of right) result.set(key(entry), result.has(key(entry)) ? resolve(result.get(key(entry)), entry) : entry);
    return [...result.values()].sort((a, b) => String(key(a)).localeCompare(String(key(b)), 'en'));
  }

  function mergeStates(left, right, validate) {
    function mergeAttempt(a, b) {
      const aRevision = Object.hasOwn(a, 'question_revision');
      const bRevision = Object.hasOwn(b, 'question_revision');
      if (aRevision !== bRevision || (aRevision && a.question_revision !== b.question_revision)) {
        const historical = latest(a, b);
        const { question_revision, ...withoutRevision } = historical;
        return withoutRevision;
      }
      return latest(a, b);
    }

    function mergeSession(a, b) {
      check(a.mode === b.mode && a.started_at === b.started_at && a.deadline === b.deadline &&
        a.exam_id === b.exam_id && a.exam_version === b.exam_version &&
        canonical(a.question_ids) === canonical(b.question_ids) &&
        (!a.question_revisions || !b.question_revisions ||
          canonical(a.question_revisions) === canonical(b.question_revisions)), 'Conflicting session identity');
      const ended = [a, b].filter(item => item.ended_at !== null)
        .sort((x, y) => x.ended_at - y.ended_at || canonical(x).localeCompare(canonical(y), 'en'))[0];
      const explicitContract = Array.isArray(a.question_revisions) && Array.isArray(b.question_revisions);
      const merged = { ...a, ended_at: ended?.ended_at ?? null, end_reason: ended?.end_reason ?? null,
        answers: union(a.answers, b.answers, entry => entry.question_id) };
      if (explicitContract) merged.question_revisions = a.question_revisions;
      else {
        delete merged.question_revisions;
        merged.answers = merged.answers.map(answer => {
          const { question_revision, ...historical } = answer;
          return historical;
        });
      }
      // An earlier explicit finish wins: later offline answers cannot reopen it.
      if (ended) merged.answers = merged.answers.filter(entry => entry.at <= ended.ended_at);
      return merged;
    }
    let jourj = latest(left.jourj, right.jourj);
    if (left.jourj && right.jourj) {
      jourj = { ...jourj,
        visited: union(left.jourj.visited, right.jourj.visited, entry => entry.topic),
        flagged: union(left.jourj.flagged, right.jourj.flagged, entry => entry.card_id),
        weak_visited: [...new Set([...left.jourj.weak_visited, ...right.jourj.weak_visited])]
          .filter(key => jourj.weak_ids.includes(key)).sort()
      };
    }
    const sessions = union(left.sessions, right.sessions, entry => entry.id, mergeSession);
    const unknownOriginSessionIds = new Set(sessions
      .filter(session => !Array.isArray(session.question_revisions)).map(session => session.id));
    const attempts = union(left.attempts, right.attempts, entry => entry.id, mergeAttempt)
      .map(attempt => {
        if (!unknownOriginSessionIds.has(attempt.session_id)) return attempt;
        const { question_revision, ...historical } = attempt;
        return historical;
      });
    return validate({
      version: 1, reads: union(left.reads, right.reads, entry => entry.href),
      guide: latest(left.guide, right.guide),
      attempts,
      sessions,
      jourj
    });
  }

  function createStore({ bank, exams = null, getStorage = () => root.localStorage, now = Date.now, onStatus = () => {} }) {
    const { validate, hrefs } = createValidator(bank, exams);
    let state = emptyState();
    let storage = null;
    let persistence = 'memory';
    const listeners = new Set();
    const messages = {
      ready: 'Progression locale prête. Aucune synchronisation automatique.',
      saved: 'Progression enregistrée sur cet appareil.',
      unavailable: 'Progression non enregistrée : stockage indisponible ou écriture refusée. Export manuel possible depuis la mémoire.',
      corrupt: 'Progression non enregistrée : données locales corrompues, conservées sans écrasement. Export manuel possible depuis la mémoire.'
    };
    function status() { return { persistence, message: messages[persistence] }; }
    function notify() {
      onStatus(status());
      for (const listener of listeners) listener(status());
    }
    try {
      storage = getStorage();
      check(storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function', 'Storage unavailable');
      persistence = 'ready';
      const text = storage.getItem(STORAGE_KEY);
      if (text !== null) {
        try { state = parseImport(text, validate); persistence = 'saved'; }
        catch { persistence = 'corrupt'; storage = null; }
      }
    } catch { persistence = 'unavailable'; storage = null; }

    function commit(candidate) {
      let next = validate(candidate);
      if (storage) {
        try {
          // Merge with another tab before writing; never overwrite newly corrupt data.
          const current = storage.getItem(STORAGE_KEY);
          if (current !== null) {
            try { next = mergeStates(next, parseImport(current, validate), validate); }
            catch { persistence = 'corrupt'; storage = null; }
          }
          if (storage) { storage.setItem(STORAGE_KEY, JSON.stringify(next)); persistence = 'saved'; }
        } catch { persistence = 'unavailable'; storage = null; }
      }
      state = next;
      notify();
      return clone(state);
    }
    function refresh() {
      if (!storage) return clone(state);
      try {
        const current = storage.getItem(STORAGE_KEY);
        if (current !== null) {
          state = mergeStates(state, parseImport(current, validate), validate);
          persistence = 'saved';
          notify();
        }
      } catch {
        persistence = 'corrupt';
        storage = null;
        notify();
      }
      return clone(state);
    }
    function update(mutator) {
      const next = clone(state);
      mutator(next);
      return commit(next);
    }
    function importJSON(text) {
      // Both parsing and the complete merge succeed before any state or disk mutation.
      const incoming = parseImport(text, validate);
      return commit(mergeStates(state, incoming, validate));
    }
    function markRead(href, at = now()) {
      return update(next => { next.reads = union(next.reads, [{ href, at }], entry => entry.href); });
    }
    function visitGuide(step, at = now()) {
      return update(next => { next.guide = latest(next.guide, { step, at }); });
    }
    function recordAttempt(attempt) {
      return update(next => { next.attempts = union(next.attempts, [attempt], entry => entry.id); });
    }
    function saveSession(session, attempts = []) {
      return update(next => {
        next.sessions = next.sessions.filter(entry => entry.id !== session.id).concat([session]);
        next.attempts = union(next.attempts, attempts, entry => entry.id);
      });
    }
    function saveJourJ(jourj) { return update(next => { next.jourj = jourj; }); }
    function exportJSON() {
      const compact = JSON.stringify(state);
      const pretty = JSON.stringify(state, null, 2);
      return bytes(pretty) <= MAX_BYTES ? pretty : compact;
    }

    // Adapter for the two existing local keys; originals remain untouched.
    function migrateLegacy(getLegacyStorage = getStorage) {
      const next = clone(state);
      const warnings = [];
      try {
        const legacy = getLegacyStorage();
        const guide = legacy.getItem('s8-http-guide-v1');
        if (guide !== null) {
          const step = JSON.parse(guide);
          check(GUIDE_STEPS.includes(step), 'Invalid legacy guide');
          if (!next.guide) next.guide = { step, at: 0 };
        }
        const reading = legacy.getItem('s8-reading-v1');
        if (reading !== null) {
          const data = JSON.parse(reading);
          shape(data, ['version', 'last', 'visited']);
          check(data.version === 1 && Array.isArray(data.visited) && data.visited.length <= LIMITS.reads,
            'Invalid legacy reading');
          for (const href of data.visited) {
            if (hrefs.has(href)) next.reads = union(next.reads, [{ href, at: 0 }], entry => entry.href);
            else warnings.push('Ancien repère hors du catalogue canonique non importé.');
          }
        }
        commit(next);
      } catch {
        warnings.push('Migration des anciens repères impossible ; anciennes données conservées.');
      }
      return warnings;
    }
    notify();
    return {
      snapshot: () => clone(state), status, markRead, visitGuide, recordAttempt, saveSession, saveJourJ,
      refresh, importJSON, exportJSON, migrateLegacy,
      subscribe(listener) { listeners.add(listener); listener(status()); return () => listeners.delete(listener); }
    };
  }

  function mountTransfer(document, store, afterImport = () => {},
    approveImport = () => typeof root.confirm !== 'function' ||
      root.confirm('Fusionner ce fichier avec votre progression locale, sans la remplacer ?')) {
    const status = document.getElementById('persistence-status');
    const message = document.getElementById('transfer-status');
    store.subscribe(value => { if (status) status.textContent = value.message; });
    document.getElementById('export-progress')?.addEventListener('click', () => {
      try {
        const url = URL.createObjectURL(new Blob([store.exportJSON()], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url; link.download = 'symfony-learning-state-v1.json';
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        message.textContent = 'Export manuel créé depuis la progression en mémoire. Conservez ce fichier personnel.';
      } catch (error) {
        message.textContent = `Export impossible : ${error.message}. La progression reste en mémoire.`;
      }
    });
    document.getElementById('import-progress')?.addEventListener('change', async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        check(file.size <= MAX_BYTES, 'File exceeds 4 MiB');
        const text = await file.text();
        if (!approveImport()) {
          message.textContent = 'Import annulé ; progression inchangée.';
          event.target.value = '';
          return;
        }
        store.importJSON(text);
        message.textContent = 'Import fusionné ; les tentatives identiques ne sont pas comptées deux fois.';
      } catch (error) {
        message.textContent = `Import refusé, progression conservée : ${error.message}`;
        event.target.value = '';
        return;
      }
      try { afterImport(); }
      catch (error) {
        message.textContent = `Import fusionné, mais affichage à reprendre : ${error.message}`;
      }
      event.target.value = '';
    });
  }

  const RELEASE_ID = root.S8_RELEASE?.id ?? root.document?.documentElement?.dataset?.releaseId ?? null;
  const api = { RELEASE_ID, releaseConfig, loadBank, STORAGE_KEY, MAX_BYTES, LIMITS, GUIDE_STEPS, CONFIDENCES, MODES,
    emptyState, createValidator, parseImport, mergeStates, createStore, mountTransfer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LearningState = api;
}(typeof globalThis === 'undefined' ? this : globalThis));
