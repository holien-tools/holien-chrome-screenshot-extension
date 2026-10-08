const COMMANDS = { full: 'capture-full-page', area: 'capture-area' };

const msg = (key) => chrome.i18n.getMessage(key) || key;

main();

async function main() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = msg(el.dataset.i18n);

  const shortcuts = Object.fromEntries((await chrome.commands.getAll()).map((c) => [c.name, c.shortcut]));
  for (const button of document.querySelectorAll('button[data-mode]')) {
    const { mode } = button.dataset;
    const shortcut = shortcuts[COMMANDS[mode]];
    if (shortcut) Object.assign(button.querySelector('kbd'), { textContent: shortcut, hidden: false });
    button.addEventListener('click', () => start(mode));
  }
}

async function start(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // The capture runs in background.js; the popup has to close first so it
  // doesn't sit over the page.
  await chrome.runtime.sendMessage({ type: 'capture', mode, tabId: tab.id });
  window.close();
}
