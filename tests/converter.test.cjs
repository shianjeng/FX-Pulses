const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');

/* The converter works both ways. Either box takes a figure, and the other is
   worked out from it: 1,000 CNY reads 23,533 JPY, and typing 47,066 into the
   yen box reads 2,000.00 CNY. The box typed into last keeps its figure while
   the currencies change or swap round, and the other box follows. */

const source = name => readFileSync(join(__dirname, '../extension', name), 'utf8');
const tick = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const quote = (base_currency, quote_currency, midpoint) => ({base_currency, quote_currency, midpoint,
  bid: midpoint, ask: midpoint, provider: 'alpha_vantage', captured_at: new Date().toISOString(), is_stale: false});
const response = data => ({ok: true, json: async () => data});

async function popup(t) {
  const dom = new JSDOM(source('popup.html'), {runScripts: 'outside-only', url: 'https://test.invalid'});
  t.after(() => dom.window.close());
  const w = dom.window;
  const state = {watchlist: ['CNY/JPY'], targets: {}, apiUrl: 'https://api.invalid', converterFrom: 'CNY', converterTo: 'JPY'};
  w.chrome = {storage: {local: {get: async defaults => ({...defaults, ...state}), set: async values => Object.assign(state, values)}},
    runtime: {openOptionsPage() {}}};
  w.fetch = async url => {
    if (url.endsWith('/pairs')) return response(['USD/CNY', 'USD/JPY', 'CNY/JPY']);
    if (url.endsWith('/rates')) return response([quote('CNY', 'JPY', '23.533'), quote('USD', 'CNY', '7.1'), quote('USD', 'JPY', '167.0843')]);
    if (url.endsWith('/currencies')) return response({official_currencies: ['CNY', 'JPY', 'USD']});
    return response([]);
  };
  for (const name of ['config.js', 'messages.js', 'i18n.js', 'popup.js']) w.eval(source(name));
  await tick();
  const el = id => w.document.getElementById(id);
  const type = (id, value) => { el(id).value = value; el(id).dispatchEvent(new w.Event('input')); };
  const computed = id => el(id).parentElement.classList.contains('computed');
  return {w, el, type, computed};
}

test('typing in the second box converts back into the first currency', async t => {
  const {el, type, computed} = await popup(t);
  assert.equal(el('converted').value, '23,533');
  assert.equal(el('from-code').textContent, 'CNY');
  assert.equal(el('to-code').textContent, 'JPY');
  assert.ok(computed('converted') && !computed('amount'));

  type('converted', '47,066');
  assert.equal(el('amount').value, '2,000.00');
  // The worked-out figure is the result now, and the labels say so.
  assert.ok(computed('amount') && !computed('converted'));
  assert.equal(el('from-label').textContent, '换算结果 (CNY)');
  assert.equal(el('to-label').textContent, '金额 (JPY)');

  // Typing in the first box again turns it back round.
  type('amount', '400');
  assert.equal(el('converted').value, '9,413');
  assert.equal(el('from-label').textContent, '金额 (CNY)');
  assert.ok(computed('converted'));
});

test('the box typed in keeps its figure when the currencies swap or change', async t => {
  const {el, type, w} = await popup(t);
  type('converted', '23,533');
  assert.equal(el('amount').value, '1,000.00');

  el('reverse-button').click();
  await tick();
  // JPY/CNY now: the 23,533 typed stays put, in yuan, and the yen box follows.
  assert.equal(el('converted').value, '23,533');
  assert.equal(el('to-code').textContent, 'CNY');
  assert.equal(el('amount').value, '553,802');

  el('converter-from').value = 'USD';
  el('converter-from').dispatchEvent(new w.Event('change'));
  await tick();
  assert.equal(el('converted').value, '23,533');
  assert.equal(el('amount').value, (23533 / 7.1).toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2}));
});

test('grouped and full-width figures are read; anything else is refused', async t => {
  const {el, type} = await popup(t);
  type('amount', '１，０００');
  assert.equal(el('converted').value, '23,533');
  type('amount', '1 000');
  assert.equal(el('converted').value, '23,533');
  assert.equal(el('amount-error').textContent, '');

  for (const figure of ['abc', '-5', '1.2.3', '2000000000000']) {
    type('converted', figure);
    assert.equal(el('amount').value, '', figure);
    assert.equal(el('amount-error').textContent, '请输入0到1万亿之间的有效金额', figure);
  }
  type('converted', '0');
  assert.equal(el('amount').value, '0.00');
  assert.equal(el('amount-error').textContent, '');
});
