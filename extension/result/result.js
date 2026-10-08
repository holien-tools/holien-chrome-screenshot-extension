import { KEEP_LATEST, loadCapture } from '../lib/store.js';

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
  document.title = `${name} – ${msg('resultTitle')}`;
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
  if (capture.truncated) notices.push(msg('truncatedNotice', capture.screens));
  $('#notices').replaceChildren(
    ...notices.map((text) => Object.assign(document.createElement('li'), { textContent: text })),
  );

  const baseName = fileBaseName(capture);
  const total = capture.parts.length;
  const downloads = capture.parts.map((part, i) => {
    const url = URL.createObjectURL(part.blob);
    const fileName = total > 1 ? `${baseName}_${i + 1}of${total}.png` : `${baseName}.png`;
    $('#parts').append(renderPart(part, url, fileName, i, total));
    return { url, fileName };
  });

  if (total === 1) {
    const button = $('#download');
    button.textContent = msg('download');
    button.href = downloads[0].url;
    button.download = downloads[0].fileName;
    button.hidden = false;
  } else {
    const button = $('#download-all');
    button.textContent = msg('downloadAll', total);
    button.addEventListener('click', () => downloadAll(downloads));
    button.hidden = false;
  }
  $('#capture-view').hidden = false;
}

function renderPart(part, url, fileName, index, total) {
  const figure = document.createElement('figure');
  figure.className = 'part';
  if (total > 1) {
    const caption = document.createElement('figcaption');
    const label = document.createElement('span');
    label.textContent = `${msg('partLabel', index + 1, total)} · ${msg('size', part.width, part.height)}`;
    const link = Object.assign(document.createElement('a'), {
      href: url,
      download: fileName,
      textContent: msg('download'),
    });
    caption.append(label, link);
    figure.append(caption);
  }
  const img = Object.assign(document.createElement('img'), { src: url, alt: fileName });
  img.className = 'part-image';
  img.width = part.width;
  img.height = part.height;
  figure.append(img);
  return figure;
}

async function downloadAll(downloads) {
  for (const { url, fileName } of downloads) {
    Object.assign(document.createElement('a'), { href: url, download: fileName }).click();
    // Chrome may drop downloads that start in the same instant.
    await new Promise((resolve) => setTimeout(resolve, 300));
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
