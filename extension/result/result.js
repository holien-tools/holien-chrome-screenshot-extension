import { KEEP_LATEST, loadCapture, saveAnnotations } from '../lib/store.js';
import { FORMATS, JPEG_QUALITY, loadSettings, saveSettings } from '../lib/settings.js';
import { COLORS, DEFAULT_LINE_WIDTH, LINE_WIDTHS, TOOLS, createAnnotator } from './annotate.js';

const ERROR_MESSAGES = {
  restricted: 'errorRestricted',
  tabHidden: 'errorTabHidden',
  notFound: 'errorNotFound',
  failed: 'errorFailed',
};

const TOOL_KEYS = { box: 'toolBox', arrow: 'toolArrow', text: 'toolText', number: 'toolNumber', mosaic: 'toolMosaic' };

// Annotations are saved this long after the last change.
const SAVE_DELAY_MS = 300;

const $ = (selector) => document.querySelector(selector);
const msg = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;

main();

async function main() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = msg(el.dataset.i18n);
  document.title = msg('resultTitle');

  const params = new URLSearchParams(location.search);
  try {
    if (params.has('error')) {
      showError(params.get('error'), params.get('detail'));
      return;
    }
    const id = Number(params.get('id'));
    const capture = Number.isInteger(id) ? await loadCapture(id) : null;
    if (capture) showCapture(id, capture, await loadSettings());
    else showError('notFound');
  } catch (err) {
    showError('failed', err.message);
  } finally {
    document.body.dataset.state = 'ready';
  }
}

function showCapture(id, capture, settings) {
  const name = capture.title || capture.url;
  const titles = { area: 'areaResultTitle', visible: 'visibleResultTitle' };
  document.title = `${name} – ${msg(titles[capture.mode] ?? 'resultTitle')}`;
  $('#page-title').textContent = name;
  const link = $('#page-url');
  link.textContent = capture.url;
  if (/^(https?|file):/.test(capture.url)) link.href = capture.url;
  $('#summary').textContent = msg(
    'summary',
    capture.width,
    capture.height,
    new Date(capture.createdAt).toLocaleString(chrome.i18n.getUILanguage()),
  );

  const notices = [];
  if (capture.parts.length > 1) notices.push(msg('splitNotice', capture.parts.length));
  if (capture.stoppedEarly === 'infiniteScroll') notices.push(msg('infiniteScrollNotice', capture.screens));
  if (capture.stoppedEarly === 'tooLong') notices.push(msg('tooLongNotice', capture.screens));
  $('#notices').replaceChildren(
    ...notices.map((text) => Object.assign(document.createElement('li'), { textContent: text })),
  );

  let saveTimer;
  const annotator = createAnnotator({
    scale: capture.scale ?? 1,
    onChange(count) {
      updateToolState(count);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveAnnotations(id, annotator.toJSON()).catch((err) => console.error('Saving annotations failed:', err)), SAVE_DELAY_MS);
    },
  });
  setUpTools(annotator);
  const output = setUpExport(settings);

  const baseName = fileBaseName(capture);
  const total = capture.parts.length;
  // Each part's image with its annotations, for download and copy.
  const exports = capture.parts.map((part, i) => {
    const url = URL.createObjectURL(part.blob);
    const fileName = (extension) => (total > 1 ? `${baseName}_${i + 1}of${total}.${extension}` : `${baseName}.${extension}`);
    const png = () => annotator.composed(i, part.blob);
    const download = () => {
      const format = FORMATS[output.format];
      const options = output.format === 'jpeg' ? { type: format.type, quality: output.jpegQuality / 100 } : {};
      return { blob: annotator.composed(i, part.blob, options), fileName: fileName(format.extension) };
    };
    $('#parts').append(renderPart(part, url, fileName('png'), i, total, png, download, annotator, capture.annotations?.[i] ?? []));
    return { png, download };
  });
  updateToolState(annotator.count());

  if (total === 1) {
    const button = $('#download');
    output.labels.push(button);
    button.addEventListener('click', () => downloadAll(exports));
    button.hidden = false;
    setUpCopy($('#copy'), exports[0].png);
  } else {
    const button = $('#download-all');
    button.textContent = msg('downloadAll', total);
    button.addEventListener('click', () => downloadAll(exports));
    button.hidden = false;
  }
  output.refresh();
  $('#capture-view').hidden = false;
}

function renderPart(part, url, altText, index, total, png, download, annotator, shapes) {
  const figure = document.createElement('figure');
  figure.className = 'part';
  if (total > 1) {
    const caption = document.createElement('figcaption');
    const label = document.createElement('span');
    label.textContent = `${msg('partLabel', index + 1, total)} · ${msg('size', part.width, part.height)}`;
    const copy = Object.assign(document.createElement('button'), { type: 'button', className: 'link' });
    setUpCopy(copy, png);
    const link = Object.assign(document.createElement('button'), { type: 'button', className: 'link download-part' });
    link.addEventListener('click', () => downloadAll([{ download }]));
    caption.append(label, copy, link);
    figure.append(caption);
  }
  const canvas = document.createElement('div');
  canvas.className = 'part-canvas';
  const img = Object.assign(document.createElement('img'), { src: url, alt: altText, draggable: false });
  img.className = 'part-image';
  img.width = part.width;
  img.height = part.height;
  canvas.append(img);
  figure.append(canvas);
  annotator.attach(canvas, img, index, shapes);
  return figure;
}

