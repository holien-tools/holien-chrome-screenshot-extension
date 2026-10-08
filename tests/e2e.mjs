// End-to-end test: loads the extension into Chromium, captures the pages in
// tests/pages (full page and selected areas) and checks every row of the
// screenshots.
//
//   npm test             (headless)
//   HEADED=1 npm test    (watch it run)
//
// Captured images are written to test-output/ for a look by eye.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'test-output');
const WINDOW = { width: 1280, height: 800 };
// The screen limit in background.js.
const MAX_FRAMES = Number(
  /const MAX_FRAMES = (\d+);/.exec(await fs.readFile(path.join(ROOT, 'extension', 'background.js'), 'utf8'))[1],
);
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
    name: 'app layout that scrolls an inner element',
    page: 'app.html',
    async before(page) {
      await page.evaluate(() => document.querySelector('main').scrollTo({ top: 1234, behavior: 'instant' }));
    },
    columns: (width, scale) => [10, Math.floor(width / 2), width - 40 * scale],
    async check({ image, page, scale }) {
      const main = await page.evaluate(() => {
        const el = document.querySelector('main');
        return { width: el.getBoundingClientRect().width, scrollTop: el.scrollTop };
      });
      assert.equal(image.width, main.width * scale, 'image is as wide as the scroll container');
      assert.equal(image.height, 4500 * scale, 'image is as tall as the scroll container content');
      const band = (y) => bandColor(Math.floor(y / 300));
      checkColumn(image.columns[0], scale, band);
      checkColumn(image.columns[1], scale, band);
      // The floating button is fixed to the bottom, so it shows up once, at the end.
      checkColumn(image.columns[2], scale, (y) => (y >= 4500 - 64 && y < 4500 - 16 ? MAGENTA : band(y)));
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
    name: 'infinite scroll stops at the screen limit',
    page: 'infinite.html',
    check: (args) => checkStoppedAtLimit(args, 'infiniteScrollNotice'),
  },
  {
    name: 'very long page stops at the screen limit',
    page: 'very-long.html',
    check: (args) => checkStoppedAtLimit(args, 'tooLongNotice'),
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
];

async function drag(page, from, to) {
  await page.locator('holien-area-select').waitFor({ state: 'attached' });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
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

async function checkStoppedAtLimit({ image, page, result, scale }, noticeKey) {
  const viewport = await page.evaluate(() => innerHeight);
  assert.equal(image.height, MAX_FRAMES * viewport * scale, `image holds ${MAX_FRAMES} screens`);
  const notices = await result.locator('#notices li').allTextContents();
  const expected = await result.evaluate(([key, count]) => chrome.i18n.getMessage(key, [count]), [
    noticeKey,
    String(MAX_FRAMES),
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
          const label = `[${scale}x] ${test.name}`;
          const started = Date.now();
          try {
            await runTest(browser, test, scale, baseUrl);
            console.log(`ok   ${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
          } catch (err) {
            failures++;
            console.log(`FAIL ${label}\n     ${err.message}`);
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
  const { context } = browser;
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
    await result.waitForSelector('body[data-state="ready"]');
    return result;
  })();

  try {
    let image;
    if (await result?.locator('#capture-view').isVisible()) {
      image = await readImage(result, test.columns ?? ((width) => [10, Math.floor(width / 2), width - 2]), scale);
      const name = `${path.basename(test.page, '.html')}${test.mode === 'area' ? '-area' : ''}@${scale}x`;
      for (const [i, png] of image.pngs.entries()) {
        await fs.writeFile(path.join(OUT_DIR, `${name}_${i + 1}.png`), Buffer.from(png, 'base64'));
      }
      await result.screenshot({ path: path.join(OUT_DIR, `${name}_result-page.png`) });
    }
    await test.check({ context, image, page, result, scale });
  } finally {
    await result?.close();
    await page.close();
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
