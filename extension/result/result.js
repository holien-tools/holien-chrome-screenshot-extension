import { KEEP_LATEST, loadCapture } from '../lib/store.js';
import { COLORS, DEFAULT_LINE_WIDTH, LINE_WIDTHS, createAnnotator } from './annotate.js';

const ERROR_MESSAGES = {
  restricted: 'errorRestricted',
  tabHidden: 'errorTabHidden',
  notFound: 'errorNotFound',
  failed: 'errorFailed',
};

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
    if (capture) showCapture(capture);
    else showError('notFound');
  } catch (err) {
    showError('failed', err.message);
  } finally {
    document.body.dataset.state = 'ready';
  }
}

function showCapture(capture) {
  const name = capture.title || capture.url;
  document.title = `${name} – ${msg(capture.mode === 'area' ? 'areaResultTitle' : 'resultTitle')}`;
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

  const annotator = setUpTools(createAnnotator({ scale: capture.scale ?? 1, onChange: updateToolState }));

  const baseName = fileBaseName(capture);
  const total = capture.parts.length;
  // Each part's image with its boxes, for download and copy.
  const exports = capture.parts.map((part, i) => {
    const url = URL.createObjectURL(part.blob);
    const fileName = total > 1 ? `${baseName}_${i + 1}of${total}.png` : `${baseName}.png`;
    const blob = () => annotator.composed(i, part.blob);
    $('#parts').append(renderPart(part, url, fileName, i, total, blob, annotator));
    return { blob, fileName };
  });

  if (total === 1) {
    const button = $('#download');
    button.textContent = msg('download');
    button.addEventListener('click', () => downloadAll(exports));
    button.hidden = false;
    setUpCopy($('#copy'), exports[0].blob);
  } else {
    const button = $('#download-all');
    button.textContent = msg('downloadAll', total);
    button.addEventListener('click', () => downloadAll(exports));
    button.hidden = false;
  }
  $('#capture-view').hidden = false;
}

function renderPart(part, url, fileName, index, total, blob, annotator) {
  const figure = document.createElement('figure');
  figure.className = 'part';
  if (total > 1) {
    const caption = document.createElement('figcaption');
    const label = document.createElement('span');
    label.textContent = `${msg('partLabel', index + 1, total)} · ${msg('size', part.width, part.height)}`;
    const copy = Object.assign(document.createElement('button'), { type: 'button', className: 'link' });
    setUpCopy(copy, blob);
    const download = Object.assign(document.createElement('button'), {
      type: 'button',
      className: 'link',
      textContent: msg('download'),
    });
    download.addEventListener('click', () => downloadAll([{ blob, fileName }]));
    caption.append(label, copy, download);
    figure.append(caption);
  }
  const canvas = document.createElement('div');
  canvas.className = 'part-canvas';
  const img = Object.assign(document.createElement('img'), { src: url, alt: fileName, draggable: false });
  img.className = 'part-image';
  img.width = part.width;
  img.height = part.height;
  canvas.append(img);
  annotator.attach(canvas, img, index);
  figure.append(canvas);
  return figure;
}

// Wires the box drawing tools in the toolbar to the annotator.
function setUpTools(annotator) {
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
  updateToolState(0);
  return annotator;
}

function updateToolState(count) {
  $('#undo').disabled = count === 0;
  $('#clear').disabled = count === 0;
  $('#box-status').textContent = count ? msg('boxCount', count) : msg('boxesHint');
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
  for (const { blob, fileName } of exports) {
    const url = URL.createObjectURL(await blob());
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