// Wires the format and quality controls, and keeps the download labels in
// step with them. The choice is saved with the settings.
function setUpExport(settings) {
  const output = { format: settings.format, jpegQuality: settings.jpegQuality, labels: [], refresh };
  const format = $('#format');
  for (const [key, { label }] of Object.entries(FORMATS)) {
    format.append(Object.assign(document.createElement('option'), { value: key, textContent: label }));
  }
  format.value = output.format;
  const quality = $('#quality');
  quality.min = JPEG_QUALITY.min;
  quality.max = JPEG_QUALITY.max;
  quality.step = JPEG_QUALITY.step;
  quality.value = output.jpegQuality;

  function refresh() {
    $('#quality-field').hidden = output.format !== 'jpeg';
    $('#quality-value').value = `${output.jpegQuality}%`;
    const text = msg('downloadAs', FORMATS[output.format].label);
    for (const label of output.labels) label.textContent = text;
    for (const link of document.querySelectorAll('.download-part')) link.textContent = text;
    document.body.dataset.format = output.format;
  }
  const save = () => saveSettings({ format: output.format, jpegQuality: output.jpegQuality }).catch((err) => console.error('Saving settings failed:', err));
  format.addEventListener('change', () => {
    output.format = format.value in FORMATS ? format.value : 'png';
    refresh();
    save();
  });
  quality.addEventListener('input', () => {
    output.jpegQuality = Number(quality.value);
    refresh();
  });
  quality.addEventListener('change', save);
  return output;
}

// Wires the annotation tools in the toolbar to the annotator.
function setUpTools(annotator) {
  const tools = $('#tool-buttons');
  const showTool = () => {
    for (const button of tools.children) button.setAttribute('aria-checked', button.dataset.tool === annotator.tool);
    document.body.dataset.tool = annotator.tool;
  };
  for (const tool of TOOLS) {
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'tool', textContent: msg(TOOL_KEYS[tool]) });
    button.dataset.tool = tool;
    button.setAttribute('role', 'radio');
    button.addEventListener('click', () => {
      annotator.tool = tool;
      showTool();
    });
    tools.append(button);
  }
  showTool();

  const swatches = $('#swatches');
  const custom = $('#custom-color');
  const customLabel = custom.closest('label');
  const showColor = () => {
    for (const button of swatches.children) {
      button.setAttribute('aria-checked', button.dataset.color === annotator.color);
    }
    customLabel.classList.toggle('selected', !COLORS.some(([, color]) => color === annotator.color));
    customLabel.style.setProperty('--color', custom.value);
  };
  for (const [key, color] of COLORS) {
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'swatch' });
    button.dataset.color = color;
    button.style.setProperty('--color', color);
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-label', msg(key));
    button.title = msg(key);
    button.addEventListener('click', () => {
      annotator.color = color;
      showColor();
    });
    swatches.append(button);
  }
  custom.addEventListener('input', () => {
    annotator.color = custom.value;
    showColor();
  });
  showColor();

  const widths = $('#line-width');
  for (const [key, width] of LINE_WIDTHS) {
    widths.append(Object.assign(document.createElement('option'), { value: width, textContent: msg(key) }));
  }
  widths.value = DEFAULT_LINE_WIDTH;
  widths.addEventListener('change', () => (annotator.lineWidth = Number(widths.value)));

  $('#undo').addEventListener('click', () => annotator.undo());
  $('#clear').addEventListener('click', () => annotator.clear());
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (target.matches?.('input, select, textarea, a, button')) return;
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
      if (annotator.undo()) event.preventDefault();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      if (annotator.deleteSelected()) event.preventDefault();
    } else if (event.key === 'Escape') {
      annotator.deselect();
    }
  });
}

function updateToolState(count) {
  $('#undo').disabled = count === 0;
  $('#clear').disabled = count === 0;
  $('#shape-status').textContent = count ? msg('shapeCount', count) : msg('annotateHint');
}

function setUpCopy(button, blob) {
  button.textContent = msg('copy');
  button.hidden = false;
  let timer;
  button.addEventListener('click', async () => {
    clearTimeout(timer);
    try {
      const image = await blob();
      await navigator.clipboard.write([new ClipboardItem({ [image.type]: image })]);
      button.textContent = msg('copied');
    } catch (err) {
      console.error('Copy failed:', err);
      button.textContent = msg('copyFailed');
    }
    timer = setTimeout(() => (button.textContent = msg('copy')), 2000);
  });
}

async function downloadAll(exports) {
  for (const { download } of exports) {
    const { blob, fileName } = download();
    const url = URL.createObjectURL(await blob);
    Object.assign(document.createElement('a'), { href: url, download: fileName }).click();
    // Chrome may drop downloads that start in the same instant.
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The download has the blob by now; the URL isn't needed any longer.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

function fileBaseName({ url, createdAt }) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // Keep the default name.
  }
  const d = new Date(createdAt);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `screenshot_${host.replace(/[^a-z0-9.-]/gi, '_') || 'page'}_${stamp}`;
}

function showError(code, detail) {
  const view = $('#error-view');
  view.dataset.error = code in ERROR_MESSAGES ? code : 'failed';
  $('#error-message').textContent = msg(ERROR_MESSAGES[view.dataset.error], KEEP_LATEST);
  if (detail) {
    $('#error-detail').textContent = detail;
    $('#error-details').hidden = false;
  }
  view.hidden = false;
}
