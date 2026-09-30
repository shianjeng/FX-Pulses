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
  assert.match(svg, /M22 86V42H42M22 62H38/);
  // The rising (green) and falling (red) arrowheads stop short of the centre
  // line: meeting there, they read as one block at toolbar size.
  const rising = svg.match(/M88 42H106V(\d+)" stroke="#0b8a6f"/);
  const falling = svg.match(/M88 86H106V(\d+)" stroke="#c53650"/);
  assert.ok(rising && falling, 'both arrowheads present');
  assert.ok(Number(falling[1]) - Number(rising[1]) >= 8, 'a visible gap between the arrowheads');
  // Straight strokes on 4n+2 land on whole pixels at 32 px.
  for (const value of [22, 42, 86, 62, 106]) assert.equal(value % 4, 2);
  assert.doesNotMatch(svg, /<script|<image|<foreignObject/);
  const small = readFileSync(join(root, 'icons/icon-16.svg'), 'utf8');
  assert.match(small, /viewBox="0 0 16 16"/);
  assert.match(small, /fill="#0b8a6f"/);
  assert.match(small, /fill="#c53650"/);
  assert.doesNotMatch(small, /<script|<image|<foreignObject/);
  for (const file of ['popup.html', 'options.html']) {
    assert.match(readFileSync(join(root, file), 'utf8'), /class="brand-logo" src="icons\/icon.svg"/);
  }
});
