// ==UserScript==
// @name         FX Pulse Hover（页面金额就地换算 · 调试版）
// @namespace    https://github.com/shianjeng/FX-Pulses
// @version      0.3.0
// @description  悬停页面金额就地换算：报纸风自适应配色、简单/详细模式、证据式币种识别。只读、不改页面、30 分钟缓存。
// @author       Hank
// @match        *://*/*
// @match        file:///*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      open.er-api.com
// @connect      api.frankfurter.app
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * v0.2.0 结构
 *   A. 纯逻辑层：金额解析 + 证据式混合币种识别（可在 node 下单测，见 node-check.mjs）
 *   B. 环境层：配置（GM 存储）、汇率取用与缓存
 *   C. 呈现层：Shadow DOM 卡片（简单/详细两种模式）、设置面板、主题注入
 *   D. 调试层：window.__fxph、油猴菜单、自检页联动（只通过共享 DOM 通信）
 *
 * 设计取舍
 *   1) 只在「光标真的落在金额文本上」时才弹：静置 dwellMs → 文本节点里有金额 → 金额矩形覆盖光标（±6px）。
 *   2) 必须有货币标记才认；裸数字一律不识别。
 *   3) 币种判断是**证据加权**而非 if-else：文字体系比重、语言标注、域名、全文货币标记普查、
 *      邻近上下文、页面关键词、用户记忆，各自贡献分数，取最高分并给出完整证据链（详细模式可见）。
 *   4) 币种有歧义时小窗出现「原始币种」下拉，用户校准后按域名记住。
 *   5) 绝不改站点 DOM，不注册 MutationObserver；样式全在 shadow root 里，靠 CSS 变量 + 可替换 CSS 供设计外包。
 */

