// End-to-end test: loads the extension into Chromium, captures the pages in
// tests/pages (full page and selected areas) and checks every row of the
// screenshots.
//
//   npm test             (headless)
//   HEADED=1 npm test    (watch it run)
//   TEST=boxes npm test  (only the tests whose name contains "boxes")
//
// Captured images are written to test-output/ for a look by eye.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { MAX_SCREENS } from '../extension/lib/settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'test-output');
const WINDOW = { width: 1280, height: 800 };
// Lowered from the real per-image limit so the test pages get split into parts.
const TEST_MAX_PART_HEIGHT = 4096;

const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];
const MAGENTA = [255, 0, 255];
const CYAN = [0, 255, 255];

// Same formula as tests/pages/bands.js.
const bandColor = (i) => [((i * 53) % 200) + 30, ((i * 97) % 200) + 30, ((i * 151) % 200) + 30];

const tests = [
  {
    name: 'long page with fixed header/footer, sticky bar and smooth scrolling',
    page: 'long.html',
    async before(page) {
      await page.evaluate(() => window.scrollTo({ top: 3000, behavior: 'instant' }));
    },
    async check({ image, page, scale }) {
      const total = 5050;
      const viewport = await page.evaluate(() => innerWidth);
      assert.equal(image.width, viewport * scale, 'image is as wide as the viewport (no scrollbar)');
      assert.equal(image.height, total * scale, 'image is as tall as the page');
      assert.equal(image.parts, Math.ceil((total * scale) / TEST_MAX_PART_HEIGHT), 'tall images are split');
      const expected = (y) => {
        if (y < 60) return BLACK; // fixed header, first screen only
        if (y >= total - 40) return MAGENTA; // fixed footer, last screen only
        if (y >= 2500 && y < 2550) return CYAN; // sticky bar, where it sits in the page
        return bandColor(Math.floor((y < 2500 ? y : y - 50) / 250));
      };
      for (const column of image.columns) checkColumn(column, scale, expected);

      const after = await page.evaluate(() => ({
        scrollY,
        styles: [...document.querySelectorAll('html, body, #header, #footer, #sticky')]
          .map((el) => el.getAttribute('style'))
          .filter(Boolean),
      }));
      assert.equal(after.scrollY, 3000, 'scroll position is restored');
      assert.deepEqual(after.styles, [], 'inline styles are restored');
    },
  },
  {
    name: 'a bar the page pins with JavaScript while scrolling appears once, a tall sidebar on the first screen',
    page: 'late-fixed.html',
    async check({ image, page, scale }) {
      const total = 2540;
      assert.equal(image.height, total * scale, 'image is as tall as the page');
      const viewportHeight = await page.evaluate(() => innerHeight);
      const expected = (y) => {
        if (y >= 1000 && y < 1040) return [255, 255, 0]; // the bar, where it sits in the page
        return bandColor(Math.floor((y < 1000 ? y : y - 40) / 250));
      };
      // The sidebar is taller than the window, so it starts at the top edge
      // and is cut off at the bottom of the first screen, as on screen.
      const sidebar = (y) => (y < viewportHeight ? [255, 0, 0] : expected(y));
      for (const column of image.columns) checkColumn(column, scale, column.x < 60 * scale ? sidebar : expected);
      const after = await page.evaluate(() => ({
        scrollY,
        pinned: document.getElementById('bar').classList.contains('pinned'),
        style: document.getElementById('bar').getAttribute('style') || null,
      }));
      assert.deepEqual(after, { scrollY: 0, pinned: false, style: null }, `the bar is back to normal: ${JSON.stringify(after)}`);
    },
  },
  {
    name: 'app layout that scrolls an inner element',
    page: 'app.html',
    async before(page) {
      await page.evaluate(() => document.querySelector('main').scrollTo({ top: 1234, behavior: 'instant' }));
    },
    columns: (width, scale) => [10, Math.floor(width / 2), width - 40 * scale],
    async check({ image, page, scale }) {
      const { viewport, main } = await page.evaluate(() => ({
        viewport: { width: innerWidth, height: innerHeight },
        main: { scrollTop: document.querySelector('main').scrollTop },
      }));
      const header = 56;
      const footer = 30;
      const bottom = header + 4500;
      assert.equal(image.width, viewport.width * scale, 'image is as wide as the window');
      assert.equal(image.height, (bottom + footer) * scale, 'image holds the header, the scroll container content and the footer');
      const HEADER = [20, 20, 20];
      const NAV = [200, 200, 200];
      // The header is above the scroll container, the footer below it.
      const around = (y) => (y < header ? HEADER : y >= bottom ? CYAN : null);
      const band = (y) => around(y) ?? bandColor(Math.floor((y - header) / 300));
      // The sidebar beside the scroll container is on the first screen only.
      checkColumn(image.columns[0], scale, (y) => around(y) ?? (y < viewport.height - footer ? NAV : WHITE));
      checkColumn(image.columns[1], scale, band);
      // The floating button is fixed to the bottom of the window, so it shows
      // up once, at the end, over the last of the content and the footer.
      const fab = (y) => y >= bottom + footer - 64 && y < bottom + footer - 16;
      checkColumn(image.columns[2], scale, (y) => (fab(y) ? MAGENTA : band(y)));
      assert.equal(main.scrollTop, 1234, 'scroll position is restored');
    },
  },
  {
    name: 'page shorter than the window',
    page: 'short.html',
    async check({ image, page, scale }) {
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      assert.equal(image.width, viewport.width * scale);
      assert.equal(image.height, viewport.height * scale);
      for (const column of image.columns) checkColumn(column, scale, (y) => (y < 300 ? bandColor(0) : WHITE));
    },
  },
  {
    name: 'infinite scroll stops at the screen limit set in the settings',
    page: 'infinite.html',
    settings: { maxScreens: 12 },
    check: (args) => checkStoppedAtLimit(args, 'infiniteScrollNotice', 12),
  },
  {
    name: 'very long page stops at the default screen limit',
    page: 'very-long.html',
    check: (args) => checkStoppedAtLimit(args, 'tooLongNotice', MAX_SCREENS.default),
  },
  {
    name: 'browser pages show an error',
    page: 'chrome://version',
    scales: [1],
    async check({ result }) {
      await result.locator('#error-view[data-error="restricted"]').waitFor();
    },
  },
  {
    name: 'full page capture takes down an open area selection',
    page: 'long.html',
    async before(page, browser) {
      await tests[0].before(page);
      await startCapture(browser, page, 'area');
    },
    check: (args) => tests[0].check(args),
  },
  {
    name: 'visible area captured from the popup',
    page: 'long.html',
    mode: 'visible',
    viaPopup: true,
    before: scrollForArea,
    columns: (width, scale) => [10, Math.floor(width / 2), width - 40 * scale],
    async check({ image, page, result, scale }) {
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      assert.equal(image.width, viewport.width * scale, 'image is as wide as the viewport');
      assert.equal(image.height, viewport.height * scale, 'image is as tall as the viewport');
      const expected = (y) => {
        if (y < 60) return BLACK; // fixed header
        if (y >= viewport.height - 40) return MAGENTA; // fixed footer
        return bandColor(Math.floor((1000 + y) / 250));
      };
      for (const column of image.columns) checkColumn(column, scale, expected);
      assert.equal(await page.evaluate(() => scrollY), 1000, 'the page did not scroll');
      const title = await result.evaluate(() => chrome.i18n.getMessage('visibleResultTitle'));
      assert.ok((await result.title()).endsWith(title), 'result page is titled as a visible area screenshot');
    },
  },
  {
    name: 'visible area capture on browser pages shows an error',
    page: 'chrome://version',
    mode: 'visible',
    scales: [1],
    async check({ result }) {
      await result.locator('#error-view[data-error="restricted"]').waitFor();
    },
  },
  {
    name: 'area selected from the popup',
    page: 'long.html',
    mode: 'area',
    viaPopup: true,
    async before(page) {
      await page.evaluate(() => window.scrollTo({ top: 1000, behavior: 'instant' }));
    },
    // From the bottom right to the top left, so the box has to be flipped.
    select: (page) => drag(page, { x: 640, y: 500 }, { x: 40, y: 150 }),
    async check({ image, page, result, scale }) {
      assert.equal(image.width, 600 * scale, 'image is as wide as the selection');
      assert.equal(image.height, 350 * scale, 'image is as tall as the selection');
      for (const column of image.columns) checkColumn(column, scale, (y) => bandColor(Math.floor((1150 + y) / 250)));

      const after = await page.evaluate(() => ({
        scrollY,
        overlay: Boolean(document.querySelector('holien-area-select')),
      }));
      assert.equal(after.scrollY, 1000, 'the page did not scroll');
      assert.equal(after.overlay, false, 'the selection overlay is gone');
      const title = await result.evaluate(() => chrome.i18n.getMessage('areaResultTitle'));
      assert.ok((await result.title()).endsWith(title), 'result page is titled as an area screenshot');
      await checkCopy(result, image);
    },
  },
  {
    name: 'boxes drawn on the preview are merged into the copied and downloaded image',
    page: 'long.html',
    mode: 'area',
    before: scrollForArea,
    select: selectArea,
    async check({ image, result, scale }) {
      const band = (y) => bandColor(Math.floor((1150 + y) / 250));
      const shapes = () => result.evaluate(() => document.querySelectorAll('.shape').length);
      const status = result.locator('#shape-status');
      await status.filter({ hasText: await text(result, 'annotateHint') }).waitFor();
      assert.equal(await result.locator('#undo').isDisabled(), true, 'undo starts disabled');

      // A green, thick box, in image pixels, clear of the band labels.
      const green = { x1: 350, y1: 50, x2: 550, y2: 250, line: 8 * scale };
      await result.click('.swatch[data-color="#2e9e45"]');
      await result.selectOption('#line-width', '8');
      await dragOnImage(result, green);
      assert.equal(await shapes(), 1, 'the box is drawn');
      await status.filter({ hasText: await text(result, 'shapeCount', 1) }).waitFor();

      // A click is not a box.
      await dragOnImage(result, { x1: 200, y1: 300, x2: 201, y2: 301 });
      assert.equal(await shapes(), 1, 'a click does not add a box');

      // A second box, selected by clicking its line and deleted.
      await result.click('.swatch[data-color="#e53935"]');
      await dragOnImage(result, { x1: 100, y1: 60, x2: 300, y2: 200 });
      assert.equal(await shapes(), 2, 'a second box is drawn');
      await clickOnImage(result, 100 + 2 * scale, 130);
      assert.equal(await result.locator('.shape.selected').count(), 1, 'clicking the line selects the box');
      await result.keyboard.press('Delete');
      assert.equal(await shapes(), 1, 'Delete removes the selected box');
      const [left] = await result.evaluate(() =>
        [...document.querySelectorAll('.shape .line')].map((line) => line.getAttribute('stroke')),
      );
      assert.equal(left, '#2e9e45', 'the green box is the one left');

      // Undo takes the green box back, and it's drawn again for the checks.
      await result.click('#undo');
      assert.equal(await shapes(), 0, 'undo removes the last box');
      await status.filter({ hasText: await text(result, 'annotateHint') }).waitFor();
      await result.click('.swatch[data-color="#2e9e45"]');
      await dragOnImage(result, green);

      const expected = (x) => (y) => {
        const inside = x >= green.x1 && x < green.x2 && y >= green.y1 && y < green.y2;
        const onLine =
          x < green.x1 + green.line ||
          x >= green.x2 - green.line ||
          y < green.y1 + green.line ||
          y >= green.y2 - green.line;
        return inside && onLine ? [0x2e, 0x9e, 0x45] : band(y / scale);
      };
      const columns = [green.x1 + 2, 450, 300];
      const copied = await readCopy(result, columns);
      assert.deepEqual(
        { width: copied.width, height: copied.height },
        { width: image.width, height: image.height },
        'the copied image is the size of the screenshot',
      );
      for (const column of copied.columns) checkColumn(column, 1, expected(column.x));

      const download = result.waitForEvent('download');
      await result.click('#download');
      const file = await download;
      assert.match(file.suggestedFilename(), /^screenshot_127\.0\.0\.1_\d{8}-\d{6}\.png$/, 'file name');
      const bytes = await fs.readFile(await file.path());
      assert.equal(bytes.subarray(1, 4).toString(), 'PNG', 'the download is a PNG');

      await result.click('#clear');
      assert.equal(await shapes(), 0, 'clear removes every box');
      const original = await readCopy(result, [450]);
      checkColumn(original.columns[0], 1, (y) => band(y / scale));
    },
  },
  {
    name: 'boxes are moved and resized with the mouse',
    page: 'long.html',
    mode: 'area',
    scales: [1],
    before: scrollForArea,
    select: selectArea,
    async check({ result }) {
      const box = () =>
        result.evaluate(() => {
          const line = document.querySelector('.shape[data-type="box"] .line');
          const lineWidth = Number(line.getAttribute('stroke-width'));
          return ['x', 'y', 'width', 'height'].map((name) => Number(line.getAttribute(name)) + (name === 'x' || name === 'y' ? -lineWidth / 2 : lineWidth));
        });
      await dragOnImage(result, { x1: 100, y1: 100, x2: 300, y2: 200 });
      assert.deepEqual(await box(), [100, 100, 200, 100], 'the box is where it was drawn');
      assert.equal(await result.locator('.handle').count(), 8, 'the new box is selected, with handles');

      // Dragging the line moves it; a drag below the threshold doesn't.
      await dragOnImage(result, { x1: 150, y1: 101, x2: 200, y2: 131 });
      assert.deepEqual(await box(), [150, 130, 200, 100], 'the box moved');
      await dragOnImage(result, { x1: 200, y1: 131, x2: 201, y2: 132 });
      assert.deepEqual(await box(), [150, 130, 200, 100], 'a click does not move it');

      // The corner and edge handles resize it.
      await dragHandle(result, 'se', 40, 20);
      assert.deepEqual(await box(), [150, 130, 240, 120], 'the bottom right corner was dragged');
      await dragHandle(result, 'w', 30, 0);
      assert.deepEqual(await box(), [180, 130, 210, 120], 'the left edge was dragged');
      await dragHandle(result, 'n', 0, -50);
      assert.deepEqual(await box(), [180, 80, 210, 170], 'the top edge was dragged');

      // Escape takes a drag back.
      const point = await imagePoint(result, 200, 81);
      await result.mouse.move(point.x, point.y);
      await result.mouse.down();
      await result.mouse.move(point.x + 60, point.y + 60, { steps: 5 });
      await result.keyboard.press('Escape');
      await result.mouse.up();
      assert.deepEqual(await box(), [180, 80, 210, 170], 'Escape cancels the move');
      assert.equal(await result.locator('.shape').count(), 1, 'still one box');
    },
  },
  {
    name: 'arrows, text, numbers and mosaics are drawn and merged into the image',
    page: 'long.html',
    mode: 'area',
    before: scrollForArea,
    select: selectArea,
    async check({ result, scale }) {
      const band = (y) => bandColor(Math.floor((1150 + y) / 250));
      const shapes = (type) => result.locator(`.shape[data-type="${type}"]`);
      const blue = [0x1e, 0x6f, 0xe0];
      await result.click('.swatch[data-color="#1e6fe0"]');

      // A horizontal arrow, thick, so its line is a row of pixels.
      await result.click('.tool[data-tool="arrow"]');
      await result.selectOption('#line-width', '8');
      await dragOnImage(result, { x1: 100, y1: 300, x2: 400, y2: 300 });
      assert.equal(await shapes('arrow').count(), 1, 'the arrow is drawn');

      // Text, typed into the editor and finished with Enter.
      await result.click('.tool[data-tool="text"]');
      await clickOnImage(result, 320, 40);
      const editor = result.locator('.text-editor');
      await editor.waitFor();
      await result.keyboard.type('Hi');
      await result.keyboard.press('Enter');
      await editor.waitFor({ state: 'detached' });
      assert.equal(await shapes('text').count(), 1, 'the text is placed');
      assert.equal(await shapes('text').locator('text').textContent(), 'Hi', 'the text is what was typed');
      // Typing nothing adds nothing.
      await clickOnImage(result, 200, 200);
      await editor.waitFor();
      await result.keyboard.press('Escape');
      await editor.waitFor({ state: 'detached' });
      assert.equal(await shapes('text').count(), 1, 'an empty text is not added');

      // Two numbered markers; deleting the first renumbers the second.
      await result.click('.tool[data-tool="number"]');
      await clickOnImage(result, 500, 60);
      await clickOnImage(result, 500, 300);
      const numbers = () => shapes('number').locator('text').allTextContents();
      assert.deepEqual(await numbers(), ['1', '2'], 'markers count up');
      await clickOnImage(result, 500, 60);
      await result.keyboard.press('Delete');
      assert.deepEqual(await numbers(), ['1'], 'the marker left is renumbered');
      await clickOnImage(result, 500, 60);

      // A mosaic across a band boundary, in blocks of 18 CSS pixels at this line width.
      const mosaic = { top: 60 * scale, bottom: 140 * scale, block: 18 * scale };
      await result.click('.tool[data-tool="mosaic"]');
      await dragOnImage(result, { x1: 20, y1: mosaic.top, x2: 80, y2: mosaic.bottom });
      assert.equal(await shapes('mosaic').count(), 1, 'the mosaic is drawn');
      await result.locator('.shape[data-type="mosaic"] image[href^="data:"]').waitFor();

      const copied = await readCopy(result, [250, 500 + 14 * scale, 50]);
      // The arrow's line runs along y=300 at x=250.
      checkColumn(copied.columns[0], 1, (y) => (y >= 300 - 4 * scale && y < 300 + 4 * scale ? blue : band(y / scale)));
      // Beside the digit, the markers are solid blue.
      const marker = (y, cy) => Math.abs(y - cy) < 8 * scale;
      checkColumnWhere(copied.columns[1], (y) => marker(y, 300) || marker(y, 60), blue);
      // The mosaic is blocks of one color, aligned to its top edge. The third
      // block straddles the band boundary, so it's a mix of both colors.
      const rows = copied.columns[2].values;
      for (let y = mosaic.top; y < mosaic.bottom; y++) {
        const top = mosaic.top + Math.floor((y - mosaic.top) / mosaic.block) * mosaic.block;
        assert.equal(rows[y], rows[top], `mosaic row ${y} matches the top of its block`);
      }
      assert.notEqual(rows[mosaic.top + 2 * mosaic.block], rows[mosaic.top], 'the blocks differ across the band boundary');
      // The text has solid blue pixels somewhere in its box.
      const textBox = await result.evaluate(() => {
        const box = document.querySelector('.shape[data-type="text"] text').getBBox();
        return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
      });
      const hits = await countColor(result, textBox, blue);
      assert.ok(hits > 10, `the text is drawn in blue (${hits} blue pixels in its box)`);
      await result.screenshot({ path: path.join(OUT_DIR, `annotated@${scale}x.png`) });
    },
  },
  {
    name: 'annotations are kept when the result page is reopened',
    page: 'long.html',
    mode: 'area',
    scales: [1],
    before: scrollForArea,
    select: selectArea,
    async check({ result }) {
      await dragOnImage(result, { x1: 100, y1: 100, x2: 300, y2: 200 });
      await result.click('.tool[data-tool="number"]');
      await clickOnImage(result, 400, 100);
      await sleep(600);
      await result.reload();
      await result.waitForSelector('body[data-state="ready"]');
      const restored = await result.evaluate(() =>
        [...document.querySelectorAll('.shape')].map((shape) => shape.dataset.type),
      );
      assert.deepEqual(restored, ['box', 'number'], 'the shapes are back');
      assert.equal(await result.locator('#undo').isDisabled(), false, 'the tools know about them');
      await result.click('#clear');
      await sleep(600);
      await result.reload();
      await result.waitForSelector('body[data-state="ready"]');
      assert.equal(await result.locator('.shape').count(), 0, 'cleared shapes stay cleared');
    },
  },
  {
    name: 'downloads as JPEG at the chosen quality',
    page: 'long.html',
    mode: 'area',
    scales: [1],
    settings: { format: 'png' },
    before: scrollForArea,
    select: selectArea,
    async check({ result, worker }) {
      const downloadAs = (format) => text(result, 'downloadAs', format);
      assert.equal(await result.locator('#download').textContent(), await downloadAs('PNG'), 'PNG by default');
      assert.equal(await result.locator('#quality-field').isHidden(), true, 'no quality for PNG');

      await result.selectOption('#format', 'jpeg');
      assert.equal(await result.locator('#download').textContent(), await downloadAs('JPEG'), 'the button follows the format');
      await result.locator('#quality-field:not([hidden])').waitFor();
      await result.locator('#quality').fill('60');
      assert.equal(await result.locator('#quality-value').textContent(), '60%', 'the quality is shown');

      const size = async () => {
        const download = result.waitForEvent('download');
        await result.click('#download');
        const file = await download;
        assert.match(file.suggestedFilename(), /\.jpg$/, 'file name');
        const bytes = await fs.readFile(await file.path());
        assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff], 'the download is a JPEG');
        return bytes.length;
      };
      const low = await size();
      await result.locator('#quality').fill('100');
      const high = await size();
      assert.ok(high > low, `quality 100 (${high} bytes) is larger than 60 (${low} bytes)`);

      await sleep(300);
      const stored = await worker.evaluate(() => chrome.storage.sync.get(['format', 'jpegQuality']));
      assert.deepEqual(stored, { format: 'jpeg', jpegQuality: 100 }, 'the choice is saved');
      await result.reload();
      await result.waitForSelector('body[data-state="ready"]');
      assert.equal(await result.locator('#format').inputValue(), 'jpeg', 'the format is remembered');
      assert.equal(await result.locator('#quality').inputValue(), '100', 'the quality is remembered');
    },
  },
  {
    name: 'area selection is cancelled with Esc',
    page: 'long.html',
    mode: 'area',
    noResult: true,
    async before(page) {
      await page.evaluate(() => {
        window.keysSeen = 0;
        addEventListener('keydown', () => window.keysSeen++);
        // Focus starts in an iframe, which Esc only gets out of if the selection takes the focus.
        const frame = document.body.appendChild(document.createElement('iframe'));
        frame.srcdoc = '<input>';
        return new Promise((resolve) => (frame.onload = resolve));
      });
      await page.frameLocator('iframe').locator('input').focus();
    },
    async select(page) {
      const overlay = page.locator('holien-area-select');
      await overlay.waitFor({ state: 'attached' });
      // A click isn't a selection.
      await page.mouse.click(300, 300);
      assert.equal(await overlay.count(), 1, 'a click leaves the overlay up');
      await page.keyboard.press('Escape');
    },
    async check({ context, page }) {
      await page.locator('holien-area-select').waitFor({ state: 'detached' });
      await sleep(1000);
      const results = context.pages().filter((p) => p.url().includes('/result/result.html'));
      assert.equal(results.length, 0, 'no screenshot was taken');
      assert.equal(await page.evaluate(() => window.keysSeen), 0, 'keys did not reach the page');
      const focused = await page.evaluate(() => document.activeElement.tagName);
      assert.equal(focused, 'IFRAME', 'focus is back in the iframe');
    },
  },
  {
    name: 'area selection on browser pages shows an error',
    page: 'chrome://version',
    mode: 'area',
    scales: [1],
    async check({ result }) {
      await result.locator('#error-view[data-error="restricted"]').waitFor();
    },
  },
  {
    name: 'settings page saves the screen limit',
    scales: [1],
    async run({ context, worker, extensionId }) {
      const stored = () => worker.evaluate(() => chrome.storage.sync.get('maxScreens'));
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
      const opened = context.waitForEvent('page', { predicate: (p) => p.url().includes('/options/options.html') });
      await popup.evaluate(() => document.querySelector('#settings').click());
      const options = await opened;
      try {
        await options.waitForSelector('body[data-state="ready"]');
        const input = options.locator('#max-screens');
        assert.equal(await input.inputValue(), String(MAX_SCREENS.default), 'shows the default');

        for (const bad of ['0', String(MAX_SCREENS.max + 1), '2.5', '']) {
          await input.fill(bad);
          await options.locator('#status.error').waitFor();
          assert.equal(await input.getAttribute('aria-invalid'), 'true', `"${bad}" is marked invalid`);
        }
        await sleep(500);
        assert.deepEqual(await stored(), {}, 'invalid values are not saved');

        await input.fill('12');
        await options.locator('#status.saved').waitFor();
        assert.deepEqual(await stored(), { maxScreens: 12 }, 'a valid value is saved');
        await options.reload();
        await options.waitForSelector('body[data-state="ready"]');
        assert.equal(await input.inputValue(), '12', 'the saved value is shown again');

        await options.click('#reset');
        await options.locator('#status.saved').waitFor();
        assert.equal(await input.inputValue(), String(MAX_SCREENS.default), 'reset shows the default');
        assert.deepEqual(await stored(), { maxScreens: MAX_SCREENS.default }, 'reset saves the default');
      } finally {
        await options.close();
        if (!popup.isClosed()) await popup.close();
        await worker.evaluate(() => chrome.storage.sync.clear());
      }
    },
  },
];

