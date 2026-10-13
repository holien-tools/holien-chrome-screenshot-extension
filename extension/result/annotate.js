// Annotations the user draws over the screenshots on the result page (boxes,
// arrows, text, numbered markers and mosaics), and merging them into the
// images for download and copy.
//
// Each image gets an SVG overlay that scales with it. Shapes are kept in image
// pixels as plain objects, so the overlay and the merged image come out the
// same, and the shapes can be saved with the capture.

const SVG_NS = 'http://www.w3.org/2000/svg';

export const TOOLS = ['box', 'arrow', 'text', 'number', 'mosaic'];

// Preset colors, by the name of their i18n message.
export const COLORS = [
  ['colorRed', '#e53935'],
  ['colorGreen', '#2e9e45'],
  ['colorBlue', '#1e6fe0'],
  ['colorYellow', '#f5c400'],
  ['colorOrange', '#ff7a00'],
  ['colorBlack', '#000000'],
  ['colorWhite', '#ffffff'],
];

// Line widths in CSS pixels, by the name of their i18n message. They're
// multiplied by the capture's pixel scale so they look the same on every
// screen. The other tools take their size from the line width too.
export const LINE_WIDTHS = [
  ['lineThin', 2],
  ['lineMedium', 4],
  ['lineThick', 8],
];
export const DEFAULT_LINE_WIDTH = 4;
const textSize = (lineWidth) => lineWidth * 4 + 6;
const markerRadius = (lineWidth) => lineWidth * 2 + 8;
const mosaicBlock = (lineWidth) => lineWidth * 2 + 2;

const FONT = 'system-ui, -apple-system, "Segoe UI", "PingFang TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif';
const LINE_HEIGHT = 1.2;

// Drags smaller than this (in CSS pixels) are taken for clicks.
const MIN_DRAG = 4;
// How far from a line a click still selects its shape, in CSS pixels.
const HIT_PADDING = 6;
// Size of a resize handle, in CSS pixels.
const HANDLE_SIZE = 9;

// Black or white, whichever reads better on the color.
function contrast(color) {
  const n = parseInt(color.slice(1), 16);
  const luma = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return luma > 160 ? '#000000' : '#ffffff';
}

const el = (tag, attrs = {}, className = '') => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (className) node.setAttribute('class', className);
  return node;
};

const bounds = (shape) => {
  if (shape.type === 'arrow') {
    return {
      left: Math.min(shape.x1, shape.x2),
      top: Math.min(shape.y1, shape.y2),
      right: Math.max(shape.x1, shape.x2),
      bottom: Math.max(shape.y1, shape.y2),
    };
  }
  if (shape.type === 'number') {
    return { left: shape.x - shape.radius, top: shape.y - shape.radius, right: shape.x + shape.radius, bottom: shape.y + shape.radius };
  }
  return { left: shape.x, top: shape.y, right: shape.x + (shape.width ?? 0), bottom: shape.y + (shape.height ?? 0) };
};

// The arrow's line end and head corners.
function arrowGeometry(shape) {
  const dx = shape.x2 - shape.x1;
  const dy = shape.y2 - shape.y1;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const head = Math.min(shape.lineWidth * 3.5, length);
  const half = shape.lineWidth * 1.75;
  const bx = shape.x2 - ux * head;
  const by = shape.y2 - uy * head;
  return {
    // The line stops short of the tip so it doesn't poke out of the head.
    lineEnd: { x: shape.x2 - ux * head * 0.6, y: shape.y2 - uy * head * 0.6 },
    head: [
      [shape.x2, shape.y2],
      [bx - uy * half, by + ux * half],
      [bx + uy * half, by - ux * half],
    ],
  };
}

const textLines = (shape) => shape.text.split('\n');
const textStroke = (shape) => shape.fontSize / 8;

