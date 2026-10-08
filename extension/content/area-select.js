// Injected into the page by background.js. Covers the page with a frozen
// screenshot of what's visible and lets the user drag out the area to capture
// (window.__holienAreaSelect, in the extension's isolated world). The area is
// sent back to background.js in an 'areaSelected' message.
(() => {
  if (window.__holienAreaSelect) return;

  // Smaller drags (CSS pixels) are treated as clicks and ignored.
  const MIN_SIZE = 4;

  const STYLE = `
    .frame {
      position: absolute;
      inset: 0;
      overflow: hidden;
      outline: none;
      cursor: crosshair;
      user-select: none;
      touch-action: none;
    }
    canvas {
      position: absolute;
      top: 0;
      left: 0;
    }
    .shade {
      position: absolute;
      inset: 0;
      background: rgb(0 0 0 / 0.4);
    }
    .box {
      position: absolute;
      outline: 1px solid #fff;
      box-shadow: 0 0 0 100vmax rgb(0 0 0 / 0.4);
    }
    .hint,
    .size {
      position: absolute;
      border-radius: 6px;
      background: rgb(0 0 0 / 0.75);
      color: #fff;
      font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', 'PingFang TC', 'Microsoft JhengHei',
        'Noto Sans TC', sans-serif;
      white-space: nowrap;
      pointer-events: none;
    }
    .hint {
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      padding: 8px 14px;
    }
    .size {
      padding: 2px 8px;
      font-size: 12px;
    }
  `;

  // Takes down the selection on screen; set while there is one.
  let close = null;

  const el = (tag, className) => Object.assign(document.createElement(tag), { className });

  async function start(image) {
    if (close) return true;
    close = () => {};
    let bitmap;
    try {
      const bytes = Uint8Array.from(atob(image.slice(image.indexOf(',') + 1)), (c) => c.charCodeAt(0));
      bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    } catch (err) {
      close = null;
      throw err;
    }
    const viewport = { width: innerWidth, height: innerHeight };
    // Device pixels per CSS pixel in the screenshot.
    const scale = bitmap.width / viewport.width;

    // A custom element, so page styles aimed at divs don't reach it.
    const host = document.createElement('holien-area-select');
    host.style.cssText = `
      all: initial !important;
      position: fixed !important;
      inset: 0 !important;
      z-index: 2147483647 !important;
    `;
    const root = host.attachShadow({ mode: 'closed' });
    const frame = el('div', 'frame');
    frame.tabIndex = -1;
    const canvas = el('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    const shade = el('div', 'shade');
    const box = el('div', 'box');
    const size = el('div', 'size');
    const hint = el('div', 'hint');
    hint.textContent = chrome.i18n.getMessage('areaHint');
    box.hidden = size.hidden = true;
    frame.append(canvas, shade, box, size, hint);
    root.append(Object.assign(document.createElement('style'), { textContent: STYLE }), frame);
    document.documentElement.append(host);
    // The top layer keeps it above full screen elements and open dialogs too.
    if (host.showPopover) {
      host.popover = 'manual';
      host.showPopover();
    }
    // Take the focus (an iframe may have it) so Esc reaches us, and give it back after.
    const focused = document.activeElement;
    frame.focus({ preventScroll: true });

    let origin = null;
    let rect = null;

    const point = (event) => ({
      x: Math.min(Math.max(event.clientX, 0), frame.clientWidth),
      y: Math.min(Math.max(event.clientY, 0), frame.clientHeight),
    });

    function draw() {
      const big = rect.width >= MIN_SIZE && rect.height >= MIN_SIZE;
      shade.hidden = big;
      box.hidden = size.hidden = !big;
      hint.hidden = true;
      Object.assign(box.style, {
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      size.textContent = `${Math.round(rect.width * scale)} × ${Math.round(rect.height * scale)}`;
      // Above the box, or inside it when there's no room above.
      size.style.left = `${rect.x}px`;
      size.style.top = rect.y >= 28 ? `${rect.y - 28}px` : `${rect.y + 4}px`;
    }

    function reset() {
      origin = rect = null;
      shade.hidden = hint.hidden = false;
      box.hidden = size.hidden = true;
    }

    const handlers = {
      pointerdown(event) {
        if (event.button !== 0) return;
        event.preventDefault();
        frame.setPointerCapture(event.pointerId);
        origin = point(event);
        rect = { ...origin, width: 0, height: 0 };
      },
      pointermove(event) {
        if (!origin) return;
        const p = point(event);
        rect = {
          x: Math.min(origin.x, p.x),
          y: Math.min(origin.y, p.y),
          width: Math.abs(p.x - origin.x),
          height: Math.abs(p.y - origin.y),
        };
        draw();
      },
      pointerup() {
        if (!origin) return;
        if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) {
          reset();
          return;
        }
        finish();
        chrome.runtime.sendMessage({
          type: 'areaSelected',
          image,
          rect,
          viewportWidth: viewport.width,
          title: document.title,
          url: location.href,
        });
      },
      pointercancel: reset,
      // Keep the page underneath from scrolling while it's covered.
      wheel: (event) => event.preventDefault(),
      contextmenu: (event) => event.preventDefault(),
    };

    // Keys are the user's to cancel with, not the page's.
    function onKey(event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'keydown' && event.key === 'Escape') finish();
    }

    // The screenshot no longer matches the page.
    function onResize() {
      if (innerWidth !== viewport.width || innerHeight !== viewport.height) finish();
    }

    function finish() {
      for (const [type, handler] of Object.entries(handlers)) frame.removeEventListener(type, handler);
      removeEventListener('keydown', onKey, true);
      removeEventListener('keyup', onKey, true);
      removeEventListener('resize', onResize);
      host.remove();
      focused?.focus({ preventScroll: true });
      close = null;
    }

    for (const [type, handler] of Object.entries(handlers)) {
      frame.addEventListener(type, handler, { passive: false });
    }
    addEventListener('keydown', onKey, true);
    addEventListener('keyup', onKey, true);
    addEventListener('resize', onResize);
    close = finish;
    return true;
  }

  window.__holienAreaSelect = { start, cancel: () => close?.() };
})();
