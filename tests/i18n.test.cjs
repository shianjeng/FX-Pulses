const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const read = name => readFileSync(join(__dirname, '../extension', name), 'utf8');
for (const language of ['zh','en','ja']) {
  for (const failed of [false,true]) {
    test(`popup ${language}, connection failure=${failed}`, async () => {
      const dom = new JSDOM(read('popup.html'), {runScripts:'outside-only', url:'https://test.invalid'});
      const w = dom.window;
      w.chrome = {storage:{local:{get:async defaults => ({...defaults,language}),set:async()=>{}}},runtime:{openOptionsPage(){}}};
      w.fetch = async url => {
        if (failed) throw new Error('Failed to fetch');
        return {ok:true,json:async()=>url.includes('comparisons') ? {official:[{institution:'European Central Bank',rate:'7.1',reference_date:'2026-09-20',is_derived:true}]} : url.includes('history') ? [] : ['USD/CNY','USD/JPY','CNY/JPY'].map(pair=>({base_currency:pair.split('/')[0],quote_currency:pair.split('/')[1],midpoint:7,bid:6.99,ask:7.01,provider:'alpha_vantage',captured_at:'2026-09-20T00:00:00Z',change_percent:null}))};
      };
      w.eval(read('i18n.js'));
      w.eval(read('popup.js'));
      await new Promise(resolve=>setTimeout(resolve,80));
      assert.equal(w.document.documentElement.lang, {zh:'zh-CN',en:'en',ja:'ja'}[language]);
      const text = w.document.body.textContent;
      if(language==='en') assert.doesNotMatch(text, /[\u3400-\u9fff]/);
      if(language==='ja') assert.doesNotMatch(text, /自选|暂无|正在|已更新|设置|连接|买入|卖出/);
      if(language==='zh') assert.doesNotMatch(text, /MARKET MIDPOINT|QUICK CONVERTER|BID|ASK|Failed to fetch/);
      if(!failed) assert.equal(w.document.querySelectorAll('.rate-card').length,3);
      else assert.doesNotMatch(w.document.getElementById('chart').textContent,/载入|Loading|読み込み/);
      dom.window.close();
    });
  }
}
