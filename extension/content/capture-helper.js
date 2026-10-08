// Injected into the page by background.js. Exposes the page-side steps of a
// full page capture on window.__stwFullPageCapture (in the extension's
// isolated world, so the page can't see or break it).
(() => {
  if (window.__stwFullPageCapture) return;

  // Below this window scroll range (as a fraction of the viewport height) the
  // page is treated as not scrolling, and an inner scroll container is used
  // instead if there is one (app layouts like Gmail scroll a <div>, not the window).
  const MIN_WINDOW_SCROLL_RATIO = 0.25;
  // An inner scroll container must cover at least this much of the viewport.
  const MIN_INNER_SCROLLER_AREA = 0.3;
  // How long to wait for images that are still loading (lazy loading) on each screen.
  const IMAGE_WAIT_MS = 1500;

  let state = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // requestAnimationFrame never fires in a hidden tab, so don't wait forever.
  const nextFrame = () =>
    Promise.race([new Promise((resolve) => requestAnimationFrame(() => resolve())), sleep(100)]);

  const rootScroller = () => document.scrollingElement || document.documentElement;

  function* allElements(root = document) {
    for (const el of root.querySelectorAll('*')) {
      yield el;
      if (el.shadowRoot) yield* allElements(el.shadowRoot);
    }
  }

  function visibleArea(rect) {
    const width = Math.min(rect.right, innerWidth) - Math.max(rect.left, 0);
    const height = Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0);
    return width > 0 && height > 0 ? width * height : 0;
  }

  function overrideStyle(el, prop, value) {
    state.overrides.push([el, prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
    el.style.setProperty(prop, value, 'important');
  }

  function saveProp(el, prop) {
    return [prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
  }

  function restoreProp(el, [prop, value, priority]) {
    if (value) el.style.setProperty(prop, value, priority);
    else el.style.removeProperty(prop);
  }

  function setHidden(entry, hidden) {
    if (entry.hidden === hidden) return false;
    entry.hidden = hidden;
    if (hidden) {
      entry.el.style.setProperty('opacity', '0', 'important');
      entry.el.style.setProperty('transition-property', 'none', 'important');
    } else {
      entry.saved.forEach((saved) => restoreProp(entry.el, saved));
    }
    return true;
  }

  function findInnerScroller(candidates) {
    const root = rootScroller();
    const windowRange = root.scrollHeight - root.clientHeight;
    if (windowRange > innerHeight * MIN_WINDOW_SCROLL_RATIO) return null;

    let best = null;
    let bestArea = innerWidth * innerHeight * MIN_INNER_SCROLLER_AREA;
    for (const el of candidates) {
      if (el.scrollHeight - el.clientHeight <= Math.max(windowRange, 1)) continue;
      const area = visibleArea(el.getBoundingClientRect());
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  // The part of the viewport (CSS pixels) that shows the scrolled content.
  function captureRect(target) {
    if (!target) {
      const root = rootScroller();
      return { x: 0, y: 0, width: root.clientWidth, height: root.clientHeight };
    }
    const r = target.getBoundingClientRect();
    const left = r.left + target.clientLeft;
    const top = r.top + target.clientTop;
    const x = Math.max(0, left);
    const y = Math.max(0, top);
    return {
      x,
      y,
      width: Math.min(innerWidth, left + target.clientWidth) - x,
      height: Math.min(innerHeight, top + target.clientHeight) - y,
    };
  }

  function prepare() {
    if (state) restore();
    state = { overrides: [], fixed: [], target: null, scrollX, scrollY, targetScrollTop: 0 };

    // Jump instead of animating when scrolling, and keep scrollbars out of the picture.
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      overrideStyle(el, 'scroll-behavior', 'auto');
      overrideStyle(el, 'scrollbar-width', 'none');
    }

    // Read everything first, then write, so the page is laid out only once.
    const sticky = [];
    const scrollable = [];
    for (const el of allElements()) {
      const style = getComputedStyle(el);
      if (style.position === 'sticky') {
        sticky.push(el);
      } else if (style.position === 'fixed') {
        const rect = el.getBoundingClientRect();
        state.fixed.push({
          el,
          atBottom: rect.top + rect.bottom > innerHeight,
          hidden: false,
          saved: [saveProp(el, 'opacity'), saveProp(el, 'transition-property')],
        });
      }
      if (/auto|scroll|overlay/.test(style.overflowY) && el.scrollHeight > el.clientHeight) {
        scrollable.push(el);
      }
    }

    const target = findInnerScroller(scrollable);
    if (target) {
      state.target = target;
      state.targetScrollTop = target.scrollTop;
      overrideStyle(target, 'scroll-behavior', 'auto');
      overrideStyle(target, 'scrollbar-width', 'none');
    }

    // Lay sticky elements out where they sit in the document, instead of
    // pinning them to the top of every screen.
    for (const el of sticky) {
      overrideStyle(el, 'position', 'relative');
      for (const side of ['top', 'right', 'bottom', 'left']) overrideStyle(el, side, 'auto');
    }

    // Only what is loaded now gets captured. Pages that load more as you
    // scroll (infinite scroll) would otherwise never end.
    state.height = (target || rootScroller()).scrollHeight;

    return { title: document.title, url: location.href };
  }

  async function settle() {
    await nextFrame();
    await nextFrame();
    const loading = [...document.images].filter(
      (img) => !img.complete && visibleArea(img.getBoundingClientRect()) > 0,
    );
    if (!loading.length) return;
    const loaded = loading.map(
      (img) =>
        new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        }),
    );
    await Promise.race([Promise.all(loaded), sleep(IMAGE_WAIT_MS)]);
    await nextFrame();
  }

  async function scrollTo(y) {
    const { target } = state;
    const scroller = target || rootScroller();
    // Don't scroll past the height the page had when the capture started.
    const maxPos = () => Math.min(scroller.scrollHeight, state.height) - scroller.clientHeight;
    const top = Math.min(y, maxPos());
    // 'instant' also cancels a smooth scroll the page may still be running.
    if (target) target.scrollTo({ top, behavior: 'instant' });
    else window.scrollTo({ left: state.scrollX, top, behavior: 'instant' });
    await settle();

    // Measured on every screen in case the window is resized mid-capture.
    return {
      pos: target ? target.scrollTop : window.scrollY,
      maxPos: maxPos(),
      grew: scroller.scrollHeight > state.height,
      rect: captureRect(target),
      viewportWidth: innerWidth,
    };
  }

  async function showFixed({ top, bottom }) {
    let changed = false;
    for (const entry of state.fixed) {
      if (setHidden(entry, !(entry.atBottom ? bottom : top))) changed = true;
    }
    if (changed) {
      await nextFrame();
      await nextFrame();
    }
    return true;
  }

  function restore() {
    if (!state) return true;
    for (const entry of state.fixed) setHidden(entry, false);
    state.target?.scrollTo({ top: state.targetScrollTop, behavior: 'instant' });
    window.scrollTo({ left: state.scrollX, top: state.scrollY, behavior: 'instant' });
    for (const [el, prop, value, priority] of state.overrides.reverse()) {
      restoreProp(el, [prop, value, priority]);
    }
    state = null;
    return true;
  }

  window.__stwFullPageCapture = { prepare, scrollTo, showFixed, restore };
})();
