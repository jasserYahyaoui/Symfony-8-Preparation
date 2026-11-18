(function (root) {
  'use strict';
  const check = (condition, message) => { if (!condition) throw new RangeError(message); };
  const clone = value => JSON.parse(JSON.stringify(value));
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

  // The catalogue is supplied explicitly; this contract does not choose quotas or questions.
  function createCatalog(manifest, bank) {
    check(manifest?.schema_version === 1 && Array.isArray(manifest.exams), 'Invalid exam catalogue');
    const questions = new Map(bank.items.map(question => [question.id, question]));
    const definitions = clone(manifest.exams);
    const historical = manifest.historical_exams === undefined ? [] : clone(manifest.historical_exams);
    check(Array.isArray(historical), 'Invalid historical exam catalogue');
    function validateExam(exam) {
      check(/^[a-z][a-z0-9-]{0,59}$/.test(exam.id) &&
        Number.isSafeInteger(exam.version) && exam.version > 0 &&
        Number.isSafeInteger(exam.number) && exam.number > 0, 'Invalid exam identity');
      check(exam.duration_minutes === 90, 'Fixed exams require 90 minutes');
      check(Array.isArray(exam.question_ids) && exam.question_ids.length === 75 &&
        new Set(exam.question_ids).size === 75, 'Fixed exams require 75 unique questions');
      check(exam.question_ids.every(id => questions.get(id)?.pool === 'validation'),
        'Fixed exams require validation questions only');
      check(exam.choice_ids && same(Object.keys(exam.choice_ids).sort(), [...exam.question_ids].sort()),
        'Incomplete fixed option orders');
      for (const id of exam.question_ids) {
        const order = exam.choice_ids[id];
        check(Array.isArray(order) && same([...order].sort(),
          questions.get(id).choices.map(choice => choice.id).sort()), 'Invalid fixed option order');
      }
      check(exam.domain_counts && same(Object.keys(exam.domain_counts).sort(), [...bank.topics].sort()),
        'Incomplete fixed domain counts');
      for (const topic of bank.topics) {
        check(exam.domain_counts[topic] === exam.question_ids.filter(id =>
          questions.get(id).topic === topic).length, 'Incorrect fixed domain count');
      }
    }
    check(new Set(definitions.map(exam => `${exam.id}:${exam.version}`)).size === definitions.length,
      'Duplicate exam identity');
    check(new Set(historical.map(exam => `${exam.id}:${exam.version}`)).size === historical.length,
      'Duplicate historical exam identity');
    definitions.forEach(validateExam);
    historical.forEach(validateExam);
    function get(id, version) {
      const exam = definitions.find(entry => entry.id === id && entry.version === version) ??
        historical.find(entry => entry.id === id && entry.version === version);
      check(exam, 'Unknown fixed exam ID/version');
      return clone(exam);
    }
    function validateSession(session) {
      const exam = get(session.exam_id, session.exam_version);
      check(session.mode === 'simulation' && same(session.question_ids, exam.question_ids),
        'Session contradicts fixed exam order');
      return exam;
    }
    return { get, list: () => clone(definitions), validateSession };
  }
  function defaultCatalog(bank) {
    const manifest = typeof module !== 'undefined' && module.exports
      ? require('./fixed-exams-data.js') : root.S8_FIXED_EXAMS;
    return createCatalog(manifest, bank);
  }
  const api = { createCatalog, defaultCatalog };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FixedExams = api;
}(typeof globalThis === 'undefined' ? this : globalThis));
