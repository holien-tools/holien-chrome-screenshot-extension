// The user's settings, in chrome.storage.sync so they follow their Chrome profile.

// Most screens per full page capture. Pages that keep loading more content as
// they're scrolled (infinite scroll) never end, and very long pages take a
// long time, so every capture stops here. Each screen takes about half a
// second, and the screenshots are held in memory until they're stitched.
export const MAX_SCREENS = { default: 50, min: 1, max: 200 };

// Image format for downloads from the result page. Copying is always PNG,
// which is the only image format the clipboard takes.
export const FORMATS = { png: { type: 'image/png', extension: 'png', label: 'PNG' }, jpeg: { type: 'image/jpeg', extension: 'jpg', label: 'JPEG' } };
export const JPEG_QUALITY = { default: 90, min: 50, max: 100, step: 5 };

const DEFAULTS = { maxScreens: MAX_SCREENS.default, format: 'png', jpegQuality: JPEG_QUALITY.default };

export async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return {
    maxScreens: validMaxScreens(stored.maxScreens) ?? MAX_SCREENS.default,
    format: stored.format in FORMATS ? stored.format : DEFAULTS.format,
    jpegQuality: validQuality(stored.jpegQuality) ?? JPEG_QUALITY.default,
  };
}

export function saveSettings(settings) {
  return chrome.storage.sync.set(settings);
}

function validQuality(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= JPEG_QUALITY.min && n <= JPEG_QUALITY.max ? n : null;
}

// The value as a whole number of screens in range, or null.
export function validMaxScreens(value) {
  const n = typeof value === 'string' && !value.trim() ? NaN : Number(value);
  return Number.isInteger(n) && n >= MAX_SCREENS.min && n <= MAX_SCREENS.max ? n : null;
}
