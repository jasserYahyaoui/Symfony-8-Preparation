(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.SyntaxHighlight = api;
    const start = () => api.mount(root.document, root.Prism, root.MutationObserver);
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }
})(globalThis, function () {
  'use strict';
  const highlighted = new WeakMap();
  const aliases = { html: 'markup', xml: 'markup', js: 'javascript', yml: 'yaml', sh: 'bash', shell: 'bash' };
  const labels = { php: 'PHP', yaml: 'YAML', twig: 'Twig', markup: 'HTML / XML', javascript: 'JavaScript', bash: 'Shell', text: 'Texte' };

  function languageOf(code, pre) {
    for (const element of [code, pre]) {
      const declared = element.getAttribute('data-language')
        || [...element.classList].find(name => name.startsWith('language-'))?.slice(9);
      if (declared) return aliases[declared] || declared;
    }
    return /^\s*<\?(?:php\b|=)/i.test(code.textContent) ? 'php' : 'text';
  }

  function appendTokens(parent, tokens, document) {
    if (typeof tokens === 'string') {
      parent.append(document.createTextNode(tokens));
    } else if (Array.isArray(tokens)) {
      for (const token of tokens) appendTokens(parent, token, document);
    } else {
      const span = document.createElement('span');
      span.classList.add('syntax-token');
      for (const name of [tokens.type, ...[].concat(tokens.alias || [])]) {
        span.classList.add(`syntax-${name}`);
      }
      appendTokens(span, tokens.content, document);
      parent.append(span);
    }
  }

  function highlightBlock(pre, prism) {
    if ([...pre.classList].includes('mermaid') || pre.firstElementChild?.tagName.toLowerCase() === 'svg') return false;
    const existing = pre.firstElementChild?.tagName.toLowerCase() === 'code' ? pre.firstElementChild : pre;
    const language = languageOf(existing, pre);
    if (language === 'mermaid') return false;
    const source = existing.textContent;
    const previous = highlighted.get(pre);
    if (previous?.source === source && previous.language === language) return false;
    if (!prism?.languages || typeof prism.tokenize !== 'function') {
      throw new TypeError('The local Prism tokenizer is unavailable.');
    }
    const document = pre.ownerDocument;
    const code = document.createElement('code');
    code.classList.add(`language-${language}`);
    const tokens = prism.languages[language] ? prism.tokenize(source, prism.languages[language]) : source;
    appendTokens(code, tokens, document);
    pre.replaceChildren(code);
    pre.classList.add('syntax-code');
    pre.setAttribute('data-code-language', labels[language] || language.toUpperCase());
    highlighted.set(pre, { source, language });
    return true;
  }

  function mount(document, prism, Observer) {
    if (!prism?.languages || typeof prism.tokenize !== 'function') {
      throw new TypeError('The local Prism tokenizer is unavailable.');
    }
    const scan = () => {
      for (const pre of document.querySelectorAll('pre')) highlightBlock(pre, prism);
    };
    scan();
    const observer = new Observer(scan);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }

  return { highlightBlock, mount };
});
