const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const read=name=>readFileSync(join(__dirname,'../extension',name),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
const pairs=['USD/CNY','USD/JPY','CNY/JPY'];
const quote=(midpoint=7)=>({base_currency:'USD',quote_currency:'CNY',midpoint,bid:midpoint-.01,ask:midpoint+.01,provider:'mock',captured_at:new Date().toISOString(),is_stale:false});
const response=data=>({ok:true,json:async()=>data});
async function popup(t,watchlist=pairs){
 const dom=new JSDOM(read('popup.html'),{runScripts:'outside-only',url:'https://test.invalid'});
 t.after(()=>dom.window.close());
 const w=dom.window,state={watchlist,targets:{'USD/CNY':{direction:'above',value:1}}};
 w.chrome={storage:{local:{get:async defaults=>({...defaults,...state}),set:async changes=>Object.assign(state,changes)}},runtime:{openOptionsPage(){}}};
 const other=url=>response(url.endsWith('/pairs')?pairs:url.includes('/comparisons/')?{official:[]}:[]);
 w.fetch=async url=>url.endsWith('/rates')?response([quote()]):other(url);
 w.eval(read('messages.js'));w.eval(read('i18n.js'));w.eval(read('popup.js'));await tick();
 return {w,state,other,el:id=>w.document.getElementById(id)};
}
test('late refresh cannot overwrite a more recent response',async t=>{
 const {w,other,el}=await popup(t);let finish,calls=0;
 w.fetch=async url=>!url.endsWith('/rates')?other(url):++calls===1?{ok:true,json:()=>new Promise(resolve=>finish=resolve)}:response([quote(8)]);
 const old=w.eval('loadData()');await tick();await w.eval('loadData()');finish([quote(6)]);await old;
 assert.equal(el('rates').querySelector('strong').textContent,'8.0000');
});
test('missing quotes remain selectable and saved preferences survive recovery',async t=>{
 const {w,state,other,el}=await popup(t,['USD/JPY']);
 assert.deepEqual(state.watchlist,['USD/JPY']);
 assert.match(el('rates').textContent,/等待采集/);
 assert.equal(el('watchlist-options').querySelectorAll('input').length,3);
 w.fetch=async url=>url.endsWith('/rates')?response([{...quote(150),quote_currency:'JPY'}]):other(url);
 await w.eval('loadData()');assert.match(el('rates').textContent,/150/);
 assert.deepEqual(state.watchlist,['USD/JPY']);
});
test('offline marks cards and converter, pauses target checks and recovery clears it',async t=>{
 const {w,el,other}=await popup(t);w.fetch=async()=>{throw new w.TypeError('Failed to fetch');};
 await w.eval('loadData()');assert.match(el('rates').textContent,/离线缓存/);
 assert.doesNotMatch(el('rates').textContent,/已更新/);
 assert.match(el('converter-status').textContent,/离线缓存/);
 assert.match(el('target-message').textContent,/暂停/);assert.equal(el('copy-button').disabled,true);
 w.fetch=async url=>url.endsWith('/rates')?response([quote()]):other(url);await w.eval('loadData()');
 assert.doesNotMatch(el('converter-status').textContent,/离线缓存/);assert.equal(el('copy-button').disabled,false);
});
test('single observation has no filled triangle; time spacing and gaps are respected',async t=>{
 const {w,el}=await popup(t);
 w.eval('drawChart([{midpoint:7,captured_at:"2026-09-20T00:00:00Z"}])');
 assert.match(el('chart').textContent,/仅有一个/);
 assert.equal(el('chart').querySelector('path').getAttribute('fill'),'none');
 assert.doesNotMatch(el('chart').querySelector('path').getAttribute('d'),/L|Z/);
 w.eval('drawChart([{midpoint:7,captured_at:"2026-09-13T00:00:00Z"},{midpoint:8,captured_at:"2026-09-13T00:01:00Z"},{midpoint:7,captured_at:"2026-09-20T00:00:00Z"}])');
 const d=el('chart').querySelector('path').getAttribute('d');
 assert.match(d,/L 0\.03 /);assert.match(d,/M 340\.00 /);assert.doesNotMatch(d,/C/);
});
test('empty, negative and excessive amounts are rejected; zero and reverse work',async t=>{
 const {w,el}=await popup(t);
 for(const amount of ['','-1','1000000000001','1e309']){
  el('amount').value=amount;w.eval('updateConverter()');assert.equal(el('converted').textContent,'—');assert.ok(el('amount-error').textContent);
 }
 el('amount').value='0';w.eval('updateConverter()');assert.equal(el('converted').textContent,'0.00 CNY');
 el('amount').value='700';el('reverse-button').click();assert.equal(el('converted').textContent,'100.00 USD');
});
test('an empty but reachable API is waiting, not a connection error',async t=>{
 const {w,other,el}=await popup(t);w.fetch=async url=>url.endsWith('/rates')?response([]):other(url);
 await w.eval('loadData()');assert.equal(el('status').textContent,'等待采集');assert.ok(el('error').classList.contains('hidden'));
 assert.equal(el('converted').textContent,'—');
});
test('HTTP rate limiting is distinguished from network errors',async t=>{
 const {w,el}=await popup(t);w.fetch=async()=>({ok:false,status:429});await w.eval('loadData()');assert.match(el('error').textContent,/频繁/);
});
test('late history for the previous pair cannot replace the selected pair chart',async t=>{
 const {w,other,el}=await popup(t);let finish;
 w.fetch=async url=>url.includes('/USD/CNY/history')?{ok:true,json:()=>new Promise(resolve=>finish=resolve)}:url.includes('/USD/JPY/history')?response([{midpoint:150,captured_at:new Date().toISOString()}]):other(url);
 const old=w.eval('selectPair("USD/CNY")');await tick();await w.eval('selectPair("USD/JPY")');
 finish([{midpoint:7,captured_at:new Date().toISOString()}]);await old;
 assert.match(el('trend-title').textContent,/USD\/JPY/);
 assert.equal(el('chart').querySelector('svg').getAttribute('aria-label'),'USD/JPY 七日走势图');
 assert.equal(el('stat-low').textContent,'150.000');
});
async function options(t,{permission=true,data={}}={}){
 const dom=new JSDOM(read('options.html'),{runScripts:'outside-only',url:'https://test.invalid'});t.after(()=>dom.window.close());
 const w=dom.window,state={},calls=[];
 w.chrome={storage:{local:{get:async defaults=>defaults,set:async changes=>Object.assign(state,changes)}},permissions:{request:async()=>permission}};
 w.fetch=async url=>{calls.push(url);if(data.status)return {ok:false,status:data.status};return response(url.endsWith('/health')?{status:'ok',provider:'alpha_vantage'}:url.endsWith('/pairs')?pairs: data.rates ?? [quote()]);};
 w.eval(read('messages.js'));w.eval(read('i18n.js'));w.eval(read('options.js'));await tick();
 const submit=async value=>{w.document.getElementById('api-url').value=value;w.document.getElementById('settings-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();};
 return {w,state,calls,submit,result:()=>w.document.getElementById('result').textContent};
}
test('settings normalize root URL and test actual pairs and rates before saving',async t=>{
 const a=await options(t);await a.submit('https://example.org/');
 assert.equal(a.state.apiUrl,'https://example.org/api/v1');
 assert.deepEqual(a.calls,['https://example.org/health','https://example.org/api/v1/pairs','https://example.org/api/v1/rates']);
});
test('settings reject an HTTP-200 response with wrong schema',async t=>{
 const a=await options(t,{data:{rates:{html:'not rates'}}});await a.submit('https://example.org');
 assert.equal(a.state.apiUrl,undefined);assert.match(a.result(),/格式错误/);
});
test('settings save an empty valid API with a first-collection message',async t=>{
 const a=await options(t,{data:{rates:[]}});await a.submit('https://example.org');
 assert.match(a.result(),/首次采集/);assert.ok(a.state.apiUrl);
});
test('settings distinguish permission denial and HTTP errors',async t=>{
 const denied=await options(t,{permission:false});await denied.submit('https://example.org');assert.match(denied.result(),/权限/);assert.equal(denied.state.apiUrl,undefined);
 const unavailable=await options(t,{data:{status:503}});await unavailable.submit('https://example.org');assert.match(unavailable.result(),/503/);assert.equal(unavailable.state.apiUrl,undefined);
});