async function drag(page, from, to) {
  await page.locator('holien-area-select').waitFor({ state: 'attached' });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
}

async function scrollForArea(page) {
  await page.evaluate(() => window.scrollTo({ top: 1000, behavior: 'instant' }));
  // The screenshot is of the last frame drawn, which has to be the scrolled one.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await sleep(200);
}

function selectArea(page) {
  return drag(page, { x: 40, y: 150 }, { x: 640, y: 500 });
}

function text(result, key, ...subs) {
  return result.evaluate(([key, subs]) => chrome.i18n.getMessage(key, subs), [key, subs.map(String)]);
}

// Drags a resize handle of the selected shape by dx, dy image pixels.
async function dragHandle(result, name, dx, dy) {
  const handle = result.locator(`.handle[data-handle="${name}"]`);
  const box = await handle.boundingBox();
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const unit = await result.evaluate(() => {
    const img = document.querySelector('img.part-image');
    return img.getBoundingClientRect().width / img.width;
  });
  await result.mouse.move(from.x, from.y);
  await result.mouse.down();
  await result.mouse.move(from.x + dx * unit, from.y + dy * unit, { steps: 5 });
  await result.mouse.up();
}

// Rows where the condition holds must be the color; the others aren't checked.
function checkColumnWhere(column, where, rgb) {
  const packed = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
  const bad = [];
  for (let y = 0; y < column.values.length; y++) {
    if (where(y) && column.values[y] !== packed) bad.push(y);
  }
  assert.equal(bad.length, 0, `column x=${column.x}: rows ${bad.slice(0, 5)} are not rgb(${rgb})`);
}

