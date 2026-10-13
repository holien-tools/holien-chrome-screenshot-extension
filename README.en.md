# Full Page Screenshot (Chrome extension)

[繁體中文](README.md) | **English**

Click the toolbar button to capture the **entire web page** (including the parts you have to scroll to see) as an image, capture **just what's on screen**, or **select part of the screen** like the Windows Snipping Tool, then preview it, **add boxes, arrows, text, numbered markers and mosaics**, and download it (as PNG or JPEG) or copy it.

## Install

1. Download this repo (`git clone`, or on GitHub click **Code → Download ZIP** and unzip it).
2. In Chrome, open `chrome://extensions` and turn on **Developer mode** in the top right.
3. Click **Load unpacked** and select the **`extension`** folder in the repo (not the repo root).
4. Pinning the extension to the toolbar is recommended: click the puzzle piece icon, then click the pin next to "Full Page Screenshot".

## Usage

1. Open the page you want to capture.
2. Click the toolbar button and choose:
   - **Full page**: the button shows the progress (%) while capturing. **Stay on this tab until it finishes.**
   - **Visible area**: captures just what's on screen, without the address bar and browser toolbars. Nothing scrolls.
   - **Select area**: the screen freezes and dims. Drag with the mouse to select the area to capture, and release to finish. Press Esc to cancel.
3. When it's done, a new tab opens with a preview. Add boxes, arrows, text and other annotations if you like, then click **Download** to save it (as PNG or JPEG), or **Copy** to paste it straight into a chat or document.

### Annotations

You can annotate the image right on the preview page. Pick a tool in the toolbar, then drag or click on the image:

| Tool | How |
| --- | --- |
| **Box** | Drag out the area |
| **Arrow** | Drag from the start to where the arrow should point |
| **Text** | Click and type; Enter finishes, Shift+Enter starts a new line, Esc cancels. Double-click existing text to change it |
| **Number** | Click to place a numbered marker. Markers count up in the order they're placed, and renumber when one is removed |
| **Mosaic** | Drag out the area to pixelate (account names, email addresses, amounts and the like) |

- **Color**: red, green, blue, yellow, orange, black or white, or **Custom** for any color.
- **Size**: small, medium or large. It sets the line width, the text size, the marker size and the mosaic block size (as they look on screen, on high-resolution displays too).
- **Move and resize**: drag an annotation to move it. Click one to select it: boxes, mosaics and arrows then show handles you can drag to resize them or move the arrow's ends.
- **Remove**: click to select and press Delete; **Undo** (or Ctrl+Z) takes back the last one added; **Clear all** removes them all. Press Esc to cancel a drag.

Annotations are shown on the preview and **merged into the image** when you click **Download** or **Copy**. Without annotations, you get the original screenshot. They're saved in the browser with the screenshot, so they're still there when you close and reopen the preview (only the 3 most recent screenshots are kept).

### Download format

**Format** in the toolbar picks **PNG** (the default, lossless) or **JPEG** (much smaller, better for chats and email). With JPEG, a slider sets the quality, from 50% to 100% (90% by default). The choice is remembered for the next preview. **Copy** always uses PNG, the only image format the clipboard takes.

### Keyboard shortcuts

| Action | Default shortcut |
| --- | --- |
| Full page | Alt+Shift+F |
| Visible area | Alt+Shift+V |
| Select area | Alt+Shift+S |

On a Mac, Alt is the Option key. If another extension already uses a key, Chrome doesn't assign it; you can change or set the shortcuts at `chrome://extensions/shortcuts`.

### Settings

Click the toolbar button and choose **Settings** (or right-click the button and choose **Options**) to change the most screens a full page capture takes: 50 by default, from 1 to 200. Higher numbers take longer and make more images: on a 4K display, 200 screens take about 3 minutes. With Chrome sync on, the setting follows you to your other computers.


## How scrolling is handled in full page captures

Chrome can only capture what's currently visible, so the extension:

