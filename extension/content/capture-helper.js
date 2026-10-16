// Injected into the page by background.js. Exposes the page-side steps of a
// full page capture on window.__holienFullPageCapture (in the extension's
// isolated world, so the page can't see or break it).
(() => {
  if (window.__holienFullPageCapture) return;

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

  const rootScrollerOf = (doc) => doc.scrollingElement || doc.documentElement;
  const rootScroller = () => rootScrollerOf(document);
  const windowOf = (el) => el.ownerDocument.defaultView;

  // The document inside a frame, when it's same-origin and can be looked into.
  // Many consoles (AWS, for one) put the page that actually scrolls in one.
  function frameDocument(el) {
    if (el.localName !== 'iframe' && el.localName !== 'frame') return null;
    try {
      return el.contentDocument;
    } catch {
      return null;
    }
  }

  // Every element of the page, including those in shadow roots and in
  // same-origin frames.
  function* allElements(root = document) {
    for (const el of root.querySelectorAll('*')) {
      yield el;
      if (el.shadowRoot) yield* allElements(el.shadowRoot);
      const doc = frameDocument(el);
      if (doc) yield* allElements(doc);
    }
  }

  // Where a window's viewport sits in the top window (CSS pixels of the top window).
  function frameOffset(win) {
    let x = 0;
    let y = 0;
    for (let w = win; w !== window; w = w.parent) {
      const frame = w.frameElement;
      if (!frame) break;
      const r = frame.getBoundingClientRect();
      x += r.left + frame.clientLeft;
      y += r.top + frame.clientTop;
    }
    return { x, y };
  }

  // An element's rect in the top window's coordinates.
  function topRect(el) {
    const r = el.getBoundingClientRect();
    const { x, y } = frameOffset(windowOf(el));
    return { left: r.left + x, top: r.top + y, right: r.right + x, bottom: r.bottom + y };
  }

  // The part of the top window's viewport a window's content can show in.
  function visibleBox(win) {
    const box = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let w = win; w !== window; w = w.parent) {
      const frame = w.frameElement;
      if (!frame) break;
      const r = topRect(frame);
      box.left = Math.max(box.left, r.left + frame.clientLeft);
      box.top = Math.max(box.top, r.top + frame.clientTop);
      box.right = Math.min(box.right, r.left + frame.clientLeft + frame.clientWidth);
      box.bottom = Math.min(box.bottom, r.top + frame.clientTop + frame.clientHeight);
    }
    return box;
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
      const rect = captureRect(el);
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  // The part of the viewport (CSS pixels of the top window) that shows the
  // scrolled content.
  function captureRect(target) {
    if (!target) {
      const root = rootScroller();
      return { x: 0, y: 0, width: root.clientWidth, height: root.clientHeight };
    }
    const win = windowOf(target);
    let left;
    let top;
    if (target === rootScrollerOf(target.ownerDocument)) {
      // A frame's own document scrolls: its content shows in the whole frame.
      ({ x: left, y: top } = frameOffset(win));
    } else {
      const r = topRect(target);
      left = r.left + target.clientLeft;
      top = r.top + target.clientTop;
    }
    const box = visibleBox(win);
    const x = Math.max(box.left, left);
    const y = Math.max(box.top, top);
    return {
      x,
      y,
      width: Math.min(box.right, left + target.clientWidth) - x,
      height: Math.min(box.bottom, top + target.clientHeight) - y,
    };
  }

  function prepare() {
    if (state) restore();
    // An area selection still on screen would end up in the screenshots.
    window.__holienAreaSelect?.cancel();
    state = { overrides: [], fixed: [], pinned: new Set(), target: null, scrollX, scrollY, targetScrollTop: 0 };

    // Jump instead of animating when scrolling, and keep scrollbars out of the picture.
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      overrideStyle(el, 'scroll-behavior', 'auto');
      overrideStyle(el, 'scrollbar-width', 'none');
    }

    const scrollable = [];
    for (const el of allElements()) {
      const style = windowOf(el).getComputedStyle(el);
      if (/auto|scroll|overlay/.test(style.overflowY) && el.scrollHeight > el.clientHeight) {
        scrollable.push(el);
      }
      // A same-origin frame whose own document scrolls.
      const doc = frameDocument(el);
      const root = doc && rootScrollerOf(doc);
      if (root && root.scrollHeight > root.clientHeight) scrollable.push(root);
    }
    findPinned();

    const target = findInnerScroller(scrollable);
    if (target) {
      state.target = target;
      state.targetScrollTop = target.scrollTop;
      overrideStyle(target, 'scroll-behavior', 'auto');
      overrideStyle(target, 'scrollbar-width', 'none');
      if (target.ownerDocument !== document) {
        for (const el of [target.ownerDocument.documentElement, target.ownerDocument.body]) {
          if (!el) continue;
          overrideStyle(el, 'scroll-behavior', 'auto');
          overrideStyle(el, 'scrollbar-width', 'none');
        }
      }
    }

    // Remembered to tell when the page loads more as it's scrolled (infinite scroll).
    state.height = (target || rootScroller()).scrollHeight;

    return { title: document.title, url: location.href };
  }

  // Takes note of elements pinned to the screen (position: fixed or sticky)
  // that haven't been seen yet. Some pages (Magento's admin, for one) pin a
  // toolbar with JavaScript only once it's scrolled out of view, so this runs
  // again before every screen, not just at the start.
  function findPinned() {
    // Read everything first, then write, so the page is laid out only once.
    const sticky = [];
    let found = false;
    for (const el of allElements()) {
      if (state.pinned.has(el)) continue;
      const win = windowOf(el);
      const style = win.getComputedStyle(el);
      if (style.position === 'sticky') {
        state.pinned.add(el);
        sticky.push(el);
      } else if (style.position === 'fixed') {
        state.pinned.add(el);
        // Fixed elements in a frame are pinned to the frame's edges.
        const rect = el.getBoundingClientRect();
        state.fixed.push({
          el,
          // Pinned to the bottom edge: cookie bars, floating buttons. Anything
          // starting at the top edge belongs to the first screen, even a
          // sidebar so tall that most of it hangs below the window.
          atBottom: rect.top > 0 && rect.top + rect.bottom > win.innerHeight,
          hidden: false,
          saved: [saveProp(el, 'opacity'), saveProp(el, 'transition-property')],
        });
        found = true;
      }
    }
    // Lay sticky elements out where they sit in the document, instead of
    // pinning them to the top of every screen.
    for (const el of sticky) {
      overrideStyle(el, 'position', 'relative');
      for (const side of ['top', 'right', 'bottom', 'left']) overrideStyle(el, side, 'auto');
    }
    return found || sticky.length > 0;
  }

  async function settle() {
    await nextFrame();
    await nextFrame();
    const docs = new Set([document, state.target?.ownerDocument].filter(Boolean));
    const loading = [...docs]
      .flatMap((doc) => [...doc.images])
      .filter((img) => !img.complete && visibleArea(topRect(img)) > 0);
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
    // 'instant' also cancels a smooth scroll the page may still be running.
    if (target) target.scrollTo({ top: y, behavior: 'instant' });
    else window.scrollTo({ left: state.scrollX, top: y, behavior: 'instant' });
    await settle();

    // Measured on every screen in case the window is resized mid-capture.
    return {
      pos: target ? target.scrollTop : window.scrollY,
      maxPos: scroller.scrollHeight - scroller.clientHeight,
      // Whether the page has loaded more since the capture started.
      grew: scroller.scrollHeight > state.height,
      rect: captureRect(target),
      // Whether an element inside the page scrolls, rather than the window.
      inner: Boolean(target),
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    };
  }

  async function showFixed({ top, bottom }) {
    let changed = findPinned();
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

  window.__holienFullPageCapture = { prepare, scrollTo, showFixed, restore };
})();
