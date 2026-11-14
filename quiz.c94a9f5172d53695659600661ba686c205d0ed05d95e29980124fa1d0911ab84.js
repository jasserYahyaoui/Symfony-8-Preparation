(function () {
  'use strict';

  // The HTML is the only question bank. This same state machine runs in Node tests.
  function createQuiz(definitions) {
    if (!Array.isArray(definitions) || definitions.length === 0) {
      throw new TypeError('Le quiz doit contenir au moins une question.');
    }
    const questions = new Map();
    for (const definition of definitions) {
      const { id, options, correct } = definition;
      if (typeof id !== 'string' || !id || questions.has(id) ||
          !Array.isArray(options) || options.length < 2 ||
          options.some((option) => typeof option !== 'string' || !option) ||
          new Set(options).size !== options.length || !options.includes(correct)) {
        throw new TypeError('Définition de question invalide ou dupliquée.');
      }
      questions.set(id, { options: [...options], correct });
    }
    const states = new Map();
    function reset() {
      for (const id of questions.keys()) states.set(id, { status: 'pending', choice: null });
    }
    function question(id) {
      if (!questions.has(id)) throw new RangeError(`Question inconnue : ${id}`);
      return questions.get(id);
    }
    function state(id) {
      question(id);
      return { ...states.get(id) };
    }
    function answer(id, choice) {
      const definition = question(id);
      if (!definition.options.includes(choice)) throw new RangeError('Option inconnue.');
      if (states.get(id).status !== 'pending') return state(id);
      states.set(id, {
        status: choice === definition.correct ? 'correct' : 'incorrect',
        choice
      });
      return state(id);
    }
    function reveal(id) {
      question(id);
      if (states.get(id).status === 'pending') {
        states.set(id, { status: 'revealed', choice: null });
      }
      return state(id);
    }
    function score() {
      const values = [...states.values()];
      return {
        total: questions.size,
        answered: values.filter((value) => ['correct', 'incorrect'].includes(value.status)).length,
        correct: values.filter((value) => value.status === 'correct').length,
        revealed: values.filter((value) => value.status === 'revealed').length
      };
    }
    reset();
    return { answer, reveal, reset, score, state };
  }

  function mountQuiz(document) {
    const container = document.getElementById('practice-quiz');
    if (!container) return null;
    const status = document.getElementById('quiz-status');
    const help = document.getElementById('quiz-help');
    const reset = document.getElementById('reset-quiz');
    const fields = [...container.querySelectorAll('fieldset[data-question]')];
    const bindings = fields.map((field) => ({
      id: field.dataset.question,
      correct: field.dataset.correct,
      radios: [...field.querySelectorAll('input[type="radio"]')],
      button: field.querySelector('[data-check]'),
      details: field.querySelector('[data-explanation]'),
      feedback: field.querySelector('[data-feedback]')
    }));
    if (!status || !help || !reset ||
        bindings.some((binding) => !binding.button || !binding.details || !binding.feedback)) {
      throw new Error('Structure du quiz incomplète.');
    }
    const quiz = createQuiz(bindings.map((binding) => ({
      id: binding.id, correct: binding.correct, options: binding.radios.map((radio) => radio.value)
    })));
    function renderScore() {
      const result = quiz.score();
      status.textContent = `Practice: ${result.correct} / ${result.total} correct answers. ` +
        `${result.answered} / ${result.total} answers checked; ${result.revealed} explanations revealed without answering, unscored. ` +
        'This result does not measure exam readiness.';
    }
    function renderQuestion(binding) {
      const state = quiz.state(binding.id);
      const locked = state.status !== 'pending';
      for (const radio of binding.radios) radio.disabled = locked;
      binding.button.disabled = locked;
      const messages = {
        pending: '',
        correct: 'Correct. Read the French explanation below.',
        incorrect: 'Not this time. Read the French explanation below.',
        revealed: 'Explanation opened before checking: no point for this question.'
      };
      binding.feedback.textContent = messages[state.status];
    }
    for (const binding of bindings) {
      // Respect an explanation opened before the deferred script was mounted.
      if (binding.details.open) quiz.reveal(binding.id);
      binding.button.addEventListener('click', () => {
        // toggle events may be queued: inspect open synchronously before scoring.
        if (binding.details.open) quiz.reveal(binding.id);
        if (quiz.state(binding.id).status === 'pending') {
          const selected = binding.radios.find((radio) => radio.checked);
          if (!selected) {
            binding.feedback.textContent = 'Choose an option, or open the explanation directly.';
            binding.radios[0].focus();
            return;
          }
          quiz.answer(binding.id, selected.value);
        }
        renderQuestion(binding);
        binding.details.open = true;
        renderScore();
      });
      binding.details.addEventListener('toggle', () => {
        if (binding.details.open) {
          quiz.reveal(binding.id);
          renderQuestion(binding);
          renderScore();
        }
      });
      binding.button.hidden = false;
      renderQuestion(binding);
    }
    reset.addEventListener('click', () => {
      quiz.reset();
      for (const binding of bindings) {
        binding.details.open = false;
        for (const radio of binding.radios) radio.checked = false;
        renderQuestion(binding);
      }
      renderScore();
      bindings[0].radios[0].focus();
    });
    reset.hidden = false;
    status.hidden = false;
    help.textContent = 'Choose an option, then select “Check”. Your first checked answer is final for this session. ' +
      'Opening an explanation before checking locks the question without a point. “Restart” clears only this session.';
    renderScore();
    return quiz;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createQuiz, mountQuiz };
  } else if (typeof document !== 'undefined') {
    try {
      mountQuiz(document);
    } catch (error) {
      const status = document.getElementById('quiz-status');
      if (status) {
        status.hidden = false;
        status.textContent = 'Interactive scoring is unavailable. Use “Reveal” to read the explanations.';
      }
      for (const control of document.querySelectorAll('[data-check], #reset-quiz')) control.hidden = true;
      for (const radio of document.querySelectorAll('input[type="radio"]')) radio.disabled = false;
      // Surface a programming fault while keeping the native learning material usable.
      console.error('Initialisation du quiz impossible.', error);
    }
  }
}());