// Creates the drawing state shared by all the images of a capture. onChange is
// called whenever a shape is added, changed or removed.
export function createAnnotator({ scale = 1, onChange }) {
  const state = {
    tool: 'box',
    color: COLORS[0][1],
    lineWidth: DEFAULT_LINE_WIDTH,
    layers: [],
    selected: null, // { layer, shape }
    history: [],
    seq: 0,
  };
  const px = (css) => css * scale;

  function count() {
    return state.layers.reduce((n, layer) => n + (layer?.shapes.length ?? 0), 0);
  }

  function changed() {
    renumber();
    onChange?.(count());
  }

  // Numbered markers count up in the order they were placed, across all images.
  function renumber() {
    const markers = state.layers
      .flatMap((layer) => (layer ? layer.shapes.filter((s) => s.type === 'number').map((shape) => ({ layer, shape })) : []))
      .sort((a, b) => a.shape.seq - b.shape.seq);
    markers.forEach(({ layer, shape }, i) => {
      if (shape.number !== i + 1) {
        shape.number = i + 1;
        render(layer, shape);
      }
    });
  }

  // Puts a drawing overlay over the image, which must already be in container,
  // and draws the shapes saved with it.
  function attach(container, img, index, shapes = []) {
    const width = Number(img.getAttribute('width'));
    const height = Number(img.getAttribute('height'));
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' }, 'shapes');
    const mosaics = el('g', {}, 'mosaics');
    const marks = el('g', {}, 'marks');
    const handles = el('g', {}, 'handles');
    svg.append(mosaics, marks, handles);
    container.append(svg);
    // Keys (Delete, Ctrl+Z) go to the image the user last drew on.
    container.tabIndex = -1;
    const layer = {
      index,
      width,
      height,
      container,
      img,
      svg,
      mosaics,
      marks,
      handles,
      shapes: [],
      nodes: new Map(),
      bitmap: null,
      composed: new Map(),
      editor: null,
    };
    state.layers[index] = layer;
    for (const shape of shapes) {
      state.seq = Math.max(state.seq, shape.seq ?? 0);
      layer.shapes.push(shape);
      render(layer, shape);
    }
    renumber();

    const displayScale = () => img.getBoundingClientRect().width / width;
    const toImage = (event) => {
      const rect = img.getBoundingClientRect();
      const clamp = (n, max) => Math.min(Math.max(Math.round(n), 0), max);
      return {
        x: clamp(((event.clientX - rect.left) * width) / rect.width, width),
        y: clamp(((event.clientY - rect.top) * height) / rect.height, height),
      };
    };

    new ResizeObserver(() => {
      if (state.selected?.layer === layer) showHandles();
    }).observe(img);

    container.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('.text-editor')) return;
      event.preventDefault();
      container.focus({ preventScroll: true });
      if (layer.editor) {
        layer.editor.commit();
        return;
      }
      const start = toImage(event);
      const handle = event.target.closest('.handle')?.dataset.handle;
      if (handle && state.selected?.layer === layer) {
        resize(layer, state.selected.shape, handle, start, event);
        return;
      }
      const node = event.target.closest('.shape');
      if (node) {
        const shape = layer.shapes.find((s) => layer.nodes.get(s) === node);
        select(layer, shape);
        move(layer, shape, start, event);
        return;
      }
      select(null);
      create(layer, start, event);
    });

    container.addEventListener('dblclick', (event) => {
      const node = event.target.closest('.shape');
      const shape = node && layer.shapes.find((s) => layer.nodes.get(s) === node);
      if (shape?.type === 'text') editText(layer, shape);
    });

    // Follows a drag to its end, in image pixels.
    function track(event, { onMove, onEnd }) {
      const pointerId = event.pointerId;
      const origin = toImage(event);
      let moved = false;
      const onPointerMove = (event) => {
        const point = toImage(event);
        if (!moved && Math.hypot(point.x - origin.x, point.y - origin.y) < px(MIN_DRAG)) return;
        moved = true;
        onMove(point, point.x - origin.x, point.y - origin.y);
      };
      const finish = (keep) => {
        container.removeEventListener('pointermove', onPointerMove);
        container.removeEventListener('pointerup', onUp);
        container.removeEventListener('pointercancel', onCancel);
        document.removeEventListener('keydown', onKey);
        try {
          container.releasePointerCapture(pointerId);
        } catch {
          // The pointer is already gone.
        }
        onEnd(keep && moved, moved);
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);
      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          finish(false);
        }
      };
      container.setPointerCapture(pointerId);
      container.addEventListener('pointermove', onPointerMove);
      container.addEventListener('pointerup', onUp);
      container.addEventListener('pointercancel', onCancel);
      document.addEventListener('keydown', onKey);
    }

    function create(layer, start, event) {
      const tool = state.tool;
      if (tool === 'text') {
        const shape = { type: 'text', x: start.x, y: start.y, text: '', color: state.color, fontSize: px(textSize(state.lineWidth)) };
        editText(layer, shape, true);
        return;
      }
      if (tool === 'number') {
        track(event, {
          onMove() {},
          onEnd(_, moved) {
            if (moved) return;
            add(layer, { type: 'number', x: start.x, y: start.y, color: state.color, radius: px(markerRadius(state.lineWidth)) });
          },
        });
        return;
      }
      const lineWidth = Math.max(1, Math.round(px(state.lineWidth)));
      const shape =
        tool === 'arrow'
          ? { type: 'arrow', x1: start.x, y1: start.y, x2: start.x, y2: start.y, color: state.color, lineWidth }
          : tool === 'mosaic'
            ? { type: 'mosaic', x: start.x, y: start.y, width: 0, height: 0, block: Math.max(2, Math.round(px(mosaicBlock(state.lineWidth)))) }
            : { type: 'box', x: start.x, y: start.y, width: 0, height: 0, color: state.color, lineWidth };
      let drawing = false;
      track(event, {
        onMove(point) {
          if (!drawing) {
            drawing = true;
            layer.shapes.push(shape);
            render(layer, shape).classList.add('drawing');
          }
          if (tool === 'arrow') {
            shape.x2 = point.x;
            shape.y2 = point.y;
          } else {
            shape.x = Math.min(start.x, point.x);
            shape.y = Math.min(start.y, point.y);
            shape.width = Math.abs(point.x - start.x);
            shape.height = Math.abs(point.y - start.y);
          }
          render(layer, shape);
        },
        onEnd(keep) {
          if (!drawing) return;
          const min = Math.max(px(MIN_DRAG), shape.lineWidth ?? 0);
          const tooSmall = tool === 'arrow' ? Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) < min : shape.width < min || shape.height < min;
          layer.shapes.splice(layer.shapes.indexOf(shape), 1);
          layer.nodes.get(shape).remove();
          layer.nodes.delete(shape);
          if (keep && !tooSmall) add(layer, shape);
        },
      });
    }

    function move(layer, shape, start, event) {
      const before = JSON.stringify(shape);
      const original = JSON.parse(before);
      const box = bounds(original);
      track(event, {
        onMove(_, dx, dy) {
          dx = Math.min(Math.max(dx, -box.left), layer.width - box.right);
          dy = Math.min(Math.max(dy, -box.top), layer.height - box.bottom);
          if (shape.type === 'arrow') {
            Object.assign(shape, { x1: original.x1 + dx, y1: original.y1 + dy, x2: original.x2 + dx, y2: original.y2 + dy });
          } else {
            Object.assign(shape, { x: original.x + dx, y: original.y + dy });
          }
          render(layer, shape);
          showHandles();
        },
        onEnd(keep) {
          if (!keep) Object.assign(shape, original);
          render(layer, shape);
          showHandles();
          if (keep) commitChange(layer, shape, before);
        },
      });
    }

    function resize(layer, shape, handle, start, event) {
      const before = JSON.stringify(shape);
      const original = JSON.parse(before);
      const min = Math.max(px(MIN_DRAG), shape.lineWidth ?? 0);
      track(event, {
        onMove(point) {
          if (shape.type === 'arrow') {
            if (handle === 'start') Object.assign(shape, { x1: point.x, y1: point.y });
            else Object.assign(shape, { x2: point.x, y2: point.y });
          } else {
            let { left, top, right, bottom } = bounds(original);
            if (handle.includes('w')) left = Math.min(point.x, right - min);
            if (handle.includes('e')) right = Math.max(point.x, left + min);
            if (handle.includes('n')) top = Math.min(point.y, bottom - min);
            if (handle.includes('s')) bottom = Math.max(point.y, top + min);
            Object.assign(shape, { x: left, y: top, width: right - left, height: bottom - top });
          }
          render(layer, shape);
          showHandles();
        },
        onEnd(keep) {
          if (!keep) Object.assign(shape, original);
          render(layer, shape);
          showHandles();
          if (keep) commitChange(layer, shape, before);
        },
      });
    }

    return layer;
  }

  function add(layer, shape) {
    shape.seq = ++state.seq;
    layer.shapes.push(shape);
    render(layer, shape);
    layer.composed.clear();
    state.history.push({ layer, shape });
    select(layer, shape);
    changed();
  }

  function commitChange(layer, shape, before) {
    if (JSON.stringify(shape) === before) return;
    layer.composed.clear();
    changed();
  }

  // Opens a text box over the image to type a label; a new one is added when
  // something was typed, an existing one is changed or, if emptied, removed.
  function editText(layer, shape, isNew = false) {
    if (layer.editor) layer.editor.commit();
    select(null);
    const node = layer.nodes.get(shape);
    node?.classList.add('editing');
    const rect = layer.img.getBoundingClientRect();
    const factor = rect.width / layer.width;
    const editor = document.createElement('textarea');
    editor.className = 'text-editor';
    editor.rows = 1;
    editor.value = shape.text;
    editor.style.left = `${shape.x * factor}px`;
    editor.style.top = `${shape.y * factor}px`;
    editor.style.fontSize = `${shape.fontSize * factor}px`;
    editor.style.lineHeight = String(LINE_HEIGHT);
    editor.style.color = shape.color;
    editor.style.maxWidth = `${(layer.width - shape.x) * factor}px`;
    const fit = () => {
      editor.style.height = '0';
      editor.style.width = '0';
      editor.style.width = `${editor.scrollWidth + 4}px`;
      editor.style.height = `${editor.scrollHeight}px`;
    };
    const close = () => {
      if (layer.editor !== handle) return;
      layer.editor = null;
      editor.remove();
      node?.classList.remove('editing');
    };
    const commit = () => {
      if (layer.editor !== handle) return;
      const text = editor.value.replace(/\s+$/, '');
      close();
      if (isNew) {
        if (text) add(layer, { ...shape, text });
      } else if (!text) {
        remove(layer, shape);
        changed();
      } else if (text !== shape.text) {
        shape.text = text;
        render(layer, shape);
        layer.composed.clear();
        changed();
      }
    };
    const cancel = () => {
      close();
      if (!isNew) render(layer, shape);
    };
    const handle = { commit, cancel };
    layer.editor = handle;
    editor.addEventListener('input', fit);
    editor.addEventListener('blur', commit);
    editor.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        commit();
      }
    });
    layer.container.append(editor);
    fit();
    editor.focus();
    editor.select();
  }

  // Draws a shape on its overlay, or redraws it after a change.
  function render(layer, shape) {
    let node = layer.nodes.get(shape);
    if (!node) {
      node = el('g', { 'data-type': shape.type }, 'shape');
      layer.nodes.set(shape, node);
      (shape.type === 'mosaic' ? layer.mosaics : layer.marks).append(node);
    }
    node.replaceChildren(...draw(layer, shape));
    return node;
  }

  function draw(layer, shape) {
    const hitWidth = (lineWidth) => lineWidth + 2 * px(HIT_PADDING);
    switch (shape.type) {
      case 'box': {
        // The line is drawn inside the dragged rectangle, so a box along the
        // edge of the image keeps its whole line.
        const inset = shape.lineWidth / 2;
        const attrs = {
          x: shape.x + inset,
          y: shape.y + inset,
          width: Math.max(0, shape.width - shape.lineWidth),
          height: Math.max(0, shape.height - shape.lineWidth),
        };
        return [
          el('rect', { ...attrs, 'stroke-width': hitWidth(shape.lineWidth) }, 'hit'),
          el('rect', { ...attrs, stroke: shape.color, 'stroke-width': shape.lineWidth }, 'line'),
        ];
      }
      case 'arrow': {
        const { lineEnd, head } = arrowGeometry(shape);
        const d = `M ${shape.x1} ${shape.y1} L ${lineEnd.x} ${lineEnd.y}`;
        const points = head.map((p) => p.join(',')).join(' ');
        return [
          el('path', { d: `M ${shape.x1} ${shape.y1} L ${shape.x2} ${shape.y2}`, 'stroke-width': hitWidth(shape.lineWidth) }, 'hit'),
          el('path', { d, stroke: shape.color, 'stroke-width': shape.lineWidth, 'stroke-linecap': 'round' }, 'line'),
          el('polygon', { points, fill: shape.color }, 'fill'),
        ];
      }
      case 'text': {
        const lineHeight = shape.fontSize * LINE_HEIGHT;
        const text = el('text', {
          x: shape.x,
          y: shape.y,
          fill: shape.color,
          stroke: contrast(shape.color),
          'stroke-width': textStroke(shape),
          'stroke-linejoin': 'round',
          'paint-order': 'stroke',
          'font-family': FONT,
          'font-size': shape.fontSize,
          'font-weight': 'bold',
        });
        textLines(shape).forEach((line, i) => {
          const tspan = el('tspan', { x: shape.x, y: shape.y + shape.fontSize * 0.9 + i * lineHeight });
          tspan.textContent = line || ' ';
          text.append(tspan);
        });
        const hit = el('rect', { x: shape.x, y: shape.y, width: 1, height: 1 }, 'hit fill');
        // The hit area is sized once the text is laid out.
        queueMicrotask(() => {
          if (!text.isConnected) return;
          const box = text.getBBox();
          const pad = px(HIT_PADDING);
          hit.setAttribute('x', box.x - pad);
          hit.setAttribute('y', box.y - pad);
          hit.setAttribute('width', box.width + 2 * pad);
          hit.setAttribute('height', box.height + 2 * pad);
        });
        return [hit, text];
      }
      case 'number': {
        const text = el('text', {
          x: shape.x,
          y: shape.y,
          fill: contrast(shape.color),
          'text-anchor': 'middle',
          'dominant-baseline': 'central',
          'font-family': FONT,
          'font-size': shape.radius * 1.2,
          'font-weight': 'bold',
        });
        text.textContent = String(shape.number ?? '');
        return [
          el('circle', { cx: shape.x, cy: shape.y, r: shape.radius + px(HIT_PADDING) }, 'hit fill'),
          el('circle', { cx: shape.x, cy: shape.y, r: shape.radius, fill: shape.color, stroke: contrast(shape.color), 'stroke-width': shape.radius / 8 }, 'fill'),
          text,
        ];
      }
      case 'mosaic': {
        const image = el('image', { x: shape.x, y: shape.y, width: shape.width, height: shape.height, preserveAspectRatio: 'none' });
        tile(layer, shape).then((href) => {
          if (href) image.setAttribute('href', href);
        });
        return [el('rect', { x: shape.x, y: shape.y, width: shape.width, height: shape.height }, 'hit fill'), image];
      }
      default:
        return [];
    }
  }

  // The pixelated image under a mosaic, as a data URL for the overlay.
  async function tile(layer, shape) {
    if (!shape.width || !shape.height) return null;
    layer.bitmap ??= fetch(layer.img.src)
      .then((response) => response.blob())
      .then((blob) => createImageBitmap(blob));
    const bitmap = await layer.bitmap;
    const canvas = document.createElement('canvas');
    canvas.width = shape.width;
    canvas.height = shape.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, shape.x, shape.y, shape.width, shape.height, 0, 0, shape.width, shape.height);
    pixelate(ctx, { ...shape, x: 0, y: 0 });
    return canvas.toDataURL();
  }

  // Shows the resize handles of the selected shape.
  function showHandles() {
    const selected = state.selected;
    for (const layer of state.layers) layer?.handles.replaceChildren();
    if (!selected) return;
    const { layer, shape } = selected;
    const size = HANDLE_SIZE / (layer.img.getBoundingClientRect().width / layer.width || 1);
    const handles = [];
    if (shape.type === 'arrow') {
      handles.push(['start', shape.x1, shape.y1], ['end', shape.x2, shape.y2]);
    } else if (shape.type === 'box' || shape.type === 'mosaic') {
      const { left, top, right, bottom } = bounds(shape);
      const cx = (left + right) / 2;
      const cy = (top + bottom) / 2;
      handles.push(['nw', left, top], ['n', cx, top], ['ne', right, top], ['e', right, cy], ['se', right, bottom], ['s', cx, bottom], ['sw', left, bottom], ['w', left, cy]);
    }
    layer.handles.replaceChildren(
      ...handles.map(([name, x, y]) => {
        const node = el('rect', { x: x - size / 2, y: y - size / 2, width: size, height: size, 'stroke-width': size / 6 }, 'handle');
        node.dataset.handle = name;
        return node;
      }),
    );
  }

  const nodeOf = ({ layer, shape }) => layer.nodes.get(shape);

  function select(layer, shape) {
    if (state.selected) nodeOf(state.selected)?.classList.remove('selected');
    state.selected = layer && shape ? { layer, shape } : null;
    if (state.selected) nodeOf(state.selected)?.classList.add('selected');
    showHandles();
  }

  function remove(layer, shape) {
    const i = layer.shapes.indexOf(shape);
    if (i < 0) return false;
    layer.shapes.splice(i, 1);
    layer.nodes.get(shape)?.remove();
    layer.nodes.delete(shape);
    layer.composed.clear();
    if (state.selected?.shape === shape) select(null);
    return true;
  }

  function deleteSelected() {
    if (!state.selected) return false;
    const { layer, shape } = state.selected;
    if (!remove(layer, shape)) return false;
    changed();
    return true;
  }

  // Takes back the most recently added shape that's still there.
  function undo() {
    while (state.history.length) {
      const { layer, shape } = state.history.pop();
      if (remove(layer, shape)) {
        changed();
        return true;
      }
    }
    return false;
  }

  function clear() {
    for (const layer of state.layers) {
      if (!layer) continue;
      layer.editor?.cancel();
      for (const shape of layer.shapes) layer.nodes.get(shape)?.remove();
      layer.shapes = [];
      layer.nodes.clear();
      layer.composed.clear();
    }
    state.history = [];
    select(null);
    changed();
  }

  // The image with its shapes drawn in, as a blob of the given type. A PNG
  // without shapes is the original blob, untouched.
  function composed(index, blob, { type = 'image/png', quality } = {}) {
    const layer = state.layers[index];
    if (!layer?.shapes.length && type === 'image/png') return Promise.resolve(blob);
    const key = `${type}:${quality ?? ''}`;
    if (!layer.composed.has(key)) layer.composed.set(key, drawShapes(blob, layer.shapes, { type, quality }));
    return layer.composed.get(key);
  }

  // The shapes of every image, to save with the capture.
  function toJSON() {
    return state.layers.map((layer) => layer?.shapes ?? []);
  }

  return {
    attach,
    composed,
    count,
    undo,
    clear,
    deleteSelected,
    toJSON,
    deselect: () => select(null),
    get tool() {
      return state.tool;
    },
    set tool(value) {
      state.tool = value;
      select(null);
    },
    get color() {
      return state.color;
    },
    set color(value) {
      state.color = value;
    },
    get lineWidth() {
      return state.lineWidth;
    },
    set lineWidth(value) {
      state.lineWidth = value;
    },
  };
}

