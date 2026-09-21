const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {readFileSync, readdirSync} = require('node:fs');
const {join} = require('node:path');

const root = join(__dirname, '..', 'extension');
const read = name => readFileSync(join(root, name), 'utf8');
const locales = {zh: 'zh_CN', en: 'en', ja: 'ja'};
const messages = Object.fromEntries(Object.entries(locales).map(([language, locale]) =>
  [language, JSON.parse(read(join('_locales', locale, 'messages.json')))]));

test('every locale defines exactly the same keys', () => {
  const reference = Object.keys(messages.zh).sort();
  for (const [language, table] of Object.entries(messages)) {
    assert.deepEqual(Object.keys(table).sort(), reference, language);
    for (const [key, entry] of Object.entries(table)) {
      assert.equal(typeof entry.message, 'string', `${language}.${key}`);
      assert.ok(entry.message.trim().length, `${language}.${key} is empty`);
    }
  }
});

test('placeholders match across locales', () => {
  const slots = text => (text.match(/\$\d/g) || []).sort().join('');
  for (const key of Object.keys(messages.zh)) {
    const expected = slots(messages.zh[key].message);
    for (const language of Object.keys(messages)) {
      assert.equal(slots(messages[language][key].message), expected, `${key} in ${language}`);
    }
  }
});

test('the generated table matches _locales', () => {
  const context = {};
  new (require('node:vm').Script)(read('messages.js')).runInNewContext(context);
  const table = context.globalThis?.FXMessages ?? context.FXMessages;
  for (const [language, entries] of Object.entries(messages)) {
    for (const [key, entry] of Object.entries(entries)) {
      assert.equal(table[language][key], entry.message, `${language}.${key}`);
    }
  }
});

test('every key used by the extension exists, and every key is used', () => {
  const files = readdirSync(root).filter(name => name.endsWith('.js') && name !== 'messages.js');
  const sources = files.map(read).join('\n') + read('popup.html') + read('options.html');
  const used = new Set();
  const direct = new Set();
  for (const match of sources.matchAll(/\bt\(\s*["'`]([A-Za-z0-9]+)["'`]/g)) direct.add(match[1]);
  // Also catches t(flag ? "a" : "b", value); comparison literals in the same call
  // are filtered out below by intersecting with the defined keys.
  for (const call of sources.matchAll(/\bt\(([^)]*)\)/g)) {
    for (const literal of call[1].matchAll(/["'`]([A-Za-z0-9]+)["'`]/g)) used.add(literal[1]);
  }
  for (const match of sources.matchAll(/data-i18n(?:-attr)?="([^"]+)"/g)) {
    for (const part of match[1].split(',')) used.add(part.includes(':') ? part.split(':')[1].trim() : part.trim());
  }
  for (const extra of ['range1', 'range7', 'range30', 'range90', 'interval30', 'interval60',
    'interval180', 'interval360', 'sizeS', 'sizeM', 'sizeL', 'modeSimple', 'modeDetail',
    'cardSize', 'cardMode', 'hoverTargetLabel', 'langZh', 'langEn', 'langJa',
    'extensionName', 'extensionDescription']) used.add(extra);
  // Lookup tables such as hover.js's KEYS map reference keys as plain values.
  for (const match of sources.matchAll(/(?:[A-Za-z]+|"[^"]+"|'[^']+'):\s*["']([a-zA-Z]+)["']/g)) {
    if (match[1] in messages.zh) used.add(match[1]);
  }

  const defined = new Set(Object.keys(messages.zh));
  const missing = [...direct].filter(key => !defined.has(key));
  assert.deepEqual(missing, [], 'used but not translated');
  const unused = [...defined].filter(key => !used.has(key));
  assert.deepEqual(unused, [], 'translated but never used');
});

for (const language of ['zh', 'en', 'ja']) {
  for (const failed of [false, true]) {
    test(`popup ${language}, connection failure=${failed}`, async () => {
      const dom = new JSDOM(read('popup.html'), {runScripts: 'outside-only', url: 'https://test.invalid'});
      const w = dom.window;
      w.chrome = {storage: {local: {get: async defaults => ({...defaults, language}), set: async () => {}}}, runtime: {openOptionsPage() {}}};
      w.fetch = async url => {
        if (failed) throw new w.TypeError('Failed to fetch');
        if (url.endsWith('/pairs')) return {ok: true, json: async () => ['USD/CNY', 'USD/JPY', 'CNY/JPY']};
        return {ok: true, json: async () => url.includes('comparisons')
          ? {official: [{institution: 'European Central Bank', rate: '7.1', reference_date: '2026-09-20', is_derived: true}]}
          : url.includes('history') ? []
          : ['USD/CNY', 'USD/JPY', 'CNY/JPY'].map(pair => ({
              base_currency: pair.split('/')[0], quote_currency: pair.split('/')[1],
              midpoint: 7, bid: 6.99, ask: 7.01, provider: 'alpha_vantage',
              captured_at: '2026-09-20T00:00:00Z', change_percent: null,
            }))};
      };
      w.eval(read('messages.js'));
      w.eval(read('i18n.js'));
      w.eval(read('popup.js'));
      await new Promise(resolve => setTimeout(resolve, 120));
      assert.equal(w.document.documentElement.lang, {zh: 'zh-CN', en: 'en', ja: 'ja'}[language]);
      const text = w.document.body.textContent;
      if (language === 'en') assert.doesNotMatch(text, /[\u3400-\u9fff]/);
      if (language === 'ja') assert.doesNotMatch(text, /自选|暂无|正在|已更新|设置|连接|买入|卖出/);
      if (language === 'zh') assert.doesNotMatch(text, /MARKET MIDPOINT|QUICK CONVERTER|BID|ASK|Failed to fetch/);
      // No element is left showing a raw key instead of its translation.
      const keys = new Set(Object.keys(messages.zh));
      for (const node of w.document.querySelectorAll('body *')) {
        assert.ok(!keys.has(node.textContent.trim()), `untranslated key on screen: ${node.textContent.trim()}`);
      }
      if (!failed) {
        assert.equal(w.document.querySelectorAll('.rate-card').length, 3);
        assert.match(w.document.querySelector('.rate-card strong').textContent, /7/);
        assert.equal(w.document.getElementById('error').classList.contains('hidden'), true);
      } else {
        assert.doesNotMatch(w.document.getElementById('chart').textContent, /载入|Loading|読み込み/);
      }
      dom.window.close();
    });
  }
}
