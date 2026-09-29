const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const root = join(__dirname, '../extension');

test('icon PNGs have the correct sizes and are registered for both extension and toolbar', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  for (const size of [16, 32, 48, 128]) {
    const path = `icons/${size}.png`;
    const bytes = readFileSync(join(root, path));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
    assert.equal(manifest.icons[size], path);
    assert.equal(manifest.action.default_icon[size], path);
  }
});

test('popup and settings use the same local FX monogram logo', () => {
  const svg = readFileSync(join(root, 'icons/icon.svg'), 'utf8');
  assert.match(svg, /M22\.25 86V42H45\.25M22\.25 62\.24H41\.11/);
  // the rising (green) and falling (red) arrowheads meet on the centre line
  assert.match(svg, /M83\.75 42H105\.75V64" stroke="#0b8a6f"/);
  assert.match(svg, /M83\.75 86H105\.75V64" stroke="#c53650"/);
  assert.doesNotMatch(svg, /<script|<image|<foreignObject/);
  for (const file of ['popup.html', 'options.html']) {
    assert.match(readFileSync(join(root, file), 'utf8'), /class="brand-logo" src="icons\/icon.svg"/);
  }
});
