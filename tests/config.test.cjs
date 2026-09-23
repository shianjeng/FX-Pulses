const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync, readdirSync} = require('node:fs');
const {join} = require('node:path');
const root = join(__dirname, '../extension');
const read = name => readFileSync(join(root, name), 'utf8');

/* The backend address used to be repeated in four files. Pointing a build at a
   hosted backend then meant four edits, and missing one left a component
   silently talking to localhost. These tests keep the single source honest. */

test('only config.js names the backend address', () => {
  const offenders = readdirSync(root)
    .filter(name => name.endsWith('.js') && name !== 'config.js')
    .filter(name => /\blocalhost:\d+|127\.0\.0\.1:\d+/.test(read(name)));
  assert.deepEqual(offenders, [], `hardcoded backend address outside config.js: ${offenders.join(', ')}`);
});

test('every page that reads FXConfig loads config.js before its own script', () => {
  for (const page of ['popup.html', 'options.html']) {
    const html = read(page);
    const script = page.replace('.html', '.js');
    const configAt = html.indexOf('<script src="config.js">');
    assert.notEqual(configAt, -1, `${page} does not load config.js`);
    assert.ok(configAt < html.indexOf(`<script src="${script}">`), `${page} loads config.js too late`);
  }
});

test('the background worker imports config.js before using it', () => {
  const source = read('background.js');
  const imported = source.match(/importScripts\(([^)]*)\)/);
  assert.ok(imported, 'background.js does not call importScripts');
  assert.ok(imported[1].includes('"config.js"'), 'background.js does not import config.js');
  assert.ok(source.indexOf('importScripts') < source.indexOf('FXConfig'), 'background.js reads FXConfig before importing it');
});

test('the shipped default backend is covered by manifest host permissions', () => {
  const url = new URL(read('config.js').match(/defaultApiUrl:\s*"([^"]+)"/)[1]);
  const granted = JSON.parse(read('manifest.json')).host_permissions ?? [];
  // A default the extension has no permission to call fails every request at
  // install time, which is why tools/check-config.mjs also guards this in CI.
  assert.ok(
    granted.some(pattern => pattern === `${url.origin}/*`),
    `host_permissions ${JSON.stringify(granted)} do not cover ${url.origin}`,
  );
});
