// Boxes the user draws over the screenshots on the result page, and merging
// them into the images for download and copy.
//
// Each image gets an SVG overlay that scales with it. Boxes are kept in image
// pixels, so the overlay and the merged image come out the same.

const SVG_NS = 'http://www.w3.org/2000/svg';

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
// multiplied by the capture's pixel scale so they look the same on every screen.
export const LINE_WIDTHS = [
  ['lineThin', 2],
  ['lineMedium', 4],
  ['lineThick', 8],
];
export const DEFAULT_LINE_WIDTH = 4;

// Boxes smaller than this (in CSS pixels) are taken for clicks, not drags.
const MIN_BOX = 4;
// How far from a line a click still selects its box, in CSS pixels.
const HIT_PADDING = 6;

// Creates the drawing state shared by all the images of a capture. onChange is
// called whenever a box is added or removed.
export function createAnnotator({ scale = 1, onChange }) {
  const state = {
    color: COLORS[0][1],
    lineWidth: DEFAULT_LINE_WIDTH,
    layers: [],
    selected: null,
    history: [],
  };
  const changed = () => onChange?.(count());
  const count = () => state.layers.reduce((n, layer) => n + layer.boxes.length, 0);

  // Puts a drawing overlay over the image, which must already be in container.
  function attach(container, img, index) {
    const width = Number(img.getAttribute('width'));
    const height = Number(img.getAttribute('height'));
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.classList.add('boxes');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    container.append(svg);
    // Keys (Delete, Ctrl+Z) go to the image the user last drew on.
    container.tabIndex = -1;
    const layer = { index, width, height, img, svg, boxes: [], composed: null };
    state.layers[index] = layer;

    const toImage = (event) => {
      const rect = img.getBoundingClientRect();
      const clamp = (n, max) => Math.min(Math.max(Math.round(n), 0), max);
      return {
        x: clamp(((event.clientX - rect.left) * width) / rect.width, width),
        y: clamp(((event.clientY - rect.top) * height) / rect.height, height),
      };
    };

    container.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      container.focus({ preventScroll: true });
      const hit = event.target.closest?.('.box');
      if (hit) {
        select(layer.boxes.find((box) => box.element === hit));
        return;
      }
      select(null);
      const start = toImage(event);
      const box = {
        ...start,
        width: 0,
        height: 0,
        color: state.color,
        lineWidth: Math.max(1, Math.round(state.lineWidth * scale)),
      };
      const element = renderBox(box);
      element.classList.add('drawing');
      svg.append(element);

      const move = (event) => {
        const point = toImage(event);
        box.x = Math.min(start.x, point.x);
        box.y = Math.min(start.y, point.y);
        box.width = Math.abs(point.x - start.x);
        box.height = Math.abs(point.y - start.y);
        updateBox(element, box);
      };
      const pointerId = event.pointerId;
      const finish = (keep) => {
        container.removeEventListener('pointermove', move);
        container.removeEventListener('pointerup', onUp);
        container.removeEventListener('pointercancel', onCancel);
        document.removeEventListener('keydown', onKey);
        try {
          container.releasePointerCapture(pointerId);
        } catch {
          // The pointer is already gone.
        }
        element.classList.remove('drawing');
        const min = Math.max(MIN_BOX * scale, box.lineWidth);
        if (!keep || box.width < min || box.height < min) {
          element.remove();
          return;
        }
        box.element = element;
        layer.boxes.push(box);
        layer.composed = null;
        state.history.push({ layer, box });
        changed();
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);
      const onKey = (event) => {
        if (event.key === 'Escape') finish(false);
      };
      container.setPointerCapture(pointerId);
      container.addEventListener('pointermove', move);
      container.addEventListener('pointerup', onUp);
      container.addEventListener('pointercancel', onCancel);
      document.addEventListener('keydown', onKey);
    });

    return layer;
  }

  function renderBox(box) {
    const element = document.createElementNS(SVG_NS, 'g');
    element.classList.add('box');
    const hit = document.createElementNS(SVG_NS, 'rect');
    hit.classList.add('hit');
    const line = document.createElementNS(SVG_NS, 'rect');
    line.classList.add('line');
    element.append(hit, line);
    updateBox(element, box);
    return element;
  }

  // The line is drawn inside the dragged rectangle, so a box along the edge of
  // the image keeps its whole line.
  function updateBox(element, box) {
    const inset = box.lineWidth / 2;
    const attrs = {
      x: box.x + inset,
      y: box.y + inset,
      width: Math.max(0, box.width - box.lineWidth),
      height: Math.max(0, box.height - box.lineWidth),
    };
    for (const rect of element.children) {
      for (const [name, value] of Object.entries(attrs)) rect.setAttribute(name, value);
    }
    const [hit, line] = element.children;
    hit.setAttribute('stroke-width', box.lineWidth + 2 * HIT_PADDING * scale);
    line.setAttribute('stroke', box.color);
    line.setAttribute('stroke-width', box.lineWidth);
  }

  function select(box) {
    state.selected?.element.classList.remove('selected');
    state.selected = box ?? null;
    box?.element.classList.add('selected');
  }

  function remove(layer, box) {
    const i = layer.boxes.indexOf(box);
    if (i < 0) return false;
    layer.boxes.splice(i, 1);
    layer.composed = null;
    box.element.remove();
    if (state.selected === box) state.selected = null;
    return true;
  }

  function deleteSelected() {
    const box = state.selected;
    if (!box) return false;
    const layer = state.layers.find((layer) => layer?.boxes.includes(box));
    if (!layer || !remove(layer, box)) return false;
    changed();
    return true;
  }

  // Takes back the most recently drawn box that's still there.
  function undo() {
    while (state.history.length) {
      const { layer, box } = state.history.pop();
      if (remove(layer, box)) {
        changed();
        return true;
      }
    }
    return false;
  }

  function clear() {
    for (const layer of state.layers) {
      if (!layer) continue;
      for (const box of layer.boxes) box.element.remove();
      layer.boxes = [];
      layer.composed = null;
    }
    state.selected = null;
    state.history = [];
    changed();
  }

  // The image with its boxes drawn in, as a PNG blob. Without boxes it's the
  // original blob, untouched.
  function composed(index, blob) {
    const layer = state.layers[index];
    if (!layer?.boxes.length) return Promise.resolve(blob);
    layer.composed ??= drawBoxes(blob, layer.boxes);
    return layer.composed;
  }

  return {
    attach,
    composed,
    count,
    undo,
    clear,
    deleteSelected,
    deselect: () => select(null),
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

async function drawBoxes(blob, boxes) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  for (const box of boxes) {
    const inset = box.lineWidth / 2;
    ctx.strokeStyle = box.color;
    ctx.lineWidth = box.lineWidth;
    ctx.lineJoin = 'miter';
    ctx.strokeRect(
      box.x + inset,
      box.y + inset,
      Math.max(0, box.width - box.lineWidth),
      Math.max(0, box.height - box.lineWidth),
    );
  }
  try {
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    // Frees the pixels now rather than whenever garbage collection runs.
    canvas.width = canvas.height = 0;
  }
}