// How many pixels of the copied image in the box are exactly the color.
async function countColor(result, box, rgb) {
  return result.evaluate(
    async ([box, rgb]) => {
      const [item] = await navigator.clipboard.read();
      const bitmap = await createImageBitmap(await item.getType('image/png'));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const px = ctx.getImageData(box.x, box.y, box.width, box.height).data;
      let hits = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] === rgb[0] && px[i + 1] === rgb[1] && px[i + 2] === rgb[2]) hits++;
      }
      return hits;
    },
    [box, rgb],
  );
}

// Drags on the first image of the result page, in image pixels.
async function dragOnImage(result, { x1, y1, x2, y2 }) {
  const from = await imagePoint(result, x1, y1);
  const to = await imagePoint(result, x2, y2);
  await result.mouse.move(from.x, from.y);
  await result.mouse.down();
  await result.mouse.move(to.x, to.y, { steps: 5 });
  await result.mouse.up();
}

async function clickOnImage(result, x, y) {
  const point = await imagePoint(result, x, y);
  await result.mouse.click(point.x, point.y);
}

// Where an image pixel is on the result page.
function imagePoint(result, x, y) {
  return result.evaluate(
    ([x, y]) => {
      const img = document.querySelector('img.part-image');
      const rect = img.getBoundingClientRect();
      return { x: rect.left + (x * rect.width) / img.width, y: rect.top + (y * rect.height) / img.height };
    },
    [x, y],
  );
}

