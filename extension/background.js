import { saveCapture } from './lib/store.js';

const HELPER_FILE = 'content/capture-helper.js';
const AREA_SELECT_FILE = 'content/area-select.js';
// chrome.tabs.captureVisibleTab is limited to 2 calls per second.
const MIN_CAPTURE_INTERVAL_MS = 550;
// Most screens per capture, for every page: pages that keep loading more
// content as they're scrolled (infinite scroll) never end, and very long pages
// would take a long time.
const MAX_FRAMES = 10;
// Tallest image (device pixels) per file. Taller pages are split into parts
// to stay well inside Chrome's canvas size and memory limits.
const MAX_PART_HEIGHT = 16384;
const BADGE_COLOR = '#2563eb';

const busyTabs = new Set();

class CaptureError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
  }
}

const COMMAND_MODES = { 'capture-full-page': 'full', 'capture-area': 'area' };

chrome.commands.onCommand.addListener((command, tab) => {
  if (tab && command in COMMAND_MODES) startCapture(tab, COMMAND_MODES[command]);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'capture') {
    // From the popup, which closes as soon as it hears back.
    chrome.tabs.get(message.tabId).then((tab) => startCapture(tab, message.mode));
  } else if (message.type === 'areaSelected' && sender.tab) {
    saveArea(sender.tab, message);
  }
  sendResponse(true);
});

function startCapture(tab, mode) {
  return mode === 'area' ? selectArea(tab) : captureFullPage(tab);
}

async function captureFullPage(tab) {
  if (busyTabs.has(tab.id)) return;
  busyTabs.add(tab.id);
  try {
    const id = await captureTab(tab);
    await openResult(tab, { id });
  } catch (err) {
    console.error('Full page capture failed:', err);
    await openResult(tab, { error: err.code || 'failed', detail: err.message });
  } finally {
    busyTabs.delete(tab.id);
    await setBadge(tab.id, '');
  }
}

// Freezes the visible part of the page and lets the user drag out the area to
// keep. The page sends the area back in an 'areaSelected' message, together
// with the screenshot, since this worker may be stopped while the user decides.
async function selectArea(tab) {
  if (busyTabs.has(tab.id)) return;
  try {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [AREA_SELECT_FILE] });
    } catch (err) {
      throw new CaptureError('restricted', err.message);
    }
    const image = await captureVisible(tab);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (image) => window.__holienAreaSelect?.start(image),
      args: [image],
    });
  } catch (err) {
    console.error('Area capture failed:', err);
    await openResult(tab, { error: err.code || 'failed', detail: err.message });
  }
}

async function saveArea(tab, { image, rect, viewportWidth, title, url }) {
  try {
    const id = await saveCapture({
      mode: 'area',
      title,
      url,
      createdAt: Date.now(),
      screens: 1,
      stoppedEarly: null,
      ...(await crop(image, rect, viewportWidth)),
    });
    await openResult(tab, { id });
  } catch (err) {
    console.error('Area capture failed:', err);
    await openResult(tab, { error: 'failed', detail: err.message });
  }
}

async function captureTab(tab) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [HELPER_FILE] });
  } catch (err) {
    throw new CaptureError('restricted', err.message);
  }

  await setBadge(tab.id, '0%');
  let page;
  let capture;
  try {
    page = await callHelper(tab.id, 'prepare');
    capture = await captureFrames(tab);
  } finally {
    await callHelper(tab.id, 'restore').catch(() => {});
  }

  await setBadge(tab.id, '…');
  const image = await stitch(capture.frames);
  return saveCapture({
    mode: 'full',
    title: page.title,
    url: page.url,
    createdAt: Date.now(),
    screens: capture.frames.length,
    stoppedEarly: capture.stoppedEarly,
    ...image,
  });
}

// Scrolls through the page one screen at a time and captures each screen.
async function captureFrames(tab) {
  const frames = [];
  // Set when the capture stops before the end: 'infiniteScroll' or 'tooLong'.
  let stoppedEarly = null;
  // Whether the page has loaded more content while being scrolled.
  let grew = false;
  let lastCaptureAt = 0;
  let y = 0;
  for (;;) {
    const view = await callHelper(tab.id, 'scrollTo', y);
    grew ||= view.grew;
    // The page refused to scroll any further.
    if (frames.length && view.pos <= frames.at(-1).pos) break;

    const isFirst = frames.length === 0;
    let isLast = view.pos >= view.maxPos - 1;
    if (!isLast && frames.length + 1 >= MAX_FRAMES) {
      isLast = true;
      stoppedEarly = grew ? 'infiniteScroll' : 'tooLong';
    }
    // Fixed headers only belong on the first screen, fixed footers on the last.
    await callHelper(tab.id, 'showFixed', { top: isFirst, bottom: isLast });

    await sleep(lastCaptureAt + MIN_CAPTURE_INTERVAL_MS - Date.now());
    const dataUrl = await captureVisible(tab);
    lastCaptureAt = Date.now();
    const frame = await toFrame(await (await fetch(dataUrl)).blob(), view);
    frames.push(frame);
    if (isLast) break;

    // Whichever comes first: the end of the page or the screen limit.
    const progress = Math.max(
      frames.length / MAX_FRAMES,
      (frame.pos + frame.height) / (view.maxPos + frame.height),
    );
    await setBadge(tab.id, `${Math.min(99, Math.round(progress * 100))}%`);
    y = frame.pos + frame.height;
  }
  return { frames, stoppedEarly };
}

