const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {JSDOM} = require('jsdom');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');

/* Whether to talk to a running API or read static files is a property of the
   backend, not of the build. Switching the shipped default to a static host
   must not change how a user's own server is reached, and the options page has
   to be able to save a static host at all. */

const source = name => readFileSync(join(__dirname, '../extension', name), 'utf8');
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const BASE = 'https://example.org/api/v1';
const ok = data => ({ok: true, status: 200, json: async () => data});
const quote = {base_currency: 'USD', quote_currency: 'CNY', midpoint: '7.1', bid: '7.09', ask: '7.11',
  provider: 'alpha_vantage', captured_at: new Date().toISOString(), is_stale: false};
const meta = {generated_at: new Date().toISOString(), provider: 'alpha_vantage', stale_after_minutes: 360, collector: []};

function worker({defaultMode, stored = {}}) {
  const calls = [];
  const event = () => { const l = []; return {addListener: fn => l.push(fn), listeners: l}; };
  const chrome = {
    storage: {local: {async get(keys) { return typeof keys === 'string' ? {} : {...keys, ...stored}; }, async set() {}, async remove() {}},
      onChanged: event()},
    runtime: {id: 'test', getURL: p => `chrome-extension://test/${p}`, onMessage: event(), onInstalled: event(), onStartup: event()},
    permissions: {contains: async () => true, onRemoved: event()},
    scripting: {getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}},
  };
  const context = vm.createContext({chrome, URL, URLSearchParams, console, setTimeout, clearTimeout: globalThis.clearTimeout,
    AbortController: globalThis.AbortController,
    importScripts: (...names) => names.forEach(name => {
      vm.runInContext(source(name), context);
      if (name === 'config.js') Object.assign(context.FXConfig, {defaultApiUrl: BASE, backendMode: defaultMode});
    }),
    fetch: async url => {
      calls.push(url.slice(BASE.length));
      return ok(url.includes('pairs') ? ['USD/CNY'] : url.includes('meta') ? meta : [quote]);
    }});
  context.globalThis = context;
  vm.runInContext(source('background.js'), context);
  const send = message => new Promise(resolve => {
    if (!chrome.runtime.onMessage.listeners[0](message, {id: 'test', url: 'chrome-extension://test/popup.html'}, resolve)) resolve({ok: false});
  });
  return {send, calls};
}

test('the untouched default follows config.js', async () => {
  const w = worker({defaultMode: 'static'});
  await w.send({type: 'FX_SNAPSHOT'});
  assert.ok(w.calls.includes('/pairs.json'), w.calls.join(','));
});

test('a server saved before modes existed stays an API when the default turns static', async () => {
  const w = worker({defaultMode: 'static', stored: {apiUrl: BASE}});
  await w.send({type: 'FX_SNAPSHOT'});
  assert.ok(w.calls.includes('/pairs') && w.calls.includes('/rates'), w.calls.join(','));
  assert.ok(!w.calls.some(path => path.endsWith('.json')), w.calls.join(','));
});

test('a static host the user saved is read as files under an API default', async () => {
  const w = worker({defaultMode: 'api', stored: {apiUrl: BASE, backendMode: 'static'}});
  await w.send({type: 'FX_SNAPSHOT'});
  assert.ok(w.calls.includes('/pairs.json') && w.calls.includes('/rates.json'), w.calls.join(','));
});

async function options(t, routes) {
  const dom = new JSDOM(source('options.html'), {runScripts: 'outside-only', url: 'https://test.invalid'});
  t.after(() => dom.window.close());
  const w = dom.window, state = {}, calls = [];
  w.chrome = {storage: {local: {get: async d => d, set: async v => Object.assign(state, v)}},
    permissions: {request: async () => true}};
  w.fetch = async url => {
    calls.push(url);
    const hit = Object.entries(routes).find(([suffix]) => url.endsWith(suffix));
    if (!hit) return {ok: false, status: 404, json: async () => ({})};
    return typeof hit[1] === 'number' ? {ok: false, status: hit[1], json: async () => ({})} : ok(hit[1]);
  };
  for (const name of ['config.js', 'messages.js', 'i18n.js', 'options.js']) w.eval(source(name));
  await tick();
  const submit = async value => {
    w.document.getElementById('api-url').value = value;
    w.document.getElementById('settings-form').dispatchEvent(new w.Event('submit', {cancelable: true}));
    await tick();
  };
  return {state, calls, submit, result: () => w.document.getElementById('result').textContent};
}

test('the options page saves a static host and remembers its mode', async t => {
  const page = await options(t, {'/meta.json': meta, '/pairs.json': ['USD/CNY'], '/rates.json': [quote]});
  await page.submit('https://example.org/api/v1');
  assert.deepEqual(page.calls, [
    'https://example.org/health',
    'https://example.org/api/v1/meta.json',
    'https://example.org/api/v1/pairs.json',
    'https://example.org/api/v1/rates.json',
  ]);
  assert.equal(page.state.apiUrl, 'https://example.org/api/v1');
  assert.equal(page.state.backendMode, 'static');
});

test('a running API is saved as an API without probing for files', async t => {
  const page = await options(t, {'/health': {status: 'ok', provider: 'alpha_vantage'}, '/pairs': ['USD/CNY'], '/rates': [quote]});
  await page.submit('https://example.org');
  assert.equal(page.state.backendMode, 'api');
  assert.ok(!page.calls.some(url => url.includes('meta.json')), page.calls.join(','));
});

test('a real server error is reported, not mistaken for a static host', async t => {
  const page = await options(t, {'/health': 503});
  await page.submit('https://example.org');
  assert.deepEqual(page.calls, ['https://example.org/health']);
  assert.match(page.result(), /503/);
  assert.equal(page.state.apiUrl, undefined);
});

test('a host with neither /health nor meta.json is rejected', async t => {
  const page = await options(t, {});
  await page.submit('https://example.org');
  assert.equal(page.state.apiUrl, undefined);
  assert.match(page.result(), /404/);
});
