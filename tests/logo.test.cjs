const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const root = join(__dirname, '../extension');

test('scheme B PNGs have the correct sizes and are registered for both extension and toolbar', () => {
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

test('popup and settings use the same local scheme B vector logo', () => {
  const svg = readFileSync(join(root, 'icons/icon.svg'), 'utf8');
  assert.match(svg, /M32 50h54l-16-16/);
  assert.match(svg, /M96 78H42l16 16/);
  assert.doesNotMatch(svg, /<script|<image|<foreignObject/);
  for (const file of ['popup.html', 'options.html']) {
    assert.match(readFileSync(join(root, file), 'utf8'), /class="brand-logo" src="icons\/icon.svg"/);
  }
});
