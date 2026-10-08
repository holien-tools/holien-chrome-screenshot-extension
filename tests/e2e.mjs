// End-to-end test: loads the extension into Chromium, captures the pages in
// tests/pages and checks every row of the stitched screenshots.
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
];

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

async function runTest({ context, worker }, test, scale, baseUrl) {
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
    await test.before?.(page);
    await page.bringToFront();
    const opened = context.waitForEvent('page', {
      predicate: (p) => p.url().includes('/result/result.html'),
      timeout: 120_000,
    });
    // Same as clicking the toolbar button on this tab.
    await worker.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
      await globalThis.__holienHandleClick(tab);
    }, page.url());
    const result = await opened;
    await result.waitForSelector('body[data-state="ready"]');
    return result;
  })();

  try {
    let image;
    if (await result.locator('#capture-view').isVisible()) {
      image = await readImage(result, test.columns ?? ((width) => [10, Math.floor(width / 2), width - 2]), scale);
      const name = `${path.basename(test.page, '.html')}@${scale}x`;
      for (const [i, png] of image.pngs.entries()) {
        await fs.writeFile(path.join(OUT_DIR, `${name}_${i + 1}.png`), Buffer.from(png, 'base64'));
      }
      await result.screenshot({ path: path.join(OUT_DIR, `${name}_result-page.png`) });
    }
    await test.check({ image, page, result, scale });
  } finally {
    await result.close();
    await page.close();
  }
}

// Reads the screenshot shown on the result page: its size, the files, and the
// colors of every row in a few pixel columns.
async function readImage(result, columnsFor, scale) {
  const size = await result.evaluate(async () => {
    const imgs = [...document.querySelectorAll('img.part-image')];
    await Promise.all(imgs.map((img) => img.decode()));
    return { width: imgs[0].naturalWidth };
  });
  const xs = columnsFor(size.width, scale);
  return result.evaluate(async (xs) => {
    const imgs = [...document.querySelectorAll('img.part-image')];
    const columns = xs.map((x) => ({ x, values: [] }));
    const pngs = [];
    for (const img of imgs) {
      const canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      for (const column of columns) {
        const px = ctx.getImageData(column.x, 0, 1, img.naturalHeight).data;
        for (let y = 0; y < img.naturalHeight; y++) {
          column.values.push((px[y * 4] << 16) | (px[y * 4 + 1] << 8) | px[y * 4 + 2]);
        }
      }
      const blob = await (await fetch(img.src)).blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      pngs.push(btoa(binary));
    }
    return {
      width: imgs[0].naturalWidth,
      height: imgs.reduce((sum, img) => sum + img.naturalHeight, 0),
      parts: imgs.length,
      columns,
      pngs,
    };
  }, xs);
}

// A copy of the extension the test can drive. Tests can't click the toolbar
// button (which is what grants activeTab), so this copy gets host access
// instead and exposes the click handler. It also splits images sooner.
async function buildTestExtension() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holien-extension-'));
  await fs.cp(path.join(ROOT, 'extension'), dir, { recursive: true });

  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.permissions.push('tabs');
  manifest.host_permissions = ['<all_urls>'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const backgroundPath = path.join(dir, 'background.js');
  const background = await fs.readFile(backgroundPath, 'utf8');
  const patched = background.replace(
    /const MAX_PART_HEIGHT = \d+;/,
    `const MAX_PART_HEIGHT = ${TEST_MAX_PART_HEIGHT};`,
  );
  assert.notEqual(patched, background, 'MAX_PART_HEIGHT not found in background.js');
  await fs.writeFile(backgroundPath, `${patched}\nglobalThis.__holienHandleClick = handleClick;\n`);
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
  return { context, worker };
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