- Starts at the top of the page, scrolls one screen at a time taking a screenshot each time, then stitches all the screens together by scroll position.
- **Fixed elements**: headers and sidebars appear only in the first screen (a sidebar taller than the window is cut off at its bottom, as on screen), and elements fixed to the bottom (such as cookie banners and floating buttons) appear only in the last screen, so they aren't repeated in the image. Some pages (Magento's admin, for one) pin a toolbar with JavaScript only once it's scrolled out of view, so the check runs again before every screen.
- **Sticky elements**: temporarily switched back to normal layout while capturing, so they appear only in their original position instead of sticking to the top of every screen.
- **Smooth scrolling**: temporarily turned off while capturing, so screens aren't captured mid-animation.
- **Scrollbars**: temporarily hidden while capturing, so they don't appear in the image.
- **Lazy-loaded images**: after each scroll, it waits for the images on screen to load (up to 1.5 seconds) before taking the screenshot.
- **Pages that scroll an inner element**: on some pages (app-style layouts like Gmail or Notion), a section inside the page scrolls rather than the whole window. In that case it automatically finds the main scrolling section and captures its full content.
- **Pages that load more content as you scroll** (infinite scroll, such as the Yahoo home page or social media feeds): it keeps capturing the newly loaded content, **stopping at the number of screens in the settings (50 by default)**, and the preview page tells you.

When the capture finishes, the scroll position and styles are restored to how they were.

## Limitations

- **Full page captures have a screen limit**: 50 by default, adjustable from 1 to 200 in the settings. Infinite scroll pages (such as social media feeds) keep loading new content, and very long regular pages are treated the same way. The capture stops at the limit, and the preview page tells you.
- **Tall images are split into several**: a single image can be at most 16384 pixels tall. Longer captures (more than about 20 screens on a typical display, fewer on high-resolution displays) are split top to bottom into several images, and the preview page lets you download them all at once.
- **Select area only covers what's on screen**: to select another part, scroll there first, or use a full page capture.
- **Only page content is captured**: not the browser toolbar, other windows or the desktop.
- **Pages that can't be captured**: Chrome doesn't let extensions access browser pages starting with `chrome://`, the Chrome Web Store, or some built-in viewers.
- **Local files** (`file://`): turn on "Allow access to file URLs" in the extension's details on `chrome://extensions`.
- Only vertical scrolling is captured. If the page also scrolls horizontally, only the currently visible width is captured.
- Capture speed is limited by Chrome (at most 2 screenshots per second), so each screen takes about 0.5 seconds or more, and a full 50 screens takes 30 seconds or more.
- Only the 3 most recent screenshots are kept, so download them from the preview page promptly.

## Permissions

- `activeTab`: access to the current tab to take the screenshot, only when you click the button or press a shortcut.
- `scripting`: runs the code that scrolls the page, adjusts its styles and shows the area selection.
- `storage`: keeps your settings (the screen limit, the download format).

It doesn't need permission to "read all your data on all websites", and it never sends any data over the network. Screenshots stay in your browser.

## Development

```
extension/               ← load this folder in Chrome
  manifest.json
  background.js          capture flow: full page (scroll, screenshot, stitch,
                         split), visible area (screenshot) and area (screenshot, crop)
  popup/                 menu shown when the toolbar button is clicked
  options/               settings page
  content/capture-helper.js
                         injected into the page: finds the scrolling section,
                         handles fixed/sticky, scrolls, restores
  content/area-select.js injected into the page: shows the frozen screen for
                         selecting an area
  lib/settings.js        user settings (the screen limit, the download format and quality)
  lib/store.js           hands screenshots to the preview page via IndexedDB, and keeps the annotations
  result/                preview, annotation, download and copy page
  result/annotate.js     draws boxes, arrows, text, numbers and mosaics on the images and merges them in on output
  _locales/              English and Traditional Chinese UI text
tests/
  e2e.mjs                end-to-end tests
  pages/                 test pages
```

### Tests

The tests use Playwright to launch Chromium, load the extension, capture the test pages in `tests/pages` (full page, visible area and selected areas), and check the colors of the images row by row. They also add, move and resize annotations on the preview, check the copied and downloaded images, and check that the annotations are back after the preview is reopened. Everything runs at both 1x and 2x display scaling.

```sh
npm install
npx playwright install chromium   # needed the first time
npm test
HEADED=1 npm test                 # watch it run in a window
TEST=boxes npm test               # only the tests whose name contains "boxes"
```

Captured images are saved in `test-output/` so you can open and inspect them.

## Author

Joe Wu
