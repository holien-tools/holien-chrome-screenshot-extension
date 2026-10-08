# Full Page Screenshot (Chrome extension)

[繁體中文](README.md) | **English**

Click the toolbar button to capture the **entire web page** (including the parts you have to scroll to see) as a single PNG image, preview it, and download it.

## Install

1. Download this repo (`git clone`, or on GitHub click **Code → Download ZIP** and unzip it).
2. In Chrome, open `chrome://extensions` and turn on **Developer mode** in the top right.
3. Click **Load unpacked** and select the **`extension`** folder in the repo (not the repo root).
4. Pinning the extension to the toolbar is recommended: click the puzzle piece icon, then click the pin next to "Full Page Screenshot".

## Usage

1. Open the page you want to capture.
2. Click the toolbar button. The button shows the progress (%) while capturing. **Stay on this tab until it finishes.**
3. When it's done, a new tab opens with a preview. Click **Download PNG** to save it.

You can also set a keyboard shortcut: go to `chrome://extensions/shortcuts` and assign a key to **Activate the extension** for "Full Page Screenshot".

## How scrolling is handled

Chrome can only capture what's currently visible, so the extension:

- Starts at the top of the page, scrolls one screen at a time taking a screenshot each time, then stitches all the screens together by scroll position.
- **Fixed elements**: headers appear only in the first screen, and elements fixed to the bottom (such as cookie banners and floating buttons) appear only in the last screen, so they aren't repeated in the image.
- **Sticky elements**: temporarily switched back to normal layout while capturing, so they appear only in their original position instead of sticking to the top of every screen.
- **Smooth scrolling**: temporarily turned off while capturing, so screens aren't captured mid-animation.
- **Scrollbars**: temporarily hidden while capturing, so they don't appear in the image.
- **Lazy-loaded images**: after each scroll, it waits for the images on screen to load (up to 1.5 seconds) before taking the screenshot.
- **Pages that scroll an inner element**: on some pages (app-style layouts like Gmail or Notion), a section inside the page scrolls rather than the whole window. In that case it automatically finds the main scrolling section and captures its full content.
- **Pages that load more content as you scroll** (infinite scroll, such as the Yahoo home page or social media feeds): it keeps capturing the newly loaded content, **stopping after at most 10 screens**, and the preview page tells you.

When the capture finishes, the scroll position and styles are restored to how they were.

## Limitations

- **At most 10 screens per capture**: infinite scroll pages (such as social media feeds) keep loading new content, and very long regular pages are treated the same way. The capture stops after 10 screens, and the preview page tells you.
- **Tall images are split into several**: a single image can be at most 16384 pixels tall. On high-resolution displays, 10 screens may exceed that, in which case the capture is split top to bottom into several images, and the preview page lets you download them all at once.
- **Pages that can't be captured**: Chrome doesn't let extensions access browser pages starting with `chrome://`, the Chrome Web Store, or some built-in viewers.
- **Local files** (`file://`): turn on "Allow access to file URLs" in the extension's details on `chrome://extensions`.
- Only vertical scrolling is captured. If the page also scrolls horizontally, only the currently visible width is captured.
- Capture speed is limited by Chrome (at most 2 screenshots per second), so each screen takes about 0.5 seconds or more.
- Only the 3 most recent screenshots are kept, so download them from the preview page promptly.

## Permissions

- `activeTab`: access to the current tab to take the screenshot, only when you click the button.
- `scripting`: runs the code that scrolls the page and adjusts its styles.

It doesn't need permission to "read all your data on all websites", and it never sends any data over the network. Screenshots stay in your browser.

## Development

```
extension/               ← load this folder in Chrome
  manifest.json
  background.js          capture flow: scroll, screenshot, stitch, split
  content/capture-helper.js
                         injected into the page: finds the scrolling section,
                         handles fixed/sticky, scrolls, restores
  lib/store.js           hands screenshots to the preview page via IndexedDB
  result/                preview and download page
  _locales/              English and Traditional Chinese UI text
tests/
  e2e.mjs                end-to-end tests
  pages/                 test pages
```

### Tests

The tests use Playwright to launch Chromium, load the extension, capture the test pages in `tests/pages`, and check the colors of the stitched image row by row (run at both 1x and 2x display scaling).

```sh
npm install
npx playwright install chromium   # needed the first time
npm test
HEADED=1 npm test                 # watch it run in a window
```

Captured images are saved in `test-output/` so you can open and inspect them.

## Author

Joe Wu