// Copies the image with the result page's button and reads back its size and
// the colors of every row in the given pixel columns.
async function readCopy(result, xs) {
  const [copy, copied] = await result.evaluate(() => ['copy', 'copied'].map((key) => chrome.i18n.getMessage(key)));
  // "Copied" from an earlier click goes away after a moment.
  await result.waitForFunction((copy) => document.querySelector('#copy').textContent === copy, copy);
  await result.click('#copy');
  await result.locator('#copy', { hasText: copied }).waitFor();
  return result.evaluate(async (xs) => {
    const [item] = await navigator.clipboard.read();
    const bitmap = await createImageBitmap(await item.getType('image/png'));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const columns = xs.map((x) => {
      const px = ctx.getImageData(x, 0, 1, bitmap.height).data;
      const values = [];
      for (let y = 0; y < bitmap.height; y++) {
        values.push((px[y * 4] << 16) | (px[y * 4 + 1] << 8) | px[y * 4 + 2]);
      }
      return { x, values };
    });
    return { width: bitmap.width, height: bitmap.height, columns };
  }, xs);
}

// Copies the screenshot with the result page's button and reads it back.
async function checkCopy(result, image) {
  const copied = await result.evaluate(() => chrome.i18n.getMessage('copied'));
  await result.click('#copy');
  await result.locator('#copy', { hasText: copied }).waitFor();
  const size = await result.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    const bitmap = await createImageBitmap(await item.getType('image/png'));
    return { width: bitmap.width, height: bitmap.height };
  });
  assert.deepEqual(size, { width: image.width, height: image.height }, 'the screenshot is on the clipboard');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkStoppedAtLimit({ image, page, result, scale }, noticeKey, limit) {
  const viewport = await page.evaluate(() => innerHeight);
  assert.equal(image.height, limit * viewport * scale, `image holds ${limit} screens`);
  const notices = await result.locator('#notices li').allTextContents();
  const expected = await result.evaluate(([key, count]) => chrome.i18n.getMessage(key, [count]), [
    noticeKey,
    String(limit),
  ]);
  assert.ok(notices.includes(expected), `notice "${expected}" in ${JSON.stringify(notices)}`);
  for (const column of image.columns) checkColumn(column, scale, (y) => bandColor(Math.floor(y / 250)));
}

