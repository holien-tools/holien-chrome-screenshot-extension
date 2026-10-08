import { MAX_SCREENS, loadSettings, saveSettings, validMaxScreens } from '../lib/settings.js';

// Wait for a pause in typing before saving.
const SAVE_DELAY_MS = 300;

const $ = (selector) => document.querySelector(selector);
const msg = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;

main();

async function main() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = msg(el.dataset.i18n);
  $('#title').textContent = `${msg('extName')} · ${msg('settings')}`;
  document.title = $('#title').textContent;
  $('#max-screens-help').textContent = msg('maxScreensHelp', MAX_SCREENS.min, MAX_SCREENS.max);
  $('#reset').textContent = msg('resetDefault', MAX_SCREENS.default);

  const input = $('#max-screens');
  Object.assign(input, { min: MAX_SCREENS.min, max: MAX_SCREENS.max });
  input.value = (await loadSettings()).maxScreens;

  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const value = validMaxScreens(input.value);
    input.setAttribute('aria-invalid', value === null);
    if (value === null) {
      showStatus(msg('maxScreensInvalid', MAX_SCREENS.min, MAX_SCREENS.max), 'error');
      return;
    }
    showStatus('');
    timer = setTimeout(() => save(value), SAVE_DELAY_MS);
  });
  $('#reset').addEventListener('click', () => {
    clearTimeout(timer);
    input.value = MAX_SCREENS.default;
    input.setAttribute('aria-invalid', false);
    save(MAX_SCREENS.default);
  });
  document.body.dataset.state = 'ready';
}

async function save(maxScreens) {
  try {
    await saveSettings({ maxScreens });
    showStatus(msg('saved'), 'saved');
  } catch (err) {
    console.error('Saving settings failed:', err);
    showStatus(msg('saveFailed'), 'error');
  }
}

function showStatus(text, kind = '') {
  const status = $('#status');
  status.textContent = text;
  status.className = kind;
}