// Records which part of a captured screen shows the scrolled content (in CSS
// pixels), clipped to what the screenshot actually contains.
async function toFrame(blob, { pos, rect, viewportWidth }) {
  const bitmap = await createImageBitmap(blob);
  const scale = bitmap.width / viewportWidth;
  const height = Math.min(rect.height, bitmap.height / scale - rect.y);
  bitmap.close();
  return { blob, pos, scale, x: rect.x, y: rect.y, width: rect.width, height };
}

async function captureVisible(tab) {
  await assertTabActive(tab.id);
  let dataUrl;
  for (let attempt = 1; !dataUrl; attempt++) {
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch (err) {
      if (attempt >= 4 || !String(err.message).includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) {
        throw err;
      }
      await sleep(attempt * 500);
    }
  }
  // captureVisibleTab grabs whatever tab is showing, so make sure it is still ours.
  await assertTabActive(tab.id);
  return dataUrl;
}

async function assertTabActive(tabId) {
  const { active } = await chrome.tabs.get(tabId);
  if (!active) throw new CaptureError('tabHidden');
}

// Crops each screen to the scrolled area and draws it at its scroll offset.
async function stitch(frames) {
  const [first] = frames;
  const offsetOf = (frame) => Math.round((frame.pos - first.pos) * first.scale);
  const last = frames.at(-1);
  const width = Math.round(first.width * first.scale);
  const height = offsetOf(last) + Math.round(last.height * last.scale);

  const parts = [];
  for (let top = 0; top < height; top += MAX_PART_HEIGHT) {
    const partHeight = Math.min(MAX_PART_HEIGHT, height - top);
    const canvas = new OffscreenCanvas(width, partHeight);
    const ctx = canvas.getContext('2d');
    for (const frame of frames) {
      const dy = offsetOf(frame) - top;
      const sh = Math.round(frame.height * frame.scale);
      if (dy >= partHeight || dy + sh <= 0) continue;
      const bitmap = await createImageBitmap(frame.blob);
      const sx = Math.round(frame.x * frame.scale);
      const sy = Math.round(frame.y * frame.scale);
      const sw = Math.min(Math.round(frame.width * frame.scale), bitmap.width - sx);
      ctx.drawImage(bitmap, sx, sy, sw, sh, 0, dy, sw, sh);
      bitmap.close();
    }
    parts.push({
      blob: await canvas.convertToBlob({ type: 'image/png' }),
      width,
      height: partHeight,
    });
  }
  return { width, height, parts };
}

// Cuts the selected area (CSS pixels) out of a screenshot of the visible page.
async function crop(dataUrl, rect, viewportWidth) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = bitmap.width / viewportWidth;
  const sx = Math.round(rect.x * scale);
  const sy = Math.round(rect.y * scale);
  const width = Math.min(Math.round((rect.x + rect.width) * scale), bitmap.width) - sx;
  const height = Math.min(Math.round((rect.y + rect.height) * scale), bitmap.height) - sy;
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(bitmap, sx, sy, width, height, 0, 0, width, height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { width, height, parts: [{ blob, width, height }] };
}

async function callHelper(tabId, method, arg = null) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (name, value) => window.__holienFullPageCapture?.[name](value) ?? null,
    args: [method, arg],
  });
  if (injection?.result == null) {
    throw new CaptureError('failed', `The page changed during capture (${method}).`);
  }
  return injection.result;
}

async function openResult(tab, params) {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value != null),
  );
  const url = chrome.runtime.getURL(`result/result.html?${query}`);
  try {
    await chrome.tabs.create({ url, windowId: tab.windowId, index: tab.index + 1, openerTabId: tab.id });
  } catch {
    // The page's tab or window is gone.
    await chrome.tabs.create({ url });
  }
}

async function setBadge(tabId, text) {
  try {
    if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
    await chrome.action.setBadgeText({ tabId, text });
  } catch {
    // The tab was closed.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