(function () {
  'use strict';

  const VERSION = '0.3.0';
  try {
    console.log('%c[FXPH] FX Pulse Hover v' + VERSION + ' 开始执行（GM_info=' +
      (typeof GM_info !== 'undefined' ? 'yes' : 'no') + '）', 'color:#56e39f;font-weight:bold');
  } catch (e) { /* 忽略 */ }

  /* ==========================================================================
   * A. 纯逻辑层（无 DOM 依赖）
   * ========================================================================== */

  const CURRENCIES = {
    USD: { dec: 2, zh: '美元' },
    CNY: { dec: 2, zh: '人民币' },
    JPY: { dec: 0, zh: '日元' },
    EUR: { dec: 2, zh: '欧元' },
    GBP: { dec: 2, zh: '英镑' },
    HKD: { dec: 2, zh: '港元' },
    TWD: { dec: 0, zh: '新台币' },
    KRW: { dec: 0, zh: '韩元' },
    SGD: { dec: 2, zh: '新加坡元' },
    AUD: { dec: 2, zh: '澳元' },
    CAD: { dec: 2, zh: '加元' },
    NZD: { dec: 2, zh: '新西兰元' },
    SEK: { dec: 2, zh: '瑞典克朗' },
    NOK: { dec: 2, zh: '挪威克朗' },
    DKK: { dec: 2, zh: '丹麦克朗' },
    THB: { dec: 2, zh: '泰铢' },
    MYR: { dec: 2, zh: '林吉特' },
    PHP: { dec: 2, zh: '菲律宾比索' },
    VND: { dec: 0, zh: '越南盾' },
    INR: { dec: 2, zh: '印度卢比' },
    BRL: { dec: 2, zh: '巴西雷亚尔' },
  };

  /*
   * 标记表。code 为 null 表示「有歧义」，amb 是候选（第一个是默认倾向）。
   * 顺序不重要（构造正则时按长度降序），但同一个符号不要重复。
   */
  const MARKERS = [
    { p: 'US$', code: 'USD', conf: 0.95 },
    { p: 'HK$', code: 'HKD', conf: 0.98 },
    { p: 'NT$', code: 'TWD', conf: 0.98 },
    { p: 'A$', code: 'AUD', conf: 0.9 },
    { p: 'C$', code: 'CAD', conf: 0.9 },
    { p: 'S$', code: 'SGD', conf: 0.9 },
    { p: 'NZ$', code: 'NZD', conf: 0.9 },
    { p: 'R$', code: 'BRL', conf: 0.9 },
    { p: 'RM', code: 'MYR', conf: 0.85 },
    { p: 'CN¥', code: 'CNY', conf: 0.95 },
    { p: 'JP¥', code: 'JPY', conf: 0.95 },
    { p: '美元', code: 'USD', conf: 1 },
    { p: '美金', code: 'USD', conf: 1 },
    { p: '人民币', code: 'CNY', conf: 1 },
    { p: '离岸人民币', code: 'CNY', conf: 1 },
    { p: 'RMB', code: 'CNY', conf: 1 },
    { p: 'CNY', code: 'CNY', conf: 1 },
    { p: '日元', code: 'JPY', conf: 1 },
    { p: '日圆', code: 'JPY', conf: 1 },
    { p: '日本円', code: 'JPY', conf: 1 },
    { p: 'JPY', code: 'JPY', conf: 1 },
    { p: 'USD', code: 'USD', conf: 1 },
    { p: 'EUR', code: 'EUR', conf: 1 },
    { p: 'GBP', code: 'GBP', conf: 1 },
    { p: 'HKD', code: 'HKD', conf: 1 },
    { p: 'TWD', code: 'TWD', conf: 1 },
    { p: 'KRW', code: 'KRW', conf: 1 },
    { p: 'SGD', code: 'SGD', conf: 1 },
    { p: 'AUD', code: 'AUD', conf: 1 },
    { p: 'CAD', code: 'CAD', conf: 1 },
    { p: 'THB', code: 'THB', conf: 1 },
    { p: 'MYR', code: 'MYR', conf: 1 },
    // 注意：PHP / INR / VND / BRL 故意不做裸代码识别 ——
    // "PHP 8.2" 在开发者页面上是编程语言，不是菲律宾比索；这些币种只认符号（₱ ₹ ₫ R$）
    { p: '欧元', code: 'EUR', conf: 1 },
    { p: '英镑', code: 'GBP', conf: 1 },
    { p: '港元', code: 'HKD', conf: 1 },
    { p: '港币', code: 'HKD', conf: 1 },
    { p: '新台币', code: 'TWD', conf: 1 },
    { p: '台币', code: 'TWD', conf: 1 },
    { p: '韩元', code: 'KRW', conf: 1 },
    { p: '新加坡元', code: 'SGD', conf: 1 },
    { p: '澳元', code: 'AUD', conf: 1 },
    { p: '加元', code: 'CAD', conf: 1 },
    { p: '泰铢', code: 'THB', conf: 1 },
    { p: '越南盾', code: 'VND', conf: 1 },
    { p: '₫', code: 'VND', conf: 1 },
    { p: '₱', code: 'PHP', conf: 1 },
    { p: '₹', code: 'INR', conf: 1 },
    { p: '₩', code: 'KRW', conf: 1 },
    { p: '฿', code: 'THB', conf: 1 },
    { p: '€', code: 'EUR', conf: 1 },
    { p: '£', code: 'GBP', conf: 1 },
    { p: '円', code: 'JPY', conf: 0.95 },
    { p: '원', code: 'KRW', conf: 0.9 },
    // 歧义标记：靠证据链决定
    { p: '元', code: 'CNY', conf: 0.9, amb: ['CNY', 'TWD'] },
    { p: 'kr', code: null, conf: 0.5, amb: ['SEK', 'NOK', 'DKK'] },
    { p: '¥', code: null, conf: 0.5, amb: ['CNY', 'JPY'] },
    { p: '￥', code: null, conf: 0.5, amb: ['CNY', 'JPY'] },
    { p: '$', code: 'USD', conf: 0.7, amb: ['USD', 'CAD', 'AUD', 'HKD', 'SGD', 'NZD', 'TWD'] },
  ];

  const TLD_CURRENCY = {
    jp: 'JPY', cn: 'CNY', tw: 'TWD', hk: 'HKD', kr: 'KRW', sg: 'SGD', th: 'THB', my: 'MYR',
    vn: 'VND', ph: 'PHP', in: 'INR', br: 'BRL', se: 'SEK', no: 'NOK', dk: 'DKK',
    au: 'AUD', ca: 'CAD', nz: 'NZD', uk: 'GBP',
  };

  const MAGNITUDE = { 万: 1e4, 萬: 1e4, 亿: 1e8, 億: 1e8, 千: 1e3, 百: 1e2, k: 1e3, K: 1e3, M: 1e6 };
  const SP = '[ \\u00A0\\u2009\\u202F]?';                 // 只允许同行空格
  const NUM_SRC = '\\d{1,3}(?:[,\\u00A0\\u2009\\u202F ]\\d{3})+(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)*';
  const MAG_SRC = '(?:[万千百萬億亿kKM](?![A-Za-z]))?';    // 量级后面不能紧跟字母（100 km / 100 MB）
  const YUAN_PREFIX_DENY = new Set('美日欧港台韩新澳加比泰马越英法德俄瑞丹挪');

  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  let _reSrc = null;
  /**
   * 每次返回一个**全新的** RegExp。
   * 教训：全局正则的 lastIndex 是共享可变状态。markerCensus() 会在 parseAll() 的循环中间
   * 用同一个正则去扫另一段文本，把 lastIndex 复位，于是 parseAll 从头再来 → 死循环。
   * 所以这里只缓存正则源码，绝不缓存正则对象本身。
   */
  function amountRe() {
    if (!_reSrc) {
      const alt = MARKERS.map(function (m) { return escRe(m.p); }).sort(function (a, b) { return b.length - a.length; }).join('|');
      // 组：1=前缀标记 2=数字 3=量级 4=后缀标记
      _reSrc = '(?:(' + alt + ')' + SP + ')?(' + NUM_SRC + ')' + SP + '(' + MAG_SRC + ')(?:' + SP + '(' + alt + '))?';
    }
    return new RegExp(_reSrc, 'g');
  }

  const markerByText = new Map(MARKERS.map(function (m) { return [m.p, m]; }));

  /** "1,299.50" / "1.299,50" / "1 234" / "1.5M" → number（不含量级） */
  function parseNumber(raw) {
    let s = String(raw).replace(/[\s\u00A0\u2009\u202F]/g, '');
    if (!s) return null;
    const dot = s.lastIndexOf('.');
    const com = s.lastIndexOf(',');
    if (dot >= 0 && com >= 0) {
      s = com > dot ? s.replace(/\./g, '').replace(/,/g, '.') : s.replace(/,/g, '');
    } else if (com >= 0) {
      if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
      else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (dot >= 0) {
      if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    }
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
  }

  function hits(text, re) { const m = String(text).match(re); return m ? m.length : 0; }

  function tldOf(host) {
    const m = String(host || '').toLowerCase().match(/\.([a-z]{2,})$/);
    return m ? m[1] : '';
  }

  function keywordCounts(text) {
    const t = String(text || '');
    return {
      jp: hits(t, /税込|税抜|送料無料|ポイント|決済|日本円|為替|お届け|在庫あり|カート/g),
      cn: hits(t, /含税|包邮|免运费|人民币|元起|优惠券|国内|发货|清仓|折后/g),
      ko: hits(t, /배송|무료|결제|할인|원/g),
    };
  }

  /** 全文货币标记普查：数字相邻的算强证据（census['¥']），裸标记算弱证据（census['~¥']） */
  function markerCensus(text) {
    const src = String(text || '');
    const out = {};
    const counts = {};
    const re = amountRe();
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (m[0] === '') { re.lastIndex++; continue; }
      const mk = m[1] || m[4];
      if (mk) out[mk] = (out[mk] || 0) + 1;
    }
    for (const marker of MARKERS) {
      const n = hits(src, new RegExp(escRe(marker.p), 'g'));
      if (n > 0) {
        const adjacent = out[marker.p] || 0;
        const bare = Math.max(0, n - adjacent);
        if (bare > 0) out['~' + marker.p] = (out['~' + marker.p] || 0) + bare;
        counts[marker.p] = n;
      }
    }
    return out;
  }

  const EMPTY_PROFILE = {
    lang: '', host: '', tld: '',
    ratios: { kana: 0, hangul: 0, han: 0, latin: 0 },
    counts: { kana: 0, hangul: 0, han: 0, latin: 0 },
    census: {}, keywords: {}, textLen: 0,
  };

  /** 把旧的 / 简化的 ctx 补全成 profile；ctx.profile 优先 */
  function profileOf(ctx) {
    const c = ctx || {};
    if (c.profile) return c.profile;
    const host = String(c.host || '');
    const sig = String(c.signals || '');
    return {
      lang: c.lang || '',
      host: host,
      tld: c.tld || tldOf(host),
      ratios: c.ratios || EMPTY_PROFILE.ratios,
      counts: c.counts || EMPTY_PROFILE.counts,
      census: sig ? markerCensus(sig) : {},
      keywords: sig ? keywordCounts(sig) : {},
      textLen: sig.length,
    };
  }

  /** 从 DOM 采样生成页面画像（只读，不修改页面） */
  function buildProfile(doc, win, sample) {
    const text = sample == null ? '' : String(sample);
    const count = function (re) { return hits(text, re); };
    const kana = count(/[\u3040-\u309F\u30A0-\u30FF]/g);
    const hangul = count(/[\uAC00-\uD7AF\u1100-\u11FF]/g);
    const han = count(/[\u4E00-\u9FFF\u3400-\u4DBF]/g);
    const latin = count(/[A-Za-z]/g);
    const total = Math.max(1, kana + hangul + han + latin);
    let lang = '';
    try {
      lang = doc.documentElement.getAttribute('lang') || '';
      if (!lang) {
        const meta = doc.querySelector('meta[http-equiv="content-language" i], meta[name="content-language" i], meta[property="og:locale"]');
        if (meta) lang = (meta.content || '').replace('_', '-');
      }
      if (!lang && win && win.navigator) lang = win.navigator.language || '';
    } catch (e) { /* 忽略 */ }
    let host = '';
    try { host = (win && win.location && win.location.hostname) || ''; } catch (e) { /* 忽略 */ }
    return {
      lang: lang,
      host: host,
      tld: tldOf(host),
      ratios: { kana: kana / total, hangul: hangul / total, han: han / total, latin: latin / total },
      counts: { kana: kana, hangul: hangul, han: han, latin: latin },
      census: markerCensus(text),
      keywords: keywordCounts(text),
      textLen: text.length,
    };
  }

  function candidatesOf(marker) {
    if (marker.amb && marker.amb.length > 1) return marker.amb.slice();
    if (marker.code) return [marker.code];
    return marker.amb ? marker.amb.slice() : [];
  }

  /**
   * 证据式币种识别。返回 { code, conf, alts, why, evidence, totals }
   * 每一项证据是一个独立信号，详细模式会把它们显示出来，方便你判断"为什么它认为是 JPY"。
   */
  function resolveCurrency(marker, ctx) {
    const p = profileOf(ctx);
    const cands = candidatesOf(marker);
    const ev = {};
    const add = function (code, w, why) {
      if (!w || cands.indexOf(code) < 0) return;   // 只累积候选币种的证据
      (ev[code] = ev[code] || []).push({ w: w, why: why });
    };

    const lang = String(p.lang || '').toLowerCase();
    const tld = String(p.tld || tldOf(p.host));
    const r = p.ratios || EMPTY_PROFILE.ratios;
    const counts = p.counts || EMPTY_PROFILE.counts;
    const census = p.census || {};
    const kw = p.keywords || {};
    const num = function (k) { return census[k] || 0; };
    const bare = function (k) { return census['~' + k] || 0; };
    const pct = function (x) { return (x * 100).toFixed(2) + '%'; };

    /* ① 文字体系比重：假名/谚文出现几乎只有一种解释，这是最强的一类证据 */
    if (r.kana >= 0.01) add('JPY', 6, '假名占比 ' + pct(r.kana));
    else if (r.kana >= 0.003) add('JPY', 4, '假名占比 ' + pct(r.kana));
    else if (counts.kana > 0) add('JPY', 2, '出现假名 ' + counts.kana + ' 个');
    if (r.hangul >= 0.005) add('KRW', 6, '谚文占比 ' + pct(r.hangul));
    if (r.han >= 0.05 && counts.kana === 0 && counts.hangul === 0) add('CNY', 1, '汉字页面且无假名/谚文');

    /* ② 语言标注 */
    if (/^ja/.test(lang)) add('JPY', 4, 'lang=' + lang);
    if (/^zh-(tw|hk|mo|hant)/.test(lang)) { add('TWD', 4, 'lang=' + lang); add('CNY', 1, 'lang=' + lang); }
    else if (/^zh/.test(lang)) add('CNY', 4, 'lang=' + lang);
    if (/^ko/.test(lang)) add('KRW', 4, 'lang=' + lang);
    if (/^th/.test(lang)) add('THB', 4, 'lang=' + lang);
    if (/^vi/.test(lang)) add('VND', 4, 'lang=' + lang);

    /* ③ 域名 */
    if (TLD_CURRENCY[tld]) add(TLD_CURRENCY[tld], 5, '域名 .' + tld);

    /* ④ 全文货币标记普查（"实际文本比重"） */
    const jpC = num('円') + bare('円') * 0.4 + num('JPY') + num('JP¥') + num('日元') + num('日圆') + num('日本円');
    const cnC = num('元') + bare('元') * 0.4 + num('CNY') + num('CN¥') + num('人民币') + num('RMB');
    const twC = num('NT$') + num('TWD') + num('台币') + num('新台币');
    const usC = num('$') + bare('$') * 0.5 + num('USD') + num('US$') + num('美元') + num('美金');
    if (jpC) add('JPY', Math.min(6, 1.5 * Math.min(jpC, 4)), '全文 円/JPY 系 ' + jpC.toFixed(1) + ' 次');
    if (cnC) add('CNY', Math.min(6, 1.5 * Math.min(cnC, 4)), '全文 元/CNY 系 ' + cnC.toFixed(1) + ' 次');
    if (twC) add('TWD', Math.min(6, 1.5 * Math.min(twC, 4)), '全文 NT$/TWD 系 ' + twC.toFixed(1) + ' 次');
    if (usC) add('USD', Math.min(3, 0.8 * Math.min(usC, 4)), '全文 $/USD 系 ' + usC.toFixed(1) + ' 次');

    /* ⑤ 邻近上下文（前后 60 字） */
    const local = String((ctx && ctx.local) || '');
    if (local) {
      const jpL = hits(local, /税込|税抜|送料無料|ポイント|決済|日本円|お届け/g);
      const cnL = hits(local, /含税|包邮|免运费|人民币|元起|优惠券|发货/g);
      const koL = hits(local, /배송|무료|결제|원/g);
      if (jpL) add('JPY', Math.min(5, 2 * jpL), '邻近日文词 ' + jpL + ' 个');
      if (cnL) add('CNY', Math.min(5, 2 * cnL), '邻近中文词 ' + cnL + ' 个');
      if (koL) add('KRW', Math.min(5, 2 * koL), '邻近韩文词 ' + koL + ' 个');
    }

    /* ⑥ 页面关键词 */
    if (kw.jp) add('JPY', Math.min(4, 1.2 * kw.jp), '页面日文词 ' + kw.jp + ' 处');
    if (kw.cn) add('CNY', Math.min(4, 1.2 * kw.cn), '页面中文词 ' + kw.cn + ' 处');
    if (kw.ko) add('KRW', Math.min(4, 1.2 * kw.ko), '页面韩文词 ' + kw.ko + ' 处');

    /* ⑦ 站点记忆：用户手动校准过 → 决定性，直接短路 */
    const key = String(p.host || '') + '|' + marker.p;
    const mem = (ctx && ctx.memory && ctx.memory[key]) || null;
    if (mem && CURRENCIES[mem]) {
      const forced = mem;
      return {
        code: forced, conf: 1, alts: cands, why: '站点记忆（你校准过）',
        evidence: [{ code: forced, w: 99, why: '站点记忆' }], totals: {},
      };
    }

    /* 计分：证据 + 先验（标记自身倾向） */
    const totals = {};
    cands.forEach(function (c) {
      let s = (ev[c] || []).reduce(function (a, e) { return a + e.w; }, 0);
      if (marker.code === c) s += 2;                                  // 标记本身的倾向
      if (!marker.code && cands[0] === c) s += 0.6;                    // 无倾向时给默认候选一点先手
      totals[c] = s;
    });
    const ranked = cands.slice().sort(function (a, b) { return totals[b] - totals[a]; });
    const best = ranked[0];
    const second = ranked[1];
    const margin = totals[best] - (second ? totals[second] : 0);
    let conf;
    if (totals[best] <= 0) conf = marker.code ? marker.conf * 0.7 : 0.4;
    else conf = Math.max(0.4, Math.min(0.98, 0.45 + margin / 12));
    if (marker.code === best && (ev[best] || []).length === 0) conf = Math.min(conf, marker.conf);

    const topEv = (ev[best] || []).slice().sort(function (a, b) { return b.w - a.w; });
    const why = topEv.length
      ? topEv.slice(0, 2).map(function (e) { return e.why; }).join(' + ')
      : (marker.code ? '仅凭标记 ' + marker.p : '无证据，默认 ' + best);

    return {
      code: best,
      conf: Math.round(conf * 100) / 100,
      alts: cands,
      why: why,
      evidence: (ev[best] || []).concat(ev[second] || []).sort(function (a, b) { return b.w - a.w; }),
      totals: totals,
      runnerUp: second || null,
    };
  }

  /**
   * 解析一段文本里的所有金额。
   * @param {string} text
   * @param {object} ctx  {lang, host, memory, signals?, profile?, local?}
   * @returns {{accepted: Array, rejected: Array}}
   */
  function parseAll(text, ctx, opts) {
    const includeRejected = !!(opts && opts.includeRejected);
    const accepted = [];
    const rejected = [];
    const src = String(text == null ? '' : text);
    if (!src || !/\d/.test(src)) return { accepted: accepted, rejected: rejected };
    const re = amountRe();
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (m[0] === '') { re.lastIndex++; continue; }
      const push = function (reason) { if (includeRejected) rejected.push({ raw: m[0], reason: reason, at: m.index }); };

      const prefixMarker = m[1];
      const suffixMarker = m[4];
      const markerText = prefixMarker || suffixMarker;
      if (!markerText) { push('无货币标记'); continue; }
      const marker = markerByText.get(markerText);
      if (!marker) { push('未知标记'); continue; }

      const magnitude = m[3] || '';
      const rawNum = parseNumber(m[2]);
      if (rawNum == null) { push('数字无法解析'); continue; }
      const amount = rawNum * (magnitude ? (MAGNITUDE[magnitude] || 1) : 1);
      if (!(amount > 0) || amount > 1e12) { push('数值超出合理区间'); continue; }

      const start = m.index;
      const end = m.index + m[0].length;
      const before = src[start - 1] || '';
      const after = src[end] || '';

      if (markerText === '元' && YUAN_PREFIX_DENY.has(before)) { push('「' + before + '元」不是人民币'); continue; }
      if (markerText === 'kr' && /[A-Za-z]/.test(before)) { push('kr 前面是字母'); continue; }
      if (markerText === 'RM' && /[A-Za-z]/.test(before)) { push('RM 前面是字母'); continue; }
      if (markerText === '$' && (before === '$' || after === '{' || /[A-Za-z]/.test(before))) { push('$ 上下文可疑'); continue; }
      if ((markerText === '¥' || markerText === '￥') && /[A-Za-z]/.test(before)) { push('¥ 紧跟在字母后'); continue; }
      if (after === '%' || after === '％') { push('后面是百分号'); continue; }
      if (/^[x×*]\d/.test(src.slice(end).replace(/^[ \u00A0]/, ''))) { push('看起来是尺寸 NxN'); continue; }
      // 空格千分位后面紧跟字母 → 更可能是 "$100 500MB" 这类，整条放弃（宁可不显示，也不能显示 100500）
      if (/[ \u00A0\u2009\u202F]/.test(m[2]) && /^[A-Za-z]/.test(src.slice(end))) {
        push('空格千分位后紧跟字母（疑似单位）');
        continue;
      }

      const localCtx = Object.assign({}, ctx || {}, {
        local: src.slice(Math.max(0, start - 60), Math.min(src.length, end + 60)),
      });
      const resolved = resolveCurrency(marker, localCtx);
      accepted.push({
        raw: src.slice(start, end),
        start: start,
        end: end,
        amount: amount,
        number: rawNum,
        marker: markerText,
        prefix: !!prefixMarker,
        magnitude: magnitude,
        code: resolved.code,
        conf: resolved.conf,
        alts: resolved.alts || [],
        why: resolved.why,
        evidence: resolved.evidence || [],
        totals: resolved.totals || {},
      });
      // 兜底：保证 lastIndex 单调前进，任何被复位的正则都不会造成死循环
      if (re.lastIndex <= m.index) re.lastIndex = m.index + Math.max(1, m[0].length);
    }
    return { accepted: accepted, rejected: rejected };
  }

  function parseText(text, ctx) {
    const r = parseAll(text, ctx);
    return r.accepted.length ? r.accepted[0] : null;
  }

  function convertAmount(table, amount, from, to) {
    if (!table || !table[from] || !table[to]) return null;
    const v = (amount / table[from]) * table[to];
    return Number.isFinite(v) ? v : null;
  }

  function formatMoney(value, code) {
    const dec = CURRENCIES[code] ? CURRENCIES[code].dec : 2;
    const a = Math.abs(value);
    let digits = dec;
    if (a > 0 && a < 1) digits = Math.min(dec + 2, 6);
    else if (a >= 1e6) digits = 0;
    return value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  // 离线兜底（open.er-api.com，2026-09-20 抓取），仅在联网失败且无缓存时使用，UI 会明确标注
  const FALLBACK_TABLE = {
    USD: 1, CNY: 6.718405, JPY: 157.140885, EUR: 0.871291, GBP: 0.747943, HKD: 7.845294,
    TWD: 31.836666, KRW: 1386.744186, SGD: 1.276628, AUD: 1.404923, CAD: 1.399127,
    NZD: 1.665, SEK: 9.31, NOK: 9.95, DKK: 6.5, THB: 33.356156, MYR: 4.0815,
    PHP: 62.839511, VND: 26127.618517,
  };
  const FALLBACK_UPDATED = '2026-09-20（内置示例）';

  /* ==========================================================================
   * B. 环境层：配置 + 汇率
   * ========================================================================== */

  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined' && !!document.documentElement;
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : (isBrowser ? window : {});

  const DEFAULTS = {
    enabled: true,
    mode: 'simple',            // simple | detail
    size: 'm',                 // s | m | l
    dwellMs: 180,
    target: 'CNY',
    detailTargets: ['CNY', 'JPY', 'USD', 'EUR'],
    ttlMinutes: 30,
    rightClickCopy: true,
    showEvidence: false,
    debug: false,
    themeCss: '',
    disabledHosts: [],
    siteTarget: {},            // "example.com" -> "JPY"   目标币种按域名记忆
    memory: {},                // "example.com|¥" -> "JPY" 原始币种按域名记忆
  };

  const store = {
    get: function (key, dflt) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue('fxph:' + key, undefined);
          return v === undefined ? dflt : v;
        }
        const raw = localStorage.getItem('fxph:' + key);
        return raw == null ? dflt : JSON.parse(raw);
      } catch (e) { return dflt; }
    },
    set: function (key, value) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue('fxph:' + key, value);
        else localStorage.setItem('fxph:' + key, JSON.stringify(value));
      } catch (e) { /* 忽略 */ }
    },
  };

  const cfg = Object.assign({}, DEFAULTS, store.get('config', {}) || {});
  // 老版本配置迁移
  if (!Array.isArray(cfg.detailTargets) || !cfg.detailTargets.length) cfg.detailTargets = DEFAULTS.detailTargets.slice();
  if (!cfg.siteTarget) cfg.siteTarget = {};
  if (!cfg.memory) cfg.memory = {};
  if (!cfg.disabledHosts) cfg.disabledHosts = [];

  function saveCfg() { store.set('config', cfg); }

  function xhrText(url) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET', url: url, timeout: 12000,
          onload: function (r) { (r.status >= 200 && r.status < 300) ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status)); },
          onerror: function () { reject(new Error('network')); },
          ontimeout: function () { reject(new Error('timeout')); },
        });
      } else if (typeof fetch === 'function') {
        fetch(url).then(function (r) { return r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)); }).then(resolve, reject);
      } else { reject(new Error('no transport')); }
    });
  }

  const SOURCES = [
    { name: 'ER-API', url: 'https://open.er-api.com/v6/latest/USD',
      pick: function (j) { return { table: j.rates, updated: j.time_last_update_utc, note: '日更' }; } },
    { name: 'ECB/Frankfurter', url: 'https://api.frankfurter.app/latest?from=USD',
      pick: function (j) { return { table: Object.assign({ USD: 1 }, j.rates), updated: j.date, note: 'ECB 参考汇率' }; } },
  ];

  const RATES = { table: null, source: '', updated: '', fetchedAt: 0, stale: false, offline: false, error: '' };
  let ratesRequest = null;

  function hydrateRates(c) {
    RATES.table = c.table; RATES.source = c.source || ''; RATES.updated = c.updated || '';
    RATES.fetchedAt = c.fetchedAt || 0; RATES.offline = !!c.offline;
  }

  function ensureRates(force) {
    if (ratesRequest) return ratesRequest;
    const cached = store.get('rates', null);
    if (cached && cached.table) hydrateRates(cached);
    const fresh = cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < cfg.ttlMinutes * 60000;
    if (RATES.table && fresh && !force) return Promise.resolve(RATES);
    const errors = [];
    const tryNext = function (i) {
      if (i >= SOURCES.length) {
        RATES.error = errors.join(' | ');
        if (RATES.table) { RATES.stale = true; return RATES; }
        hydrateRates({ table: FALLBACK_TABLE, source: '内置离线示例表', updated: FALLBACK_UPDATED, fetchedAt: Date.now(), offline: true });
        RATES.stale = true;
        return RATES;
      }
      const s = SOURCES[i];
      return xhrText(s.url).then(function (t) {
        const picked = s.pick(JSON.parse(t));
        if (!picked || !picked.table) throw new Error('bad payload');
        hydrateRates({ table: picked.table, source: s.name + ' · ' + picked.note, updated: picked.updated, fetchedAt: Date.now() });
        RATES.stale = false; RATES.error = '';
        store.set('rates', { table: RATES.table, source: RATES.source, updated: RATES.updated, fetchedAt: RATES.fetchedAt });
        return RATES;
      }).catch(function (e) {
        errors.push(s.name + ': ' + e.message);
        return tryNext(i + 1);
      });
    };
    ratesRequest = Promise.resolve(tryNext(0)).then(function (result) {
      ratesRequest = null;
      if (current && card && card.style.display !== 'none') {
        renderCard(current);
        place(currentRect, lastPoint);
      }
      return result;
    }, function (err) {
      ratesRequest = null;
      throw err;
    });
    return ratesRequest;
  }

  /* ==========================================================================
   * C. 呈现层
   * ========================================================================== */

  const SKIP_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SCRIPT', 'STYLE', 'NOSCRIPT',
    'CODE', 'PRE', 'KBD', 'SAMP', 'SVG', 'CANVAS', 'MATH', 'IFRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'MAP']);

  function isSkippedElement(el) {
    let n = el; let depth = 0;
    while (n && n.nodeType === 1 && depth++ < 8) {
      if (SKIP_TAGS.has(n.tagName)) return true;
      if (n.isContentEditable) return true;
      if (n === document.body || n === document.documentElement) break;
      n = n.parentElement;
    }
    return false;
  }

  function isHost(el) { return !!host && (el === host || host.contains(el)); }

  function caretTextAt(x, y) {
    let node = null; let offset = 0;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { node = p.offsetNode; offset = p.offset; }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    }
    if (!node || node.nodeType !== 3) return null;
    const len = node.data.length;
    if (offset > len) offset = len;
    return { node: node, offset: offset };
  }

  function rangeRect(node, start, end) {
    try {
      const r = document.createRange();
      r.setStart(node, Math.max(0, start));
      r.setEnd(node, Math.min(node.data.length, end));
      const b = r.getBoundingClientRect();
      return (b && (b.width || b.height)) ? b : null;
    } catch (e) { return null; }
  }

  let _profile = { at: 0, len: -1, value: null };
  function pageProfile() {
    let text = '';
    try { text = (document.body && document.body.innerText) || ''; } catch (e) { text = ''; }
    const now = Date.now();
    if (_profile.value && now - _profile.at < 5000 && Math.abs(text.length - _profile.len) < 200) return _profile.value;
    _profile = { at: now, len: text.length, value: buildProfile(document, window, text.slice(0, 60000)) };
    return _profile.value;
  }

  /** deep=false 时只带语言/域名，不扫正文（悬停的常见路径要便宜） */
  function ctx(deep) {
    const base = { host: location.hostname, lang: '', memory: cfg.memory };
    try {
      base.lang = document.documentElement.getAttribute('lang') || (navigator.language || '');
    } catch (e) { /* 忽略 */ }
    if (deep) base.profile = pageProfile();
    return base;
  }

  const stats = {
    scans: 0, hits: 0, deepScans: 0, startedAt: Date.now(), byCode: {}, rejects: {},
    reject: function (r) { this.rejects[r] = (this.rejects[r] || 0) + 1; },
    hit: function (c) { this.hits++; this.byCode[c] = (this.byCode[c] || 0) + 1; },
    dump: function () {
      return {
        version: VERSION, host: (typeof location !== 'undefined' ? location.hostname : ''),
        uptimeMin: Math.round((Date.now() - this.startedAt) / 60000),
        scans: this.scans, hits: this.hits, deepScans: this.deepScans,
        hitRate: this.scans ? +(this.hits / this.scans).toFixed(3) : 0,
        byCode: this.byCode, rejects: this.rejects,
        cfg: { mode: cfg.mode, size: cfg.size, dwellMs: cfg.dwellMs, target: cfg.target },
        rates: { source: RATES.source, updated: RATES.updated, stale: RATES.stale, offline: RATES.offline,
          ageMin: RATES.fetchedAt ? Math.round((Date.now() - RATES.fetchedAt) / 60000) : null },
      };
    },
  };

  /* ---- 主题：所有视觉取值都是 CSS 变量，外加一份可替换的 CSS ---- */
  const BASE_CSS = [
    ':host{',
    '--fxph-scale:1;',
    '--fxph-bg:rgba(9,22,16,.97);',
    '--fxph-fg:#edf8f2;',
    '--fxph-accent:#56e39f;',
    '--fxph-accent-weak:#8fb3a2;',
    '--fxph-muted:#7f9c8d;',
    '--fxph-border:#2f5c47;',
    '--fxph-warn:#ffbf6b;',
    '--fxph-danger:#ff8d8d;',
    '--fxph-radius:10px;',
    '--fxph-pad:10px;',
    '--fxph-gap:6px;',
    '--fxph-font:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;',
    '--fxph-font-mono:ui-monospace,SFMono-Regular,Menlo,monospace;',
    '--fxph-shadow:0 10px 30px rgba(0,0,0,.45);',
    '--fxph-max-width:340px;',
    'all:initial}',
    '*{box-sizing:border-box}',
    '.card{position:fixed;z-index:2147483647;max-width:min(var(--fxph-max-width),calc(100vw - 16px));background:var(--fxph-bg);color:var(--fxph-fg);',
    'border:1px solid var(--fxph-border);border-radius:var(--fxph-radius);box-shadow:var(--fxph-shadow);',
    'padding:var(--fxph-pad);font:calc(12px * var(--fxph-scale))/1.5 var(--fxph-font);pointer-events:auto;user-select:none}',
    '.amount-main{font:600 calc(20px * var(--fxph-scale))/1.3 var(--fxph-font-mono);color:var(--fxph-accent);white-space:nowrap}',
    '.amount-main-code{font-size:calc(12px * var(--fxph-scale));color:var(--fxph-accent-weak);margin-left:4px}',
    '.amount-origin{color:var(--fxph-fg);font:calc(12px * var(--fxph-scale))/1.5 var(--fxph-font-mono);margin-top:2px}',
    '.amount-origin-code{color:var(--fxph-accent-weak);margin-left:4px}',
    '.row-main{display:flex;align-items:baseline;justify-content:space-between;gap:var(--fxph-gap)}',
    '.row-origin{display:flex;align-items:center;justify-content:space-between;gap:var(--fxph-gap);margin-top:2px}',
    '.multi-row{display:flex;align-items:baseline;justify-content:space-between;gap:var(--fxph-gap);margin-top:2px}',
    '.multi-value{font:600 calc(13px * var(--fxph-scale))/1.4 var(--fxph-font-mono);color:var(--fxph-accent)}',
    '.multi-code{color:var(--fxph-muted);font-size:calc(10px * var(--fxph-scale))}',
    '.rate-line{color:var(--fxph-fg);font:calc(11px * var(--fxph-scale))/1.5 var(--fxph-font-mono);margin-top:5px}',
    '.timestamp{color:var(--fxph-muted);font-size:calc(10px * var(--fxph-scale));margin-top:3px}',
    '.evidence,.parse-detail{color:var(--fxph-accent-weak);font-size:calc(10px * var(--fxph-scale));margin-top:3px;word-break:break-word}',
    '.parse-detail{color:var(--fxph-muted)}',
    '.badge-guess,.badge-adjust{display:inline-block;font-size:calc(9px * var(--fxph-scale));color:var(--fxph-muted);',
    'border:1px solid var(--fxph-border);border-radius:99px;padding:1px 6px;margin-left:6px;vertical-align:2px}',
    '.badge-adjust{color:var(--fxph-accent)}',
    '.warn-stale,.warn-offline,.warn-error{font-size:calc(10px * var(--fxph-scale));color:var(--fxph-warn);margin-top:3px}',
    '.warn-error{color:var(--fxph-danger)}',
    '.actions{display:flex;gap:var(--fxph-gap);margin-top:8px;flex-wrap:wrap}',
    'button{font:calc(11px * var(--fxph-scale))/1 var(--fxph-font);color:var(--fxph-fg);background:transparent;',
    'border:1px solid var(--fxph-border);border-radius:calc(var(--fxph-radius) * .6);padding:5px 7px;cursor:pointer}',
    'button:hover{border-color:var(--fxph-accent);color:#fff}',
    'select{font:calc(11px * var(--fxph-scale))/1 var(--fxph-font-mono);color:var(--fxph-fg);background:var(--fxph-bg);',
    'border:1px solid var(--fxph-border);border-radius:calc(var(--fxph-radius) * .6);padding:3px 4px;max-width:110px}',
    '.toast{position:fixed;margin-top:6px;color:var(--fxph-accent);font-size:calc(10px * var(--fxph-scale))}',
    '.settings{position:fixed;z-index:2147483647;width:min(420px,92vw);max-height:80vh;overflow:auto;padding:14px;',
    'background:var(--fxph-bg);color:var(--fxph-fg);border:1px solid var(--fxph-border);border-radius:var(--fxph-radius);',
    'box-shadow:var(--fxph-shadow);font:calc(12px * var(--fxph-scale))/1.6 var(--fxph-font)}',
    '.settings-head{display:flex;justify-content:space-between;align-items:center;font-weight:700;margin-bottom:8px}',
    '.settings-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid rgba(127,156,141,.18)}',
    '.settings-row.col{display:block}',
    '.settings-label{color:var(--fxph-accent-weak);font-size:calc(11px * var(--fxph-scale))}',
    '.settings-control{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
    '.settings-control input[type=range]{width:130px}',
    '.settings textarea{width:100%;margin-top:6px;font:calc(10px * var(--fxph-scale))/1.5 var(--fxph-font-mono);',
    'color:var(--fxph-fg);background:transparent;border:1px solid var(--fxph-border);border-radius:6px;padding:6px}',
    '.settings-actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}',
    '.settings-memory{font:calc(10px * var(--fxph-scale))/1.5 var(--fxph-font-mono);color:var(--fxph-muted);max-width:200px;text-align:right}',
    '.box{position:fixed;z-index:2147483646;border:1px solid var(--fxph-accent);background:rgba(86,227,159,.12);pointer-events:none;border-radius:3px}',
  ].join('');

  // BEGIN EMBEDDED_NEWSPAPER_THEME
  const NEWSPAPER_CSS = "/* FX Pulse Hover · 报纸风视觉层。构建脚本会把图像内嵌到独立 userscript。 */\n:host{\n  --fxph-bg:#fffaf0;--fxph-fg:#28231e;--fxph-accent:#8b341f;\n  --fxph-accent-weak:#684b3b;--fxph-muted:#63594f;--fxph-border:#a9967e;\n  --fxph-warn:#805018;--fxph-danger:#922d2d;--fxph-radius:3px;\n  --fxph-pad:14px;--fxph-gap:8px;\n  --fxph-font:Georgia,\"Songti SC\",\"Noto Serif CJK SC\",serif;\n  --fxph-font-mono:ui-monospace,SFMono-Regular,Consolas,\"Noto Sans Mono CJK SC\",monospace;\n  --fxph-shadow:0 12px 30px rgba(36,27,18,.22);\n}\n:host([data-palette=\"ink\"]){\n  --fxph-bg:#1a2022;--fxph-fg:#f2eee3;--fxph-accent:#d0e4df;\n  --fxph-accent-weak:#becfca;--fxph-muted:#b0bdb7;--fxph-border:#7b8d89;\n  --fxph-warn:#f1cb80;--fxph-danger:#ffb0a8;\n  --fxph-shadow:0 14px 32px rgba(0,0,0,.48);\n}\n:host([data-palette=\"marine\"]){\n  --fxph-bg:#f2f8f8;--fxph-fg:#1c323a;--fxph-accent:#075b70;\n  --fxph-accent-weak:#365f6a;--fxph-muted:#4e6770;--fxph-border:#86a7ad;\n  --fxph-warn:#83501a;--fxph-danger:#9b3037;\n}\n:host([data-palette=\"sage\"]){\n  --fxph-bg:#f5f7ed;--fxph-fg:#263128;--fxph-accent:#356b3d;\n  --fxph-accent-weak:#4c6851;--fxph-muted:#536459;--fxph-border:#92a392;\n  --fxph-warn:#825316;--fxph-danger:#983b33;\n}\n:host([data-palette=\"clay\"]){\n  --fxph-bg:#fff4ed;--fxph-fg:#372820;--fxph-accent:#a13c2b;\n  --fxph-accent-weak:#775243;--fxph-muted:#70584b;--fxph-border:#bb9b86;\n  --fxph-warn:#855018;--fxph-danger:#a02c34;\n}\n\n[data-part=\"card\"], [data-part=\"settings\"]{\n  border:1px solid var(--fxph-border);border-top:3px double var(--fxph-fg);\n  border-radius:var(--fxph-radius);background:var(--fxph-bg);color:var(--fxph-fg);\n  box-shadow:var(--fxph-shadow);font-family:var(--fxph-font);\n}\n[data-part=\"card\"]{\n  width:min(var(--fxph-max-width),calc(100vw - 16px));max-width:calc(100vw - 16px);\n  padding:calc(var(--fxph-pad) * var(--fxph-scale));padding-top:calc(45px * var(--fxph-scale));\n  line-height:1.45;overflow:hidden;overflow-wrap:anywhere;\n}\n[data-part=\"card\"]::before{\n  content:\"FX PULSE  /  外汇快讯\";position:absolute;left:calc(var(--fxph-pad) * var(--fxph-scale));\n  right:calc(var(--fxph-pad) * var(--fxph-scale));top:8px;height:27px;\n  border-bottom:1px solid var(--fxph-border);font:700 calc(12px * var(--fxph-scale))/25px var(--fxph-font);\n  letter-spacing:.08em;color:var(--fxph-fg);padding-right:43px;\n}\n[data-part=\"card\"]::after{\n  content:\"\";position:absolute;right:calc(var(--fxph-pad) * var(--fxph-scale));top:4px;\n  width:36px;height:33px;background:url(\"data:image/png;base64,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\") center/contain no-repeat;\n  opacity:.78;\n}\n:host([data-palette=\"ink\"]) [data-part=\"card\"]::after{filter:brightness(0) invert(1);opacity:.68}\n[data-part=\"card\"]:hover{border-color:var(--fxph-accent)}\n[data-part=\"card\"][data-state~=\"pinned\"]{border-left:4px solid var(--fxph-accent)}\n[data-part=\"card\"][data-state~=\"pinned\"]::before{content:\"FX PULSE  /  已钉住\"}\n[data-part=\"card\"][data-state~=\"offline\"]{border-style:dashed}\n[data-part=\"card\"][data-size=\"s\"]{padding-top:39px}\n[data-part=\"card\"][data-size=\"s\"] [data-part=\"target-select\"],\n[data-part=\"card\"][data-size=\"s\"] [data-part=\"origin-select\"],\n[data-part=\"card\"][data-size=\"s\"] [data-part=\"rate-line\"],\n[data-part=\"card\"][data-size=\"s\"] [data-part=\"multi-list\"],\n[data-part=\"card\"][data-size=\"s\"] [data-part=\"evidence\"],\n[data-part=\"card\"][data-size=\"s\"] [data-part=\"parse-detail\"],\n[data-part=\"card\"][data-size=\"s\"] [data-part=\"actions\"]{display:none}\n\n[data-part=\"amount-main\"]{\n  color:var(--fxph-accent);font:700 calc(21px * var(--fxph-scale))/1.2 var(--fxph-font);\n  font-variant-numeric:tabular-nums;letter-spacing:-.025em;white-space:normal;min-width:0;\n}\n[data-part=\"amount-main-code\"]{\n  display:inline-block;margin-left:5px;font:700 calc(10px * var(--fxph-scale))/1 var(--fxph-font-mono);\n  letter-spacing:.09em;color:var(--fxph-accent-weak);vertical-align:middle;\n}\n.row-main{align-items:start;flex-wrap:wrap;gap:5px 10px}\n.row-main [data-part=\"target-select\"]{margin-left:auto}\n[data-part=\"amount-origin\"]{display:inline-block;color:var(--fxph-fg);font:calc(12px * var(--fxph-scale))/1.4 var(--fxph-font-mono);margin-top:0}\n[data-part=\"amount-origin-code\"]{margin-left:7px;color:var(--fxph-accent-weak);font-size:calc(10px * var(--fxph-scale))}\n.row-origin{margin-top:calc(var(--fxph-gap) * .8);padding-top:calc(var(--fxph-gap) * .8);border-top:1px solid var(--fxph-border);align-items:center;flex-wrap:wrap}\n[data-part=\"card\"][data-mode=\"detail\"] > [data-part=\"amount-origin\"]{\n  display:block;margin-top:calc(var(--fxph-gap) * 1.25);padding-top:calc(var(--fxph-gap) * 1.1);\n  border-top:1px solid var(--fxph-border)\n}\n[data-part=\"card\"][data-mode=\"detail\"] > [data-part=\"amount-origin\"]::before{\n  content:\"原价  /  \";font:700 calc(10px * var(--fxph-scale))/1.4 var(--fxph-font);\n  letter-spacing:.05em;color:var(--fxph-muted)\n}\n[data-part=\"multi-list\"]{margin-top:calc(var(--fxph-gap) * 1.5);border-top:3px double var(--fxph-border);padding-top:3px}\n[data-part=\"multi-row\"]{margin:0;padding:calc(var(--fxph-gap) * .65) 0;border-bottom:1px solid var(--fxph-border)}\n[data-part=\"multi-value\"]{font:700 calc(13px * var(--fxph-scale))/1.35 var(--fxph-font-mono);color:var(--fxph-fg);font-variant-numeric:tabular-nums}\n[data-part=\"multi-code\"]{font:700 calc(10px * var(--fxph-scale))/1.3 var(--fxph-font-mono);letter-spacing:.07em;color:var(--fxph-accent-weak)}\n[data-part=\"rate-line\"]{border-top:1px solid var(--fxph-border);padding-top:6px;margin-top:8px;color:var(--fxph-accent);font-weight:700;white-space:normal}\n[data-part=\"timestamp\"],[data-part=\"evidence\"],[data-part=\"parse-detail\"]{font-size:calc(10px * var(--fxph-scale));color:var(--fxph-muted);line-height:1.5;overflow-wrap:anywhere}\n[data-part=\"evidence\"]{color:var(--fxph-accent-weak)}\n[data-part=\"badge-guess\"],[data-part=\"badge-adjust\"]{\n  display:inline-block;margin:6px 5px 0 0;padding:2px 6px;border:1px solid currentColor;border-radius:2px;\n  font:700 calc(10px * var(--fxph-scale))/1.3 var(--fxph-font)\n}\n[data-part=\"badge-guess\"]{color:var(--fxph-warn)}\n[data-part=\"badge-adjust\"]{color:var(--fxph-accent)}\n[data-part^=\"warn-\"]{padding:6px 8px;margin-top:8px;border-left:3px solid currentColor;background:rgba(127,92,38,.1);font-weight:700;line-height:1.4}\n[data-part=\"warn-error\"]{background:rgba(150,35,35,.1)}\n[data-part=\"actions\"]{border-top:3px double var(--fxph-border);padding-top:9px;margin-top:12px}\n[data-part=\"card\"] select,[data-part=\"settings\"] select,[data-part=\"settings\"] input:not([type=\"checkbox\"]):not([type=\"range\"]),[data-part=\"settings\"] textarea{\n  color:var(--fxph-fg);background:var(--fxph-bg);border:1px solid var(--fxph-border);border-radius:2px;\n  font-family:var(--fxph-font-mono);padding:4px 6px;max-width:100%;min-height:27px;\n}\n[data-part=\"card\"] select:focus-visible,[data-part=\"settings\"] select:focus-visible,[data-part=\"settings\"] input:focus-visible,[data-part=\"settings\"] textarea:focus-visible,[data-part=\"card\"] button:focus-visible,[data-part=\"settings\"] button:focus-visible{outline:2px solid var(--fxph-accent);outline-offset:2px}\n[data-part=\"card\"] button,[data-part=\"settings\"] button{\n  color:var(--fxph-accent);background:transparent;border:1px solid var(--fxph-border);border-radius:2px;\n  font:700 calc(11px * var(--fxph-scale))/1.2 var(--fxph-font);padding:5px 9px;\n}\n[data-part=\"card\"] button:hover,[data-part=\"settings\"] button:hover{color:var(--fxph-bg);background:var(--fxph-accent);border-color:var(--fxph-accent)}\n[data-part=\"settings\"]{width:min(420px,calc(100vw - 16px));max-height:calc(100vh - 32px);padding:15px;overflow:auto}\n[data-part=\"settings-head\"]{font:700 18px/1.25 var(--fxph-font);border-bottom:3px double var(--fxph-border);padding-bottom:9px;margin-bottom:3px}\n[data-part=\"settings-row\"]{border-color:var(--fxph-border);gap:8px;flex-wrap:wrap}\n[data-part=\"settings-label\"]{color:var(--fxph-fg);font-size:11px;font-weight:700}\n[data-part=\"settings-control\"]{min-width:0;max-width:100%}\n[data-part=\"settings-memory\"]{color:var(--fxph-muted);max-width:100%;text-align:left;overflow-wrap:anywhere}\n[data-part=\"settings-actions\"]{position:sticky;bottom:-15px;background:var(--fxph-bg);border-top:3px double var(--fxph-border);padding:10px 0 5px}\n[data-part=\"toast\"]{padding:5px 8px;border:1px solid var(--fxph-border);background:var(--fxph-bg);box-shadow:var(--fxph-shadow);font-family:var(--fxph-font)}\n@media (max-width:360px){\n  [data-part=\"card\"]{padding:10px;padding-top:40px}\n  [data-part=\"amount-main\"]{font-size:calc(18px * var(--fxph-scale))}\n  [data-part=\"settings\"]{padding:10px}\n}\n";
    // END EMBEDDED_NEWSPAPER_THEME

  const SIZE_PRESET = {
    s: { scale: 0.9, width: 300 },
    m: { scale: 1, width: 340 },
    l: { scale: 1.15, width: 460 },
  };
  const ALL_CODES = Object.keys(CURRENCIES);

  let host = null;
  let shadow = null;
  let card = null;
  let themeStyle = null;
  let settingsEl = null;
  let toastEl = null;
  let current = null;
  let currentRect = null;
  let pinned = false;
  let panelOpen = false;
  let hideTimer = null;
  let dwellTimer = null;
  let lastPoint = null;

  function buildUi() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'fxph-host';
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647';
    shadow = host.attachShadow({ mode: 'open' });
    const base = document.createElement('style');
    base.textContent = BASE_CSS;
    shadow.appendChild(base);
    themeStyle = document.createElement('style');   // 设计师的可替换 CSS 注入点
    themeStyle.id = 'fxph-theme';
    shadow.appendChild(themeStyle);
    card = document.createElement('div');
    card.className = 'card';
    part(card, 'card');
    card.style.display = 'none';
    shadow.appendChild(card);
    (document.body || document.documentElement).appendChild(host);
    card.addEventListener('mousemove', function (e) { e.stopPropagation(); cancelHide(); });
    card.addEventListener('mouseleave', function () { if (!pinned) scheduleHide(300); });
    card.addEventListener('click', onCardClick);
    card.addEventListener('change', onCardChange);
    card.addEventListener('contextmenu', onCardContextMenu);
    card.addEventListener('focusin', function () { pinned = true; updateCardState(); cancelHide(); });
    applyTheme();
  }

  function applyTheme() {
    if (!themeStyle) return;
    themeStyle.textContent = NEWSPAPER_CSS + '\n' + String(cfg.themeCss || '');
    const preset = SIZE_PRESET[cfg.size] || SIZE_PRESET.m;
    let width = preset.width;
    if (cfg.mode === 'detail') width = Math.max(width, 420);
    if (host) {
      host.style.setProperty('--fxph-scale', String(preset.scale));
      host.style.setProperty('--fxph-max-width', width + 'px');
      if (card) {
        card.dataset.mode = cfg.mode;
        card.dataset.size = cfg.size;
      }
    }
  }

  // 只在真正命中金额时采样该位置及其祖先的背景色，不持续监听页面。
  function pagePalette(element) {
    if (typeof getComputedStyle !== 'function') return 'paper';
    let node = element;
    let color = null;
    while (node && node.nodeType === 1) {
      try {
        const raw = getComputedStyle(node).backgroundColor;
        const match = raw && raw.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
        if (match && (match[4] === undefined || Number(match[4]) >= .75)) {
          color = [Number(match[1]), Number(match[2]), Number(match[3])];
          break;
        }
      } catch (e) { /* 样式不可读时退回纸色 */ }
      node = node.parentElement;
    }
    if (!color) return 'paper';
    const linear = color.map(function (v) { const s = v / 255; return s <= .04045 ? s / 12.92 : Math.pow((s + .055) / 1.055, 2.4); });
    const luminance = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
    if (luminance < .36) return 'ink';
    const max = Math.max.apply(null, color), min = Math.min.apply(null, color);
    if (max - min < 23 || (max - min) / Math.max(max, 1) < .14) return 'paper';
    let hue = 0;
    if (max === color[0]) hue = (color[1] - color[2]) / (max - min);
    else if (max === color[1]) hue = (color[2] - color[0]) / (max - min) + 2;
    else hue = (color[0] - color[1]) / (max - min) + 4;
    hue = ((hue * 60) + 360) % 360;
    if (hue >= 165 && hue <= 265) return 'marine';
    if (hue >= 55 && hue < 165) return 'sage';
    return 'clay';
  }

  function updateCardState() {
    if (!card || !current) return;
    const states = [];
    if (pinned) states.push('pinned');
    if (panelOpen) states.push('settings-open');
    if (current.conf < .85) states.push('ambiguous');
    if (current.adjusted) states.push('adjusted');
    if (RATES.offline) states.push('offline');
    else if (RATES.stale) states.push('stale');
    if (!RATES.table) states.push('error');
    card.dataset.state = states.join(' ') || 'default';
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function part(node, name) { node.dataset.part = name; return node; }

  function effectiveTarget() {
    const site = cfg.siteTarget[location.hostname];
    return (site && CURRENCIES[site]) ? site : cfg.target;
  }

  function rateBetween(from, to) {
    const t = RATES.table;
    if (!t || !t[from] || !t[to]) return null;
    return t[to] / t[from];
  }

  function formatRate(value) {
    const digits = value < .0001 ? 10 : value < .01 ? 8 : value < 1 ? 6 : 4;
    return value.toLocaleString('zh-CN', { minimumFractionDigits: value >= 1 ? 2 : 0, maximumFractionDigits: digits });
  }

  function ageText() {
    if (!RATES.fetchedAt) return '';
    const m = Math.round((Date.now() - RATES.fetchedAt) / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    return Math.round(m / 60) + ' 小时前';
  }

  function detailTimestamp() {
    const parts = [];
    parts.push('数据 ' + (RATES.updated || '未知'));
    parts.push('抓取 ' + (ageText() || '未知'));
    parts.push(RATES.source || '无源');
    parts.push('TTL ' + cfg.ttlMinutes + ' 分钟');
    return parts.join(' · ');
  }

  function selectOf(codes, value, partName, label) {
    const s = el('select');
    if (partName) part(s, partName);
    s.title = label || '';
    codes.forEach(function (c) {
      const o = el('option', null, c);
      o.value = c;
      if (c === value) o.selected = true;
      s.appendChild(o);
    });
    return s;
  }

  function renderCard(match) {
    if (!card) return;
    card.textContent = '';
    const target = effectiveTarget();
    const detail = cfg.mode === 'detail';
    // 两个下拉永远都在：目标币种 + 原始币种（美术定稿）。
    // 识别置信度只影响「猜测」徽章与 ambiguous 状态配色，不再决定下拉出不出现。
    updateCardState();

    if (detail) {
      // 详细模式与简单模式共用主换算值，原始金额保留独立标识。
      const mainValue = convertAmount(RATES.table, match.amount, match.code, target);
      const main = el('div', 'amount-main');
      main.appendChild(document.createTextNode(mainValue == null ? '≈ ? ' : '≈ ' + formatMoney(mainValue, target) + ' '));
      main.appendChild(part(el('span', 'amount-main-code', target), 'amount-main-code'));
      part(main, 'amount-main');
      card.appendChild(main);

      const origin = el('div', 'amount-origin');
      origin.appendChild(document.createTextNode(match.raw.trim() + ' '));
      origin.appendChild(part(el('span', 'amount-origin-code', match.code), 'amount-origin-code'));
      part(origin, 'amount-origin');
      card.appendChild(origin);

      const list = el('div');
      part(list, 'multi-list');
      const codes = [target].concat(cfg.detailTargets.filter(function (c) { return c !== target; })).slice(0, 4);
      codes.forEach(function (c) {
        const row = el('div', 'multi-row');
        part(row, 'multi-row');
        const v = convertAmount(RATES.table, match.amount, match.code, c);
        const val = el('span', 'multi-value', v == null ? '≈ ?' : '≈ ' + formatMoney(v, c));
        part(val, 'multi-value');
        row.appendChild(val);
        const code = el('span', 'multi-code', c);
        part(code, 'multi-code');
        row.appendChild(code);
        list.appendChild(row);
      });
      card.appendChild(list);

      const rowO = el('div', 'row-origin');
      rowO.appendChild(el('span', 'multi-code', '原始币种'));
      rowO.appendChild(selectOf(ALL_CODES, match.code, 'origin-select', '原始币种（校准）'));
      card.appendChild(rowO);
      const rowT = el('div', 'row-origin');
      rowT.appendChild(el('span', 'multi-code', '目标币种'));
      rowT.appendChild(selectOf(ALL_CODES, target, 'target-select', '目标币种'));
      card.appendChild(rowT);

      const rate = rateBetween(match.code, target);
      const rateLine = el('div', 'rate-line', '1 ' + match.code + ' = ' + (rate == null ? '?' : formatRate(rate)) + ' ' + target);
      part(rateLine, 'rate-line');
      card.appendChild(rateLine);

      const ts = el('div', 'timestamp', detailTimestamp());
      part(ts, 'timestamp');
      card.appendChild(ts);

      if (cfg.showEvidence) {
        const ev = el('div', 'evidence', '置信度 ' + match.conf + ' · ' + (match.evidence.length
          ? match.evidence.slice(0, 4).map(function (e) { return e.why + ' (+' + e.w + ')'; }).join('；')
          : match.why));
        part(ev, 'evidence');
        card.appendChild(ev);
      }
      const pd = el('div', 'parse-detail', '原始 "' + match.raw + '" · 标记 ' + match.marker +
        ' · 量级 ' + (match.magnitude || '无') + ' · 数值 ' + match.number);
      part(pd, 'parse-detail');
      card.appendChild(pd);

      appendWarnings();
      card.appendChild(badges(match, target));

      const actions = el('div', 'actions');
      part(actions, 'actions');
      const bSet = el('button', null, '设置');
      part(bSet, 'action-settings'); bSet.dataset.act = 'settings';
      const bCopy = el('button', null, '复制');
      part(bCopy, 'action-copy'); bCopy.dataset.act = 'copy';
      const bClose = el('button', null, '关闭');
      part(bClose, 'action-close'); bClose.dataset.act = 'close';
      actions.appendChild(bSet); actions.appendChild(bCopy); actions.appendChild(bClose);
      card.appendChild(actions);
    } else {
      // 简单模式：原始金额 / 换算金额 / 两个校准下拉（目标 + 原始，常驻）/ 简单时间戳 / 右键复制
      const main = el('div', 'row-main');
      const value = convertAmount(RATES.table, match.amount, match.code, target);
      const big = el('div', 'amount-main');
      big.appendChild(document.createTextNode(value == null ? '≈ ?' : '≈ ' + formatMoney(value, target) + ' '));
      big.appendChild(part(el('span', 'amount-main-code', target), 'amount-main-code'));
      part(big, 'amount-main');
      main.appendChild(big);
      main.appendChild(selectOf(ALL_CODES, target, 'target-select', '目标币种'));
      card.appendChild(main);

      const rowO = el('div', 'row-origin');
      const origin = el('span', 'amount-origin');
      origin.appendChild(document.createTextNode(match.raw.trim()));
      origin.appendChild(part(el('span', 'amount-origin-code', match.code), 'amount-origin-code'));
      part(origin, 'amount-origin');
      rowO.appendChild(origin);
      rowO.appendChild(selectOf(ALL_CODES, match.code, 'origin-select', '原始币种（校准）'));
      card.appendChild(rowO);

      const rate = rateBetween(match.code, target);
      const rateLine = el('div', 'rate-line', '1 ' + match.code + ' = ' + (rate == null ? '?' : formatRate(rate)) + ' ' + target);
      part(rateLine, 'rate-line');
      card.appendChild(rateLine);

      const ts = el('div', 'timestamp', (ageText() || '—') + (RATES.source ? ' · ' + RATES.source.split(' ')[0] : ''));
      part(ts, 'timestamp');
      card.appendChild(ts);

      appendWarnings();
      card.appendChild(badges(match, target));
    }
  }

  function badges(match, target) {
    const wrap = el('span');
    if (match.conf < 0.85) {
      const b = el('span', 'badge-guess', '猜测 ' + match.conf);
      part(b, 'badge-guess');
      wrap.appendChild(b);
    }
    if (match.adjusted) {
      const b = el('span', 'badge-adjust', '已校准');
      part(b, 'badge-adjust');
      wrap.appendChild(b);
    }
    void target;
    return wrap;
  }

  function appendWarnings() {
    if (RATES.offline) {
      const w = el('div', 'warn-offline', '⚠ 离线示例数据，不是当前汇率');
      part(w, 'warn-offline');
      card.appendChild(w);
    } else if (RATES.stale) {
      const w = el('div', 'warn-stale', '⚠ 汇率刷新失败，使用上次缓存');
      part(w, 'warn-stale');
      card.appendChild(w);
    }
    if (RATES.error && cfg.debug) {
      const w = el('div', 'warn-error', '数据源错误：' + RATES.error);
      part(w, 'warn-error');
      card.appendChild(w);
    }
  }

  function onCardContextMenu(e) {
    if (!cfg.rightClickCopy || !current) return;
    e.preventDefault();
    e.stopPropagation();
    copyCurrent();
  }

  function onCardChange(e) {
    const t = e.target;
    if (!t || !t.dataset) return;
    if (t.dataset.part === 'origin-select' && current) {
      current.code = t.value;
      current.conf = 1;
      current.adjusted = true;
      current.why = '你手动校准';
      cfg.memory[location.hostname + '|' + current.marker] = t.value;
      saveCfg();
      renderCard(current);
      place(currentRect, lastPoint);
      return;
    }
    if (t.dataset.part === 'target-select') {
      cfg.siteTarget[location.hostname] = t.value;   // 目标币种也按域名记住
      saveCfg();
      if (current) { renderCard(current); place(currentRect, lastPoint); }
    }
  }

  function copyCurrent() {
    if (!current) return;
    const target = effectiveTarget();
    const v = convertAmount(RATES.table, current.amount, current.code, target);
    const line = current.raw.trim() + ' → ≈ ' + (v == null ? '?' : formatMoney(v, target)) + ' ' + target;
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      showToast('复制不可用');
      return;
    }
    try {
      Promise.resolve(navigator.clipboard.writeText(line)).then(function () {
        showToast('已复制：' + line);
      }, function () {
        showToast('复制失败');
      });
    } catch (e) { showToast('复制失败'); }
  }

  function showToast(text) {
    if (!shadow) return;
    if (!toastEl) {
      toastEl = el('div', 'toast');
      part(toastEl, 'toast');
      shadow.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.left = (card ? card.offsetLeft : 8) + 'px';
    toastEl.style.top = ((card ? card.offsetTop + card.offsetHeight : 8) + 4) + 'px';
    setTimeout(function () { if (toastEl) toastEl.textContent = ''; }, 1600);
  }

  function onCardClick(e) {
    const b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const act = b.dataset.act;
    if (act === 'copy') { copyCurrent(); return; }
    if (act === 'close') { pinned = false; hideCard(true); return; }
    if (act === 'settings') { openSettings(); return; }
  }

  function place(rect, point) {
    if (!card) return;
    card.style.display = 'block';
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const base = rect || { left: point.x, right: point.x, top: point.y, bottom: point.y };
    const pad = 10;
    let left = point && point.x != null ? point.x + 14 : base.left;
    let top = point && point.y != null ? point.y + 18 : base.bottom + 8;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    if (top + h > window.innerHeight - 8) top = Math.max(8, (base.top || 0) - h - 8);
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    card.style.left = Math.round(left) + 'px';
    card.style.top = Math.round(top) + 'px';
  }

  function showCard(x, y, payload) {
    buildUi();
    current = payload.match;
    currentRect = payload.rect;
    pinned = false;
    host.dataset.palette = pagePalette(payload.element);
    cancelHide();
    applyTheme();
    renderCard(current);
    place(currentRect, { x: x, y: y });
    if (cfg.debug) drawBox(payload.rect);
  }

  function drawBox(rect) {
    if (!rect || !shadow) return;
    const b = el('div', 'box');
    b.style.left = rect.left + 'px';
    b.style.top = rect.top + 'px';
    b.style.width = rect.width + 'px';
    b.style.height = rect.height + 'px';
    shadow.appendChild(b);
    setTimeout(function () { b.remove(); }, 700);
  }

  function hideCard(force) {
    if (!card || (pinned && !force)) return;
    card.style.display = 'none';
    current = null; currentRect = null; pinned = false;
    card.dataset.state = 'default';
  }
  function scheduleHide(ms) { cancelHide(); hideTimer = setTimeout(function () { hideCard(false); }, ms || 300); }
  function cancelHide() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } }

  /* ---- 设置面板 ---- */
  function openSettings() {
    buildUi();
    if (settingsEl) { settingsEl.remove(); settingsEl = null; }
    pinned = true;
    panelOpen = true;
    updateCardState();
    const box = el('div', 'settings');
    part(box, 'settings');

    const head = el('div', 'settings-head');
    part(head, 'settings-head');
    head.appendChild(el('span', null, 'FX Pulse 设置 · v' + VERSION));
    const close = el('button', null, '×');
    close.dataset.act = 'close-settings';
    head.appendChild(close);
    box.appendChild(head);

    const row = function (label, control, cls) {
      const r = el('div', 'settings-row' + (cls ? ' ' + cls : ''));
      part(r, 'settings-row');
      const l = el('span', 'settings-label', label);
      part(l, 'settings-label');
      r.appendChild(l);
      const c = el('div', 'settings-control');
      part(c, 'settings-control');
      c.appendChild(control);
      r.appendChild(c);
      box.appendChild(r);
      return r;
    };

    // 显示模式
    const modeSel = el('select');
    [['simple', '简单'], ['detail', '详细']].forEach(function (o) {
      const opt = el('option', null, o[1]); opt.value = o[0];
      if (cfg.mode === o[0]) opt.selected = true;
      modeSel.appendChild(opt);
    });
    modeSel.dataset.cfg = 'mode';
    row('显示模式', modeSel);

    // 悬停触发时间
    const dwell = el('input');
    dwell.type = 'range'; dwell.min = '80'; dwell.max = '600'; dwell.step = '20'; dwell.value = String(cfg.dwellMs);
    dwell.dataset.cfg = 'dwellMs';
    const dwellOut = el('b', null, cfg.dwellMs + ' ms');
    const dwellWrap = el('span');
    dwellWrap.appendChild(dwell); dwellWrap.appendChild(dwellOut);
    dwell.addEventListener('input', function () { dwellOut.textContent = dwell.value + ' ms'; });
    row('悬停触发时间', dwellWrap);

    // 窗口大小
    const sizeSel = el('select');
    [['s', '小'], ['m', '中'], ['l', '大']].forEach(function (o) {
      const opt = el('option', null, o[1]); opt.value = o[0];
      if (cfg.size === o[0]) opt.selected = true;
      sizeSel.appendChild(opt);
    });
    sizeSel.dataset.cfg = 'size';
    row('窗口大小', sizeSel);

    // 默认目标货币
    const targetSel = selectOf(ALL_CODES, cfg.target, '', '默认目标货币');
    targetSel.dataset.cfg = 'target';
    row('默认目标货币', targetSel);

    // 详细模式显示哪些货币
    const multi = el('div');
    ALL_CODES.slice(0, 12).forEach(function (c) {
      const lab = el('label', 'settings-label');
      const cb = el('input');
      cb.type = 'checkbox'; cb.value = c;
      cb.checked = cfg.detailTargets.indexOf(c) >= 0;
      cb.dataset.cfg = 'detailTarget';
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(' ' + c));
      multi.appendChild(lab);
    });
    row('详细模式显示', multi, 'col');

    // 缓存
    const ttlSel = el('select');
    [[30, '30 分钟'], [60, '1 小时'], [240, '4 小时'], [1440, '1 天']].forEach(function (o) {
      const opt = el('option', null, o[1]); opt.value = String(o[0]);
      if (cfg.ttlMinutes === o[0]) opt.selected = true;
      ttlSel.appendChild(opt);
    });
    ttlSel.dataset.cfg = 'ttlMinutes';
    row('汇率缓存时间', ttlSel);

    // 右键复制
    const rcc = el('input'); rcc.type = 'checkbox'; rcc.checked = !!cfg.rightClickCopy; rcc.dataset.cfg = 'rightClickCopy';
    row('右键点击卡片 = 复制', rcc);

    // 显示证据
    const evCb = el('input'); evCb.type = 'checkbox'; evCb.checked = !!cfg.showEvidence; evCb.dataset.cfg = 'showEvidence';
    row('详细模式显示识别证据', evCb);

    // 本站禁用
    const dis = el('input'); dis.type = 'checkbox'; dis.checked = cfg.disabledHosts.indexOf(location.hostname) >= 0; dis.dataset.cfg = 'siteDisabled';
    row('在本站禁用（' + location.hostname + '）', dis);

    // 站点记忆
    const memWrap = el('div', 'settings-memory');
    part(memWrap, 'settings-memory');
    const keys = Object.keys(cfg.memory).filter(function (k) { return k.indexOf(location.hostname + '|') === 0; });
    const siteT = cfg.siteTarget[location.hostname];
    memWrap.textContent = (keys.length || siteT)
      ? keys.map(function (k) { return k.split('|')[1] + ' → ' + cfg.memory[k]; }).join('，') + (siteT ? '；目标 ' + siteT : '')
      : '（无）';
    const clearMem = el('button', null, '清除本域名记忆');
    clearMem.dataset.act = 'clear-memory';
    const memRow = row('本域名校准记忆', clearMem);
    memRow.appendChild(memWrap);

    // 自定义主题 CSS
    const ta = el('textarea');
    ta.rows = 4;
    ta.placeholder = ':host{--fxph-accent:#ffb703} /* 设计师的 CSS 写这里 */';
    ta.value = cfg.themeCss || '';
    ta.dataset.cfg = 'themeCss';
    const themeRow = row('自定义主题 CSS（外包接口）', ta, 'col');
    void themeRow;

    const actions = el('div', 'settings-actions');
    part(actions, 'settings-actions');
    const reset = el('button', null, '恢复默认设置');
    reset.dataset.act = 'reset';
    const diag = el('button', null, '复制诊断信息');
    diag.dataset.act = 'copy-diag';
    const dump = el('button', null, '打印页面画像');
    dump.dataset.act = 'dump-profile';
    actions.appendChild(reset); actions.appendChild(diag); actions.appendChild(dump);
    box.appendChild(actions);

    box.addEventListener('change', onSettingsChange);
    box.addEventListener('input', onSettingsChange);
    box.addEventListener('click', function (e) {
      const b = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'close-settings') { closeSettings(); }
      else if (act === 'clear-memory') {
        Object.keys(cfg.memory).forEach(function (k) { if (k.indexOf(location.hostname + '|') === 0) delete cfg.memory[k]; });
        delete cfg.siteTarget[location.hostname];
        saveCfg();
        openSettings();
      } else if (act === 'reset') {
        Object.assign(cfg, JSON.parse(JSON.stringify(DEFAULTS)));
        saveCfg();
        applyTheme();
        openSettings();
      } else if (act === 'copy-diag') {
        const text = JSON.stringify({ version: VERSION, host: location.hostname, cfg: cfg, rates: RATES, profile: pageProfile(), stats: stats.dump() }, null, 2);
        try { if (navigator.clipboard) navigator.clipboard.writeText(text); } catch (err) { /* 忽略 */ }
        console.log('[FXPH] 诊断', text);
      } else if (act === 'dump-profile') {
        console.table(pageProfile().census);
        console.log('[FXPH] 页面画像', pageProfile());
      }
    });

    shadow.appendChild(box);
    settingsEl = box;
    const r = card && card.style.display !== 'none' ? card.getBoundingClientRect() : null;
    box.style.left = Math.max(8, Math.min(window.innerWidth - box.offsetWidth - 8, r ? r.left : (window.innerWidth - 440) / 2)) + 'px';
    box.style.top = '24px';
    return box;
  }

  function closeSettings() {
    panelOpen = false;
    pinned = false;
    updateCardState();
    if (settingsEl) { settingsEl.remove(); settingsEl = null; }
    if (current) scheduleHide(300);
  }

  function onSettingsChange(e) {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.cfg) return;
    const key = t.dataset.cfg;
    if (key === 'detailTarget') {
      const on = [].slice.call(settingsEl.querySelectorAll('[data-cfg="detailTarget"]:checked')).map(function (c) { return c.value; });
      cfg.detailTargets = on.length ? on : DEFAULTS.detailTargets.slice();
    } else if (key === 'siteDisabled') {
      const i = cfg.disabledHosts.indexOf(location.hostname);
      if (t.checked && i < 0) cfg.disabledHosts.push(location.hostname);
      if (!t.checked && i >= 0) cfg.disabledHosts.splice(i, 1);
      if (t.checked) hideCard(true);
    } else if (key === 'dwellMs' || key === 'ttlMinutes') {
      cfg[key] = Number(t.value);
    } else if (key === 'rightClickCopy' || key === 'showEvidence') {
      cfg[key] = !!t.checked;
    } else if (key === 'themeCss') {
      cfg.themeCss = t.value;
    } else {
      cfg[key] = t.value;
    }
    saveCfg();
    applyTheme();
    if (current && key !== 'themeCss') { renderCard(current); place(currentRect, lastPoint); }
  }

  /* ---- 悬停探测 ---- */
  function tryDetect(x, y) {
    stats.scans++;
    let top = null;
    try { top = document.elementFromPoint(x, y); } catch (e) { top = null; }
    if (!top || isHost(top) || isSkippedElement(top)) { stats.reject('元素被跳过'); return false; }
    const caret = caretTextAt(x, y);
    if (!caret) { stats.reject('光标下无文本节点'); return false; }
    const node = caret.node;
    if (isSkippedElement(node.parentElement)) { stats.reject('节点被跳过'); return false; }
    const data = node.data;
    const WIN = 56;
    const from = Math.max(0, caret.offset - WIN);
    const to = Math.min(data.length, caret.offset + WIN);
    const slice = data.slice(from, to);
    const rel = caret.offset - from;

    // 先用来便宜的上下文（只有语言/域名）；只有真的出现低置信候选才做全页画像
    let out = parseAll(slice, ctx(false));
    if (out.accepted.some(function (m) { return m.conf < 0.85; })) {
      stats.deepScans++;
      const deep = parseAll(slice, ctx(true));
      if (deep.accepted.length) out = deep;
    }
    if (!out.accepted.length) { stats.reject('窗口内无金额'); return false; }

    let best = null; let bestDist = Infinity;
    out.accepted.forEach(function (m) {
      const d = (rel >= m.start && rel <= m.end) ? 0 : Math.min(Math.abs(rel - m.start), Math.abs(rel - m.end));
      if (d < bestDist) { bestDist = d; best = m; }
    });
    if (!best || bestDist > 12) { stats.reject('光标不在金额附近'); return false; }
    const rect = rangeRect(node, best.start + from, best.end + from);
    if (!rect) { stats.reject('取不到金额矩形'); return false; }
    const PAD = 6;
    if (x < rect.left - PAD || x > rect.right + PAD || y < rect.top - PAD || y > rect.bottom + PAD) {
      stats.reject('光标未真正落在金额上');
      return false;
    }
    stats.hit(best.code);
    showCard(x, y, { match: best, rect: rect, element: top });
    if (cfg.debug) console.log('[FXPH] 命中', best);
    return true;
  }

  function onMouseMove(e) {
    if (!cfg.enabled || hostDisabled() || panelOpen) return;
    const x = e.clientX; const y = e.clientY;
    let overCard = false;
    try { overCard = isHost(document.elementFromPoint(x, y)); } catch (err) { overCard = false; }
    if (overCard) { cancelHide(); return; }
    if (lastPoint && Math.abs(x - lastPoint.x) < 3 && Math.abs(y - lastPoint.y) < 3) return;
    lastPoint = { x: x, y: y };
    cancelHide();
    if (dwellTimer) clearTimeout(dwellTimer);
    dwellTimer = setTimeout(function () { tryDetect(lastPoint.x, lastPoint.y); }, cfg.dwellMs);
    scheduleHide(340);
  }

  function onScrollOrKey(e) {
    if (e && e.type === 'keydown') {
      if (e.key === 'Escape') { closeSettings(); pinned = false; hideCard(true); }
      return;
    }
    hideCard(true);
  }

  function hostDisabled() { return cfg.disabledHosts.indexOf(location.hostname) >= 0; }

  /* ==========================================================================
   * D. 调试层
   * ========================================================================== */

  function scanPage() {
    const out = [];
    if (!document.body) return out;
    const c = ctx(true);
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.data || !/\d/.test(n.data)) return NodeFilter.FILTER_REJECT;
        if (!n.parentElement || isSkippedElement(n.parentElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = w.nextNode())) {
      const res = parseAll(n.data, c);
      res.accepted.forEach(function (m) {
        const p = n.parentElement;
        out.push({
          text: m.raw, code: m.code, amount: m.amount, conf: m.conf, why: m.why,
          evidence: m.evidence.slice(0, 3).map(function (e) { return e.why + '(+' + e.w + ')'; }).join(' '),
          where: p.tagName.toLowerCase() + (p.className ? '.' + String(p.className).split(/\s+/)[0] : ''),
        });
      });
    }
    return out;
  }

  const api = {
    version: VERSION,
    cfg: cfg,
    stats: stats,
    parseAll: parseAll,
    parseText: parseText,
    parseNumber: parseNumber,
    resolveCurrency: resolveCurrency,
    profile: pageProfile,
    buildProfile: buildProfile,
    markerCensus: markerCensus,
    convert: function (amount, from, to) { return convertAmount(RATES.table, amount, from, to); },
    rates: function () { return Object.assign({}, RATES); },
    refresh: function () { return ensureRates(true); },
    scan: scanPage,
    detectAt: tryDetect,
    settings: openSettings,
    closeSettings: closeSettings,
    setTheme: function (css) { cfg.themeCss = String(css || ''); saveCfg(); applyTheme(); },
    set: function (k, v) {
      cfg[k] = v; saveCfg(); applyTheme();
      if (current) { renderCard(current); place(currentRect, lastPoint); }
    },
    save: saveCfg,
    hide: function () { hideCard(true); },
    explain: function (text, c) {
      const out = parseAll(text, c || ctx(true), { includeRejected: true });
      out.accepted.forEach(function (m) { console.log('[FXPH] ' + m.raw + ' → ' + m.code + ' (' + m.conf + ') ' + m.why, m.totals, m.evidence); });
      if (!out.accepted.length) console.log('[FXPH] 未识别', out.rejected);
      return out;
    },
  };

  function publishApi() {
    try { W.__fxph = api; } catch (e) { /* 忽略 */ }
    try { if (typeof window !== 'undefined' && window !== W) window.__fxph = api; } catch (e) { /* 忽略 */ }
    try { document.documentElement.dataset.fxph = VERSION; } catch (e) { /* 忽略 */ }
    try { document.dispatchEvent(new CustomEvent('fxph-ready', { detail: VERSION })); } catch (e) { /* 忽略 */ }
  }

  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    GM_registerMenuCommand('FX Pulse：设置面板', openSettings);
    GM_registerMenuCommand('FX Pulse：切换到' + (cfg.mode === 'simple' ? '详细' : '简单') + '模式', function () {
      cfg.mode = cfg.mode === 'simple' ? 'detail' : 'simple';
      saveCfg(); applyTheme();
      if (current) { renderCard(current); place(currentRect, lastPoint); }
      console.log('[FXPH] mode =', cfg.mode);
    });
    GM_registerMenuCommand('FX Pulse：调试日志 ' + (cfg.debug ? '关' : '开'), function () {
      cfg.debug = !cfg.debug; saveCfg();
      console.log('[FXPH] debug =', cfg.debug);
    });
    GM_registerMenuCommand('FX Pulse：刷新汇率（忽略缓存）', function () {
      ensureRates(true).then(function (r) { console.log('[FXPH] 汇率', r.source, r.updated, r.stale ? '(stale)' : ''); });
    });
    GM_registerMenuCommand('FX Pulse：' + (hostDisabled() ? '在本站启用' : '在本站禁用'), function () {
      const h = location.hostname;
      const i = cfg.disabledHosts.indexOf(h);
      if (i >= 0) cfg.disabledHosts.splice(i, 1); else cfg.disabledHosts.push(h);
      saveCfg(); hideCard(true);
      console.log('[FXPH] disabledHosts =', cfg.disabledHosts);
    });
    GM_registerMenuCommand('FX Pulse：清空本域名校准记忆', function () {
      const p = location.hostname + '|';
      Object.keys(cfg.memory).forEach(function (k) { if (k.indexOf(p) === 0) delete cfg.memory[k]; });
      delete cfg.siteTarget[location.hostname];
      saveCfg();
      console.log('[FXPH] 已清空本域名记忆');
    });
    GM_registerMenuCommand('FX Pulse：打印页面画像与统计', function () {
      console.log('[FXPH] 页面画像', pageProfile());
      console.table(pageProfile().census);
      console.log('[FXPH] stats', stats.dump());
    });
    GM_registerMenuCommand('FX Pulse：扫描整页并输出识别结果', function () {
      const rows = scanPage();
      console.table(rows);
      console.log('[FXPH] 共识别', rows.length, '处金额');
    });
  }

  /* ---- 自检页联动：只通过共享 DOM 通信，不依赖 window.__fxph ---- */
  function setupFixture() {
    const root = document.getElementById('fxph-fixture');
    if (!root) return;
    const summary = document.getElementById('fxph-summary');
    const status = document.getElementById('fxph-status');
    const say = function (msg, cls) { if (summary) { summary.textContent = msg; summary.className = 'summary ' + (cls || ''); } };
    const setStatus = function (msg) { if (status) status.textContent = msg; };

    function ctxOf(tr) {
      const d = tr.dataset;
      const base = {
        lang: d.fxphLang === undefined ? 'zh-CN' : d.fxphLang,
        host: d.fxphHost || 'example.com',
        memory: {},
        signals: d.fxphSignals || '',
      };
      if (d.fxphProfile) {
        try { base.profile = JSON.parse(d.fxphProfile); } catch (e) { /* 忽略 */ }
      }
      return base;
    }

    function runRow(tr) {
      const cell = tr.querySelector('[data-fxph-result]');
      const text = tr.dataset.fxphText || '';
      const expect = tr.dataset.fxphExpect || '';
      const amb = tr.dataset.fxphAmb === '1';
      const out = parseAll(text, ctxOf(tr), { includeRejected: true });
      const first = out.accepted[0] || null;
      let ok = false;
      let msg;
      if (!expect) {
        ok = out.accepted.length === 0;
        msg = ok ? '✓ 未识别' + (out.rejected[0] ? '（' + out.rejected[0].reason + '）' : '')
          : '✗ 误判为 ' + out.accepted.map(function (a) { return a.code + ' ' + a.amount; }).join(', ');
      } else if (!first) {
        msg = '✗ 没识别出来' + (out.rejected[0] ? '（' + out.rejected[0].reason + '）' : '');
      } else {
        const parts = expect.split(' ');
        const amountOk = Math.abs(first.amount - Number(parts[1])) < 1e-6;
        const ambOk = !amb || (first.alts && first.alts.length > 1);
        ok = first.code === parts[0] && amountOk && ambOk && out.accepted.length === 1;
        msg = (ok ? '✓ ' : '✗ ') + first.code + ' ' + first.amount + ' · conf=' + first.conf +
          ' · 候选=[' + (first.alts || []).join('/') + '] · ' + first.why;
      }
      if (cell) { cell.textContent = msg; cell.className = 'actual ' + (ok ? 'ok' : 'bad'); }
      return ok;
    }

    function runAll() {
      const rows = [].slice.call(root.querySelectorAll('tr[data-fxph-text]'));
      let pass = 0;
      rows.forEach(function (tr) { if (runRow(tr)) pass++; });
      say(pass + ' / ' + rows.length + ' 通过', pass === rows.length ? 'ok' : 'bad');
      return pass;
    }

    const on = function (id, fn) { const b = document.getElementById(id); if (b) b.addEventListener('click', fn); };
    on('fxph-run', runAll);
    on('fxph-scan', function () { const rows = scanPage(); console.table(rows); say('整页识别 ' + rows.length + ' 处（见 console）', ''); });
    on('fxph-stats', function () { const d = stats.dump(); console.log(d); say('scans=' + d.scans + ' hits=' + d.hits + '（详见 console）', ''); });
    on('fxph-refresh', function () {
      ensureRates(true).then(function (r) {
        setStatus(r.source + ' · ' + r.updated + (r.stale ? '（stale）' : '') + ' · ' + Object.keys(r.table || {}).length + ' 个币种');
      });
    });
    on('fxph-hide', function () { hideCard(true); });
    on('fxph-settings', openSettings);
    on('fxph-mode', function () {
      cfg.mode = cfg.mode === 'simple' ? 'detail' : 'simple';
      saveCfg(); applyTheme();
      const b = document.getElementById('fxph-mode');
      if (b) b.textContent = '模式：' + (cfg.mode === 'simple' ? '简单' : '详细');
    });

    ensureRates(false).then(function () {
      setStatus(RATES.source + ' · ' + RATES.updated + (RATES.stale ? '（stale）' : '') + ' · ' +
        Object.keys(RATES.table || {}).length + ' 个币种' + (RATES.error ? ' · 上次错误：' + RATES.error : ''));
      const p = pageProfile();
      say('脚本已加载 v' + VERSION + ' · 本页画像：假名 ' + (p.ratios.kana * 100).toFixed(2) + '% / 汉字 ' +
        (p.ratios.han * 100).toFixed(1) + '% / lang=' + (p.lang || '空') + ' · 点「运行解析自检」', 'ok');
      runAll();
    });
  }

  function init() {
    buildUi();
    publishApi();
    setupFixture();
    ensureRates(false);
    window.addEventListener('mousemove', onMouseMove, { passive: true, capture: true });
    window.addEventListener('scroll', onScrollOrKey, { passive: true, capture: true });
    window.addEventListener('wheel', onScrollOrKey, { passive: true, capture: true });
    window.addEventListener('keydown', onScrollOrKey, true);
    window.addEventListener('blur', function () { hideCard(true); });
    registerMenu();
    console.log('%c[FXPH] FX Pulse Hover ' + VERSION + ' 已加载', 'color:#56e39f',
      '模式=' + cfg.mode + ' 大小=' + cfg.size + ' 悬停=' + cfg.dwellMs + 'ms · 调试：__fxph.explain("¥1,000") / __fxph.profile() / __fxph.settings()');
  }

  if (isBrowser) {
    try {
      init();
    } catch (err) {
      try { document.documentElement.dataset.fxphError = String((err && err.message) || err); } catch (e) { /* 忽略 */ }
      try { console.error('[FXPH] 初始化失败：', err); } catch (e) { /* 忽略 */ }
    }
  }

  /* node 下单测用（浏览器里 module 未定义，自动跳过） */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      VERSION: VERSION, parseAll: parseAll, parseText: parseText, parseNumber: parseNumber,
      convertAmount: convertAmount, formatMoney: formatMoney, resolveCurrency: resolveCurrency,
      markerCensus: markerCensus, profileOf: profileOf, buildProfile: buildProfile,
      MARKERS: MARKERS, CURRENCIES: CURRENCIES, FALLBACK_TABLE: FALLBACK_TABLE, DEFAULT_TLD: TLD_CURRENCY,
    };
  }
})();