async function drawShapes(blob, shapes, { type, quality }) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  // JPEG has no transparency; anything see-through comes out white.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  // Mosaics go under the other shapes, as on the overlay.
  for (const shape of shapes) if (shape.type === 'mosaic') pixelate(ctx, shape);
  for (const shape of shapes) {
    if (shape.type === 'mosaic') continue;
    ctx.save();
    drawShape(ctx, shape);
    ctx.restore();
  }
  try {
    return await canvas.convertToBlob({ type, quality });
  } finally {
    // Frees the pixels now rather than whenever garbage collection runs.
    canvas.width = canvas.height = 0;
  }
}

function drawShape(ctx, shape) {
  switch (shape.type) {
    case 'box': {
      const inset = shape.lineWidth / 2;
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = shape.lineWidth;
      ctx.lineJoin = 'miter';
      ctx.strokeRect(shape.x + inset, shape.y + inset, Math.max(0, shape.width - shape.lineWidth), Math.max(0, shape.height - shape.lineWidth));
      break;
    }
    case 'arrow': {
      const { lineEnd, head } = arrowGeometry(shape);
      ctx.strokeStyle = shape.color;
      ctx.fillStyle = shape.color;
      ctx.lineWidth = shape.lineWidth;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(shape.x1, shape.y1);
      ctx.lineTo(lineEnd.x, lineEnd.y);
      ctx.stroke();
      ctx.beginPath();
      head.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'text': {
      ctx.font = `bold ${shape.fontSize}px ${FONT}`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = shape.color;
      ctx.strokeStyle = contrast(shape.color);
      ctx.lineWidth = textStroke(shape) * 2;
      ctx.lineJoin = 'round';
      textLines(shape).forEach((line, i) => {
        const y = shape.y + shape.fontSize * 0.9 + i * shape.fontSize * LINE_HEIGHT;
        ctx.strokeText(line, shape.x, y);
        ctx.fillText(line, shape.x, y);
      });
      break;
    }
    case 'number': {
      ctx.fillStyle = shape.color;
      ctx.strokeStyle = contrast(shape.color);
      ctx.lineWidth = shape.radius / 8;
      ctx.beginPath();
      ctx.arc(shape.x, shape.y, shape.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.font = `bold ${shape.radius * 1.2}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = contrast(shape.color);
      ctx.fillText(String(shape.number ?? ''), shape.x, shape.y);
      break;
    }
  }
}

// Replaces the area with blocks of its average colors.
function pixelate(ctx, shape) {
  const { x, y, width, height, block } = shape;
  if (!width || !height) return;
  const columns = Math.ceil(width / block);
  const rows = Math.ceil(height / block);
  const small = new OffscreenCanvas(columns, rows);
  const sctx = small.getContext('2d');
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(ctx.canvas, x, y, width, height, 0, 0, columns, rows);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, columns, rows, x, y, columns * block, rows * block);
  ctx.restore();
}