function checkColumn(column, scale, expected) {
  const colorAt = (row) => expected((row + 0.5) / scale);
  const matches = (rgb, packed) =>
    rgb.every((c, i) => Math.abs(c - ((packed >> (16 - 8 * i)) & 255)) <= 2);
  const bad = [];
  for (let row = 0; row < column.values.length; row++) {
    // Allow anti-aliasing right at a color boundary.
    const near = [-2, -1, 0, 1, 2].map((d) => colorAt(row + d));
    if (!near.some((rgb) => matches(rgb, column.values[row]))) bad.push(row);
  }
  if (bad.length) {
    const row = bad[0];
    const got = column.values[row].toString(16).padStart(6, '0');
    assert.fail(
      `column x=${column.x}: ${bad.length} rows differ; first at y=${row}: got #${got}, expected rgb(${colorAt(row)})`,
    );
  }
}

async function main() {
  const extensionDir = await buildTestExtension();
  const server = await serve(path.join(ROOT, 'tests', 'pages'));
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  await fs.mkdir(OUT_DIR, { recursive: true });

  let failures = 0;
  try {
    for (const scale of [1, 2]) {
      const browser = await launch(extensionDir, scale);
      try {
        for (const test of tests) {
          if (test.scales && !test.scales.includes(scale)) continue;
          if (process.env.TEST && !test.name.includes(process.env.TEST)) continue;
          const label = `[${scale}x] ${test.name}`;
          const started = Date.now();
          try {
            await (test.run ? test.run(browser) : runTest(browser, test, scale, baseUrl));
            console.log(`ok   ${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
          } catch (err) {
            failures++;
            const where = err.stack?.split('\n').find((line) => line.includes('e2e.mjs'))?.trim();
            console.log(`FAIL ${label}\n     ${err.message}${where ? `\n     ${where}` : ''}`);
          }
        }
      } finally {
        await browser.context.close();
      }
    }
  } finally {
    server.close();
    await fs.rm(extensionDir, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
}

async function runTest(browser, test, scale, baseUrl) {
  const { context, worker } = browser;
  if (test.settings) await worker.evaluate((settings) => chrome.storage.sync.set(settings), test.settings);
  const page = await context.newPage();
  const result = await (async () => {
    await page.goto(test.page.includes(':') ? test.page : baseUrl + test.page);
    // A new headless window can still be resizing right after it opens.
    await page.waitForFunction(
      () => new Promise((resolve) => {
        const height = innerHeight;
        setTimeout(() => resolve(innerHeight === height), 300);
      }),
    );
    await test.before?.(page, browser);
    const opened = test.noResult
      ? null
      : context.waitForEvent('page', {
          predicate: (p) => p.url().includes('/result/result.html'),
          timeout: 120_000,
        });
    await startCapture(browser, page, test.mode ?? 'full', test.viaPopup);
    await test.select?.(page);
    if (!opened) return null;
    const result = await opened;
    result.errors = [];
    result.on('console', (message) => message.type() === 'error' && result.errors.push(message.text()));
    result.on('pageerror', (err) => result.errors.push(err.message));
    await result.waitForSelector('body[data-state="ready"]');
    return result;
  })();

  try {
    let image;
    if (await result?.locator('#capture-view').isVisible()) {
      image = await readImage(result, test.columns ?? ((width) => [10, Math.floor(width / 2), width - 2]), scale);
      const name = `${path.basename(test.page, '.html')}${test.mode ? `-${test.mode}` : ''}@${scale}x`;
      for (const [i, png] of image.pngs.entries()) {
        await fs.writeFile(path.join(OUT_DIR, `${name}_${i + 1}.png`), Buffer.from(png, 'base64'));
      }
      await result.screenshot({ path: path.join(OUT_DIR, `${name}_result-page.png`) });
    }
    try {
      await test.check({ context, image, page, result, scale, worker });
    } catch (err) {
      if (result?.errors.length) err.message += `\n     result page errors: ${result.errors.join(' | ')}`;
      throw err;
    }
  } finally {
    await result?.close();
    await page.close();
    if (test.settings) await worker.evaluate(() => chrome.storage.sync.clear());
  }
}

// Same as picking a mode in the toolbar popup on the page's tab.
async function startCapture({ context, worker, extensionId }, page, mode, viaPopup) {
  if (!viaPopup) {
    await page.bringToFront();
    await worker.evaluate(
      async ([url, mode]) => {
        const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
        await globalThis.__holienStartCapture(tab, mode);
      },
      [page.url(), mode],
    );
    return;
  }
  // The real popup opens over the page. Here it's a tab of its own, so it's
  // pointed at the page's tab, and the page is brought back to the front.
  const popup = await context.newPage();
  try {
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popup.evaluate((url) => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async () => (await query({})).filter((t) => t.url === url);
    }, page.url());
    const closed = popup.waitForEvent('close');
    await page.bringToFront();
    await popup.evaluate((mode) => document.querySelector(`button[data-mode="${mode}"]`).click(), mode);
    await closed;
  } finally {
    if (!popup.isClosed()) await popup.close();
  }
}

// Reads the screenshot shown on the result page: its size, the files, and the
// colors of every row in a few pixel columns. Parts are decoded one at a time,
// since Chromium won't keep dozens of large images decoded at once.
async function readImage(result, columnsFor, scale) {
  const width = await result.evaluate(async () => {
    const img = document.querySelector('img.part-image');
    const bitmap = await createImageBitmap(await (await fetch(img.src)).blob());
    const { width } = bitmap;
    bitmap.close();
    return width;
  });
  const xs = columnsFor(width, scale);
  return result.evaluate(async (xs) => {
    const columns = xs.map((x) => ({ x, values: [] }));
    const image = { width: 0, height: 0, parts: 0, columns, pngs: [] };
    for (const img of document.querySelectorAll('img.part-image')) {
      const blob = await (await fetch(img.src)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      for (const column of columns) {
        const px = ctx.getImageData(column.x, 0, 1, bitmap.height).data;
        for (let y = 0; y < bitmap.height; y++) {
          column.values.push((px[y * 4] << 16) | (px[y * 4 + 1] << 8) | px[y * 4 + 2]);
        }
      }
      image.width = bitmap.width;
      image.height += bitmap.height;
      image.parts++;
      bitmap.close();
      // Frees the pixels now rather than whenever garbage collection runs.
      canvas.width = canvas.height = 0;

      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      image.pngs.push(btoa(binary));
    }
    return image;
  }, xs);
}

// A copy of the extension the test can drive. Tests can't click the toolbar
// button (which is what grants activeTab), so this copy gets host access
// instead and exposes the capture entry point. It also splits images sooner.
async function buildTestExtension() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holien-extension-'));
  await fs.cp(path.join(ROOT, 'extension'), dir, { recursive: true });

  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  // clipboardRead lets the test read back what the Copy button wrote.
  manifest.permissions.push('tabs', 'clipboardRead');
  manifest.host_permissions = ['<all_urls>'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const backgroundPath = path.join(dir, 'background.js');
  const background = await fs.readFile(backgroundPath, 'utf8');
  const patched = background.replace(
    /const MAX_PART_HEIGHT = \d+;/,
    `const MAX_PART_HEIGHT = ${TEST_MAX_PART_HEIGHT};`,
  );
  assert.notEqual(patched, background, 'MAX_PART_HEIGHT not found in background.js');
  await fs.writeFile(backgroundPath, `${patched}\nglobalThis.__holienStartCapture = startCapture;\n`);
  return dir;
}

async function launch(extensionDir, scale) {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: !process.env.HEADED,
    viewport: null,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      `--window-size=${WINDOW.width},${WINDOW.height}`,
      `--force-device-scale-factor=${scale}`,
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return { context, worker, extensionId: new URL(worker.url()).host };
}

function serve(dir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript' };
  const server = http.createServer(async (req, res) => {
    try {
      const file = path.join(dir, path.normalize(new URL(req.url, 'http://x').pathname));
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

await main();
