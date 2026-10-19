const {test} = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {existsSync, mkdtempSync, readFileSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');

/* The Firefox edition is built from extension/, which stays the one source:
   only the manifest differs. */

const read = name => readFileSync(join(__dirname, '../extension', name), 'utf8');
const build = () => import('../tools/build-firefox.mjs');

test('the Firefox manifest is the Chrome one with Firefox\'s differences', async () => {
  const {firefoxManifest, GECKO_ID, FIREFOX_MIN} = await build();
  const chrome = JSON.parse(read('manifest.json'));
  const firefox = firefoxManifest(chrome, read('background.js'));
  // An event page loads, in order, what the service worker imports.
  assert.deepEqual(firefox.background, {scripts: ['config.js', 'messages.js', 'amount-parser.js', 'background.js']});
  assert.deepEqual(firefox.options_ui, {page: 'options.html', open_in_tab: true});
  assert.equal('options_page' in firefox, false);
  assert.equal('minimum_chrome_version' in firefox, false);
  assert.equal(JSON.stringify(firefox.web_accessible_resources).includes('use_dynamic_url'), false);
  assert.equal(firefox.browser_specific_settings.gecko.id, GECKO_ID);
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, FIREFOX_MIN);
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions, {required: ['none']});
  // Everything else, permissions and version included, is the Chrome manifest's.
  const changed = ['background', 'minimum_chrome_version', 'options_page', 'web_accessible_resources'];
  for (const key of Object.keys(chrome).filter(key => !changed.includes(key))) assert.deepEqual(firefox[key], chrome[key], key);
  assert.equal(chrome.background.service_worker, 'background.js', 'the Chrome manifest is left as it was');
});

test('a worker that stops naming its imports fails the build instead of shipping without them', async () => {
  const {firefoxManifest} = await build();
  assert.throws(() => firefoxManifest(JSON.parse(read('manifest.json')), '/* no imports */'), /no longer names/);
});

test('the build writes a complete copy', () => {
  const out = mkdtempSync(join(tmpdir(), 'fx-firefox-'));
  try {
    execFileSync(process.execPath, [join(__dirname, '../tools/build-firefox.mjs'), '--out', out]);
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    for (const file of [...manifest.background.scripts, manifest.options_ui.page, manifest.action.default_popup,
      ...Object.values(manifest.icons), '_locales/zh_CN/messages.json', 'hover.js']) {
      assert.ok(existsSync(join(out, file)), file);
    }
    assert.equal(readFileSync(join(out, 'popup.js'), 'utf8'), read('popup.js'));
  } finally { rmSync(out, {recursive: true, force: true}); }
});
