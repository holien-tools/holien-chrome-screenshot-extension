// Colored bands with known colors, so tests/e2e.mjs can check every row of the
// screenshot. Keep bandColor in sync with the copy in tests/e2e.mjs.
function bandColor(i) {
  return `rgb(${((i * 53) % 200) + 30}, ${((i * 97) % 200) + 30}, ${((i * 151) % 200) + 30})`;
}

function addBands(parent, start, count, height) {
  for (let i = start; i < start + count; i++) {
    const band = document.createElement('div');
    // The label is kept clear of the pixel columns the test checks.
    band.style.cssText = `height: ${height}px; padding-left: 120px; background: ${bandColor(i)}; font: 20px sans-serif;`;
    band.textContent = `band ${i}`;
    parent.append(band);
  }
}
