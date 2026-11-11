(function () {
  'use strict';
  function expandViewBox([x, y, width, height], bounds) {
    const left = Math.min(x, bounds.x - 8);
    const top = Math.min(y, bounds.y - 8);
    const right = Math.max(x + width, bounds.x + bounds.width + 8);
    const bottom = Math.max(y + height, bounds.y + bounds.height + 8);
    return [left, top, right - left, bottom - top];
  }

  function plainLabel(value = '') {
    // Mermaid 11.17.2 keeps entity placeholders in its parsed flowchart database.
    return String(value).replace(/<br\s*\/?>/gi, '\n')
      .replace(/ﬂ°°/g, '&#').replace(/ﬂ°/g, '&').replace(/¶ß/g, ';')
      .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name) => {
        const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
        if (named[name.toLowerCase()]) return named[name.toLowerCase()];
        const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
      });
  }

  function wrapLabel(value, width, measure) {
    const lines = [];
    for (const paragraph of plainLabel(value).split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        if (measure(line ? `${line} ${word}` : word) <= width) {
          line += (line ? ' ' : '') + word;
          continue;
        }
        if (line) lines.push(line);
        line = '';
        // Prefer PHP namespace, method, underscore and camel-case boundaries.
        const parts = word.split(/(?<=[\\_/:.])/).flatMap(part =>
          measure(part) <= width ? [part] : part.split(/(?<=[a-z])(?=[A-Z])/));
        for (const part of parts) {
          if (measure(line + part) <= width) {
            line += part;
          } else {
            if (line) lines.push(line);
            line = '';
            for (const character of part) {
              if (line && measure(line + character) > width) {
                lines.push(line);
                line = '';
              }
              line += character;
            }
          }
        }
      }
      lines.push(line);
    }
    return lines;
  }

  function flowModel(database) {
    const groups = database.getSubGraphs().map(group => ({
      id: group.id, title: plainLabel(group.title), nodes: [...group.nodes]
    }));
    const vertices = [...database.getVertices().values()].map((vertex, index) => {
      const group = groups.find(candidate => candidate.id === vertex.id);
      if ((!group && !['square', 'stadium', 'diamond'].includes(vertex.type))
          || vertex.styles.length || vertex.classes.length || Object.keys(vertex.props).length) {
        throw new Error(`Unsupported responsive node: ${vertex.id}`);
      }
      return {
        id: vertex.id, reference: index + 1, type: group ? 'square' : vertex.type,
        text: group ? `Groupe : ${group.title}` : plainLabel(vertex.text),
        groups: groups.filter(candidate => candidate.nodes.includes(vertex.id)).map(candidate => candidate.title),
        isGroup: Boolean(group)
      };
    });
    const edges = database.getEdges().map(edge => {
      if (!['arrow_point', 'arrow_open', 'arrow_cross'].includes(edge.type)
          || !['normal', 'dotted', 'invisible'].includes(edge.stroke)
          || edge.classes.length || edge.style) {
        throw new Error(`Unsupported responsive edge: ${edge.id}`);
      }
      return { id: edge.id, start: edge.start, end: edge.end, type: edge.type, stroke: edge.stroke, text: plainLabel(edge.text) };
    });
    return {
      vertices, edges, groups,
      title: database.getDiagramTitle(),
      accTitle: database.getAccTitle(), accDescr: database.getAccDescription()
    };
  }

  function flowPaths(model) {
    const visible = model.edges.filter(edge => edge.stroke !== 'invisible');
    if (new Set(model.edges.map(edge => edge.id)).size !== model.edges.length) {
      throw new Error('Duplicate edge identifiers cannot be split safely.');
    }
    const incoming = new Map(), outgoing = new Map(), used = new Set(), paths = [];
    const vertexIds = new Set(model.vertices.map(vertex => vertex.id));
    for (const edge of visible) {
      if (!vertexIds.has(edge.start) || !vertexIds.has(edge.end)) throw new Error(`Unknown edge endpoint: ${edge.id}`);
      incoming.set(edge.end, (incoming.get(edge.end) || 0) + 1);
      if (!outgoing.has(edge.start)) outgoing.set(edge.start, []);
      outgoing.get(edge.start).push(edge);
    }
    function takePath(first) {
      if (used.has(first.id)) return;
      const path = { nodes: [first.start], edges: [] };
      let edge = first;
      while (edge && !used.has(edge.id)) {
        used.add(edge.id);
        path.edges.push(edge);
        path.nodes.push(edge.end);
        if (incoming.get(edge.end) !== 1 || outgoing.get(edge.end)?.length !== 1) break;
        edge = outgoing.get(edge.end)[0];
      }
      paths.push(path);
    }
    for (const edge of visible) {
      if (incoming.get(edge.start) !== 1 || outgoing.get(edge.start)?.length !== 1) takePath(edge);
    }
    for (const edge of visible) takePath(edge); // Closed cycles have no starting branch.
    const included = new Set(paths.flatMap(path => path.nodes));
    for (const vertex of model.vertices) {
      if (!vertex.isGroup && !included.has(vertex.id)) paths.push({ nodes: [vertex.id], edges: [] });
    }
    return paths;
  }

  function svgElement(document, name, attributes = {}, text) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function drawFlowPanels(document, node, model, width, identifier) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = '16px sans-serif';
    const measure = text => context.measureText(text).width;
    const vertices = new Map(model.vertices.map(vertex => [vertex.id, vertex]));
    const paths = flowPaths(model);
    const fragment = document.createDocumentFragment();
    const heading = document.createElement('p');
    heading.className = 'diagram-help';
    heading.textContent = `${model.title || model.accTitle} — lecture verticale. Les repères répétés désignent le même nœud ; chaque liaison apparaît une seule fois.`;
    fragment.append(heading);
    for (const [index, path] of paths.entries()) {
      const id = `${identifier}-panel-${index}`;
      const drawing = svgElement(document, 'svg', {
        id, class: 'flowchart responsive-flowchart', role: 'img',
        'aria-roledescription': 'flowchart', 'aria-labelledby': `${id}-title`,
        'aria-describedby': `${id}-description`, 'data-source-edges': JSON.stringify(path.edges.map(edge => edge.id))
      });
      drawing.append(svgElement(document, 'title', { id: `${id}-title` }, `${model.accTitle} — panneau ${index + 1} sur ${paths.length}`));
      drawing.append(svgElement(document, 'desc', { id: `${id}-description` }, model.accDescr));
      const defs = svgElement(document, 'defs');
      for (const type of ['point', 'cross']) {
        const marker = svgElement(document, 'marker', { id: `${id}-${type}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto', markerUnits: 'userSpaceOnUse' });
        marker.append(svgElement(document, 'path', { d: type === 'point' ? 'M0 0 L10 5 L0 10 Z' : 'M1 1 L9 9 M1 9 L9 1' }));
        defs.append(marker);
      }
      drawing.append(defs);
      let y = 8;
      function textLines(parent, lines, top, className = '') {
        const text = svgElement(document, 'text', { x: width / 2, y: top + 16, 'text-anchor': 'middle', class: className });
        lines.forEach((line, row) => text.append(svgElement(document, 'tspan', { x: width / 2, dy: row ? 20 : 0 }, line)));
        parent.append(text);
      }
      path.nodes.forEach((nodeId, position) => {
        const vertex = vertices.get(nodeId);
        const shapeWidth = width - 16;
        const isDecision = vertex.type === 'diamond';
        const textWidth = shapeWidth - 40;
        const lines = [
          `${isDecision ? 'Décision · repère' : 'Repère'} ${vertex.reference}`,
          ...vertex.groups.flatMap(group => wrapLabel(`Groupe : ${group}`, textWidth, measure)),
          ...wrapLabel(vertex.text, textWidth, measure)
        ];
        const textHeight = lines.length * 20;
        const height = textHeight + (isDecision ? 56 : 32);
        const group = svgElement(document, 'g', {
          class: 'node', 'data-source-node': vertex.id, 'data-source-shape': vertex.type,
          role: 'group', 'aria-label': `${isDecision ? 'Décision. ' : ''}Repère ${vertex.reference}. ${vertex.groups.join('. ')}. ${vertex.text}`,
          transform: `translate(0 ${y})`
        });
        group.append(svgElement(document, 'rect', {
          class: 'label-container', x: 8, y: 0, width: shapeWidth, height, rx: vertex.type === 'stadium' ? 24 : 0
        }));
        // A decision keeps its diamond symbol, but its question uses the full card
        // width instead of being squeezed into a tall rhombus on a phone.
        if (isDecision) group.append(svgElement(document, 'polygon', {
          class: 'decision-symbol', 'aria-hidden': 'true',
          points: `${width / 2},8 ${width / 2 + 8},16 ${width / 2},24 ${width / 2 - 8},16`
        }));
        const label = svgElement(document, 'g', { class: 'label' });
        textLines(label, lines, (height - textHeight) / 2);
        group.append(label);
        drawing.append(group);
        y += height;
        const edge = path.edges[position];
        if (!edge) return;
        const edgeLines = edge.text ? wrapLabel(edge.text, width - 32, measure) : [];
        const gap = Math.max(40, edgeLines.length * 20 + 32);
        const line = svgElement(document, 'path', {
          class: `flowchart-link${edge.stroke === 'dotted' ? ' edge-pattern-dotted' : ''}`,
          d: `M${width / 2} ${y} L${width / 2} ${y + gap - 4}`,
          'data-source-edge': edge.id, 'data-source-start': edge.start, 'data-source-end': edge.end,
          'data-source-type': edge.type, 'data-source-stroke': edge.stroke
        });
        if (edge.type !== 'arrow_open') line.setAttribute('marker-end', `url(#${id}-${edge.type === 'arrow_cross' ? 'cross' : 'point'})`);
        drawing.append(line);
        if (edgeLines.length) {
          const label = svgElement(document, 'g', { class: 'edgeLabel', 'data-source-edge-label': edge.id });
          label.append(svgElement(document, 'rect', { x: 8, y: y + 12, width: width - 16, height: edgeLines.length * 20 + 4 }));
          textLines(label, edgeLines, y + 14);
          drawing.append(label);
        }
        y += gap;
      });
      drawing.setAttribute('viewBox', `0 0 ${width} ${y + 8}`);
      drawing.setAttribute('width', width);
      drawing.setAttribute('height', y + 8);
      fragment.append(drawing);
    }
    node.replaceChildren(fragment);
    node.setAttribute('data-diagram-layout', 'panels');
  }

  async function renderDiagrams(document, engine) {
    const nodes = [...document.querySelectorAll('.mermaid')];
    if (!nodes.length) return;
    if (!engine) throw new Error('Local Mermaid runtime is unavailable; text equivalents remain visible.');
    const config = {
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      maxTextSize: 50000,
      htmlLabels: false,
      fontFamily: 'sans-serif',
      themeVariables: { fontFamily: 'sans-serif', fontSize: '16px' },
      // The course authors supply line breaks; automatic wrapping splits PHP identifiers.
      flowchart: { htmlLabels: false, useMaxWidth: false, wrappingWidth: Number.MAX_SAFE_INTEGER },
      sequence: { useMaxWidth: false },
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'htmlLabels', 'flowchart', 'sequence', 'fontFamily', 'themeVariables']
    };
    engine.initialize(config);
    const sources = nodes.map(node => node.textContent);
    function installDrawing(node, svg) {
      // Keep the strict CSP: Mermaid's generated inline styles are replaced by reader.css.
      const template = document.createElement('template');
      template.innerHTML = svg; // Strict local Mermaid output, never learner-supplied HTML.
      for (const style of template.content.querySelectorAll('style')) style.remove();
      for (const element of template.content.querySelectorAll('[style]')) element.removeAttribute('style');
      const drawing = template.content.querySelector('svg');
      const dimensions = drawing?.getAttribute('viewBox')?.trim().split(/\s+/).map(Number);
      if (!dimensions || dimensions.length !== 4 || !dimensions.every(Number.isFinite)
          || dimensions[2] <= 0 || dimensions[3] <= 0) {
        throw new Error('Mermaid returned an invalid SVG viewBox.');
      }
      node.replaceChildren(template.content);
      node.hidden = false;
      // Sequence titles can exceed Mermaid's viewBox. Include the final CSS layout,
      // retaining the original bounds so arrowheads and other padding are not cropped.
      const fitted = expandViewBox(dimensions, drawing.getBBox());
      drawing.setAttribute('viewBox', fitted.join(' '));
      drawing.setAttribute('width', String(Math.ceil(fitted[2])));
      drawing.setAttribute('height', String(Math.ceil(fitted[3])));
      return fitted;
    }
    async function renderNode(node, index) {
      try {
        node.setAttribute('data-diagram-state', 'rendering');
        if (node.nextElementSibling?.classList.contains('diagram-warning')) node.nextElementSibling.remove();
        node.textContent = '';
        node.hidden = false;
        const available = node.clientWidth || Infinity;
        const source = sources[index];
        engine.initialize(config);
        const { svg } = await engine.render(`s8-diagram-${index}`, source);
        const fitted = installDrawing(node, svg);
        node.setAttribute('data-diagram-layout', 'overview');
        if (fitted[2] > available * 16 / 14) {
          const parsed = await engine.mermaidAPI.getDiagramFromText(source);
          if (parsed.type === 'flowchart-v2') {
            drawFlowPanels(document, node, flowModel(parsed.db), Math.floor(available), `s8-diagram-${index}`);
          } else if (parsed.type === 'sequence') {
            const title = parsed.db.getDiagramTitle();
            engine.initialize({
              ...config,
              sequence: {
                useMaxWidth: false, wrap: true, width: 140, actorMargin: 4,
                diagramMarginX: 4, wrapPadding: 0, messageMargin: 24,
                noteMargin: 4, mirrorActors: false, actorFontSize: 16, noteFontSize: 16,
                actorFontFamily: 'sans-serif', messageFontFamily: 'sans-serif', noteFontFamily: 'sans-serif'
              }
            });
            const compact = await engine.render(`s8-diagram-${index}-sequence`,
              source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''));
            const dimensions = installDrawing(node, compact.svg);
            if (dimensions[2] > available * 16 / 14) throw new Error('Sequence cannot fit with readable text.');
            const heading = document.createElement('p');
            heading.className = 'diagram-heading';
            heading.textContent = title;
            node.prepend(heading);
            node.setAttribute('data-diagram-layout', 'sequence');
          } else {
            throw new Error(`Responsive layout unavailable for ${parsed.type}`);
          }
        }
        node.setAttribute('data-diagram-state', 'ready');
      } catch (error) {
        node.hidden = true;
        node.setAttribute('data-diagram-state', 'error');
        const warning = document.createElement('p');
        warning.className = 'diagram-warning';
        warning.textContent = 'Schéma non dessiné : l’équivalent textuel ci-dessus reste disponible.';
        warning.setAttribute('data-diagram-error', error.message);
        node.after(warning);
      }
    }
    for (const [index, node] of nodes.entries()) await renderNode(node, index);
    const ResizeObserver = document.defaultView?.ResizeObserver;
    if (ResizeObserver) {
      let timer, queue = Promise.resolve();
      const widths = nodes.map(node => node.clientWidth);
      const observer = new ResizeObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          queue = queue.then(async () => {
            for (const [index, node] of nodes.entries()) {
              if (Math.abs(node.clientWidth - widths[index]) < 1) continue;
              widths[index] = node.clientWidth;
              await renderNode(node, index);
            }
          });
        }, 150);
      });
      nodes.forEach(node => observer.observe(node));
    }
  }
  if (typeof module !== 'undefined') module.exports = { renderDiagrams, expandViewBox, plainLabel, wrapLabel, flowPaths, flowModel };
  if (typeof document !== 'undefined') {
    renderDiagrams(document, window.mermaid).catch(error => {
      for (const node of document.querySelectorAll('.mermaid')) {
        const warning = document.createElement('p');
        warning.textContent = error.message;
        node.after(warning);
      }
    });
  }
}());
