/*
 * 识别用例（浏览器与 node 共用）
 * 只依赖纯逻辑层，浏览器里挂到全局 FXPH_CASES，node 里用 module.exports。
 *
 * 字段：
 *   text     页面文本（会被真实渲染，供鼠标悬停测试；也会直接喂给 parseAll 做自检）
 *   expect   "CODE 金额" 或 null（表示不应该识别出任何金额）
 *   amb      true 表示该标记本身有歧义，识别成功时 alts 必须非空
 *   lang     解析上下文：页面语言
 *   host     解析上下文：域名（影响 .jp / .cn 推断）
 *   signals  解析上下文：页面正文样本（用于无 lang/域名的兜底推断）
 *   note     人看的说明
 */
const FXPH_CASES = [
  // —— 符号与代码 ——
  { id: 'usd-basic',   text: '$1,299.00',        expect: 'USD 1299',    note: '最常见写法' },
  { id: 'usd-us$',     text: 'US$ 1,299',        expect: 'USD 1299',    note: 'US$ 前缀，必须优先于裸 $' },
  { id: 'usd-code',    text: 'USD 1,299.00',     expect: 'USD 1299',    note: 'ISO 代码前缀' },
  { id: 'usd-suffix',  text: '1,299.00 USD',     expect: 'USD 1299',    note: '代码后缀' },
  { id: 'usd-small',   text: '$0.99',            expect: 'USD 0.99',    note: '小额' },
  { id: 'usd-million', text: '$1.5M',            expect: 'USD 1500000', note: 'M 量级（后面不能跟字母）' },
  { id: 'hkd',         text: 'HK$500',           expect: 'HKD 500',     note: 'HK$ 优先于 $' },
  { id: 'twd',         text: 'NT$1,200',         expect: 'TWD 1200',    note: 'NT$ 优先于 $' },
  { id: 'sgd',         text: 'S$ 88',            expect: 'SGD 88',      note: '' },
  { id: 'krw',         text: '₩ 45,000',         expect: 'KRW 45000',   note: '' },
  { id: 'thb',         text: '฿1,250',           expect: 'THB 1250',    note: '' },
  { id: 'myr',         text: '100 MYR',          expect: 'MYR 100',     note: '量级后缀不能吃掉 MYR 的 M' },
  { id: 'eur-suffix',  text: '1,29 €',           expect: 'EUR 1.29',    note: '欧陆小数逗号' },
  { id: 'eur-de',      text: '1.299,00 €',       expect: 'EUR 1299',    note: '两个分隔符：靠后的是小数点' },
  { id: 'eur-dots',    text: '€1.234',           expect: 'EUR 1234',    note: '点作千分位（与 $1.000 同类，见 known-limits）' },

  // —— 中文 / 日文 ——
  { id: 'jpy-yen-sign', text: '1,000円',         expect: 'JPY 1000',    note: '円 明确是日元' },
  { id: 'jpy-taxin',    text: '税込 12,800円',   expect: 'JPY 12800',   note: '' },
  { id: 'cny-yuan',     text: '1,000元',         expect: 'CNY 1000',    note: '元 = 人民币' },
  { id: 'cny-wan',      text: '1.2万元',         expect: 'CNY 12000',   note: '1.2 万 = 12000' },
  { id: 'cny-yi',       text: '3.5亿元',         expect: 'CNY 350000000', note: '亿 = 1e8' },
  { id: 'cny-spaced',   text: '约 1,000 元',     expect: 'CNY 1000',    note: '数字与货币单位间有空格' },
  { id: 'cny-fen',      text: '4.8元',           expect: 'CNY 4.8',     note: '小额' },
  { id: 'usd-zh',       text: '100美元',         expect: 'USD 100',     note: '中文币种名后缀' },
  { id: 'jpy-zh-wan',   text: '50万日元',        expect: 'JPY 500000',  note: '量级 + 中文币种名' },
  { id: 'jpy-zh',       text: '日元100',         expect: 'JPY 100',     note: '中文币种名前缀' },
  { id: 'cny-prefix',   text: '价格：￥12,800',  expect: 'CNY 12800',   note: '全角 ￥ + 中文语境' },

  // —— ¥ 歧义：同一段文本，靠上下文消歧 ——
  { id: 'yen-zh-lang',  text: '¥1,000', expect: 'CNY 1000', amb: true, lang: 'zh-CN', host: 'item.taobao.com', note: '中文站点 → CNY' },
  { id: 'yen-ja-lang',  text: '¥1,000', expect: 'JPY 1000', amb: true, lang: 'ja',    host: 'www.amazon.co.jp', note: '日文站点 → JPY（差 20 倍，最关键的一条）' },
  { id: 'yen-tld-jp',   text: '¥1,000', expect: 'JPY 1000', amb: true, lang: '',      host: 'shop.rakuten.co.jp', note: '只有 .jp 域名' },
  { id: 'yen-tld-cn',   text: '¥1,000', expect: 'CNY 1000', amb: true, lang: '',      host: 'www.gov.cn', note: '只有 .cn 域名' },
  { id: 'yen-signals',  text: '¥1,000', expect: 'JPY 1000', amb: true, lang: 'en', host: 'example.com',
    signals: '送料無料 税込 ポイント 円 円 円', note: '无语言无域名，靠页面日文信号' },
  { id: 'yen-nosignal', text: '¥1,000', expect: 'CNY 1000', amb: true, lang: 'en',    host: 'example.com', signals: 'some english text', note: '无任何信号 → 默认 CNY 但必须标注为猜测' },
  { id: 'fullwidth-yen', text: '￥12,800', expect: 'CNY 12800', amb: true, lang: 'zh-CN', host: 'example.com', note: '' },
  { id: 'dollar-amb',   text: '$1,299', expect: 'USD 1299', amb: true, lang: 'en-US', host: 'www.amazon.com', note: '裸 $ 保留候选币种' },

  // —— 必须不识别（误判陷阱）——
  { id: 'no-percent',   text: '-20%',            expect: null, note: '折扣百分比' },
  { id: 'no-percent2',  text: '$100%',           expect: null, note: '带货币符号也不能当金额' },
  { id: 'no-date',      text: '2026年9月20日',   expect: null, note: '日期' },
  { id: 'no-dimension', text: '1920x1080',       expect: null, note: '分辨率' },
  { id: 'no-rating',    text: '评分 4.8',        expect: null, note: '评分' },
  { id: 'no-distance',  text: '100 km',          expect: null, note: 'k 后跟字母 → 不是 100k' },
  { id: 'no-phone',     text: '电话 138-1234-5678', expect: null, note: '电话号' },
  { id: 'no-isbn',      text: 'ISBN 978-7-121-23456-7', expect: null, note: 'ISBN' },
  { id: 'no-issue',     text: '第 3 期 共 12 期', expect: null, note: '期数，没有货币标记' },
  { id: 'no-bare',      text: '库存 1,299 件',   expect: null, note: '裸数字一律不认（这是最重要的规则）' },
  { id: 'no-wan-bare',  text: '1万 播放',        expect: null, note: '只有量级没有货币单位' },
  { id: 'no-zero',      text: '¥0',              expect: null, note: '0 元不作为金额' },
  { id: 'no-symbol-only', text: '价格符号 ¥ 与 $', expect: null, note: '只有符号没有数字' },
  { id: 'no-template',  text: 'total: ${price}', expect: null, note: '模板字符串' },
  { id: 'no-usd-name',  text: '美元指数 98.7',   expect: null, note: '「美元指数」里的 98.7 不是金额（无货币标记紧邻数字）' },
  { id: 'no-fontsize',  text: 'font-size: 12px', expect: null, note: 'CSS 片段' },
  { id: 'no-year-mag',  text: '2026M',           expect: null, note: '没有货币标记' },
  { id: 'no-km-money',  text: '$100 MB',         expect: 'USD 100',     note: 'M 后跟字母 → 不当百万；金额仍是 $100，MB 是单位' },
  { id: 'no-space-unit', text: '$100 500MB',     expect: null,          note: '空格千分位 + 紧跟字母 → 整条放弃，避免把 "100 500" 当成 100500' },
  { id: 'kr-space-sep', text: '1 299 kr',        expect: 'SEK 1299', amb: true, lang: 'sv', host: 'shop.example.se',
    profile: { lang: 'sv', host: 'shop.example.se', tld: 'se', ratios: { kana: 0, hangul: 0, han: 0, latin: 0.9 }, counts: { latin: 900 }, census: {}, keywords: {} },
    note: '空格作千分位（北欧/法国常见）必须解析成 1299' },

  // —— 争议 / 已知限制 ——
  { id: 'ambiguous-dot', text: '$1.000', expect: 'USD 1000', note: '按千分位解析；若站点是 en-US 本意可能是 1.00 美元' },

  /* ==========================================================================
   * v0.2 混合识别（重点）：
   * 同一段文本用不同"页面画像"解析 —— 文字体系比重 / 语言标注 / 域名 /
   * 全文货币标记普查 / 邻近前后文 / 页面关键词，各自加权后取最高分。
   * profile 字段就是喂给解析器的页面画像（真实运行时由 buildProfile() 从 DOM 采样得到）。
   * ========================================================================== */

  { id: 'mix-kana-wins', text: '¥1,000', expect: 'JPY 1000', amb: true, lang: 'zh-CN', host: 'example.com',
    profile: { lang: 'zh-CN', host: 'example.com', tld: 'com', ratios: { kana: 0.02, hangul: 0, han: 0.3, latin: 0.1 }, counts: { kana: 40 }, census: {}, keywords: {} },
    note: 'lang 写错成 zh-CN，但假名占比 2% → 仍判 JPY（文字体系压过语言标注）' },
  { id: 'mix-kana-tiny', text: '¥1,000', expect: 'JPY 1000', amb: true, lang: 'en', host: 'example.com',
    profile: { lang: 'en', host: 'example.com', tld: 'com', ratios: { kana: 0.004, hangul: 0, han: 0.2, latin: 0.3 }, counts: { kana: 8 }, census: {}, keywords: {} },
    note: '假名 0.4% → 中等强度证据，已足以压过英文页面"无证据"的默认倾向' },
  { id: 'mix-one-kana', text: '¥1,000', expect: 'CNY 1000', amb: true, lang: 'zh-CN', host: 'example.com',
    profile: { lang: 'zh-CN', host: 'example.com', tld: 'com', ratios: { kana: 0, hangul: 0, han: 0.6, latin: 0.05 }, counts: { kana: 1, han: 900 }, census: {}, keywords: {} },
    note: '中文页里出现 1 个假名（品牌名）不该翻盘 → 仍 CNY，但降为"猜测"并给下拉校准' },
  { id: 'mix-census-yen', text: '¥1,000', expect: 'JPY 1000', amb: true, lang: 'en', host: 'example.com',
    profile: { lang: 'en', host: 'example.com', tld: 'com', ratios: { kana: 0, hangul: 0, han: 0.05, latin: 0.5 }, counts: { han: 40 }, census: { '円': 6, '~円': 2 }, keywords: { jp: 2 } },
    note: '无语言无域名，但全文「円」出现 8 次 → JPY（全文货币标记普查）' },
  { id: 'mix-census-yuan', text: '¥1,000', expect: 'CNY 1000', amb: true, lang: 'en', host: 'example.com',
    profile: { lang: 'en', host: 'example.com', tld: 'com', ratios: { kana: 0, hangul: 0, han: 0.2, latin: 0.3 }, counts: { han: 120 }, census: { '元': 9, '~元': 3 }, keywords: {} },
    note: '同页「元」出现 12 次 → CNY' },
  { id: 'mix-census-tie', text: '¥1,000', expect: 'CNY 1000', amb: true, lang: 'en', host: 'example.com',
    profile: { lang: 'en', host: 'example.com', tld: 'com', ratios: { kana: 0, hangul: 0, han: 0.2, latin: 0.3 }, counts: { han: 120 }, census: { '円': 6, '元': 6 }, keywords: {} },
    note: '円 与 元 各 6 次打平 → 落到默认 CNY，且必须标成猜测（低置信 + 下拉）' },
  { id: 'mix-local-jp', text: '送料無料 ¥1,000', expect: 'JPY 1000', amb: true, lang: 'en', host: 'example.com',
    profile: { lang: 'en', host: 'example.com', tld: 'com', ratios: { kana: 0, hangul: 0, han: 0.1, latin: 0.4 }, counts: { han: 20 }, census: {}, keywords: {} },
    note: '前后文识别：紧邻的「送料無料」把 ¥ 推向 JPY' },
  { id: 'mix-local-cn', text: '含税 ¥1,000', expect: 'CNY 1000', amb: true, lang: 'en', host: 'example.com',
    profile: { lang: 'en', host: 'example.com', tld: 'com', ratios: { kana: 0, hangul: 0, han: 0.1, latin: 0.4 }, counts: { han: 20 }, census: {}, keywords: {} },
    note: '前后文识别：紧邻的「含税」把 ¥ 推向 CNY' },
  { id: 'mix-tw-yuan', text: '1,000元', expect: 'TWD 1000', lang: 'zh-TW', host: 'shop.example.tw',
    profile: { lang: 'zh-TW', host: 'shop.example.tw', tld: 'tw', ratios: { kana: 0, hangul: 0, han: 0.7, latin: 0.05 }, counts: { han: 700 }, census: { 'NT$': 4 }, keywords: {} },
    note: '台湾站点写「元」时是 TWD：lang=zh-TW + .tw + 全文出现 NT$' },
  { id: 'mix-tw-yen-sign', text: '¥1,000', expect: 'CNY 1000', amb: true, lang: 'zh-TW', host: 'shop.example.tw',
    profile: { lang: 'zh-TW', host: 'shop.example.tw', tld: 'tw', ratios: { kana: 0, hangul: 0, han: 0.7, latin: 0.05 }, counts: { han: 700 }, census: { 'NT$': 4 }, keywords: {} },
    note: '台湾页面的 ¥ 不该被当成 TWD（TWD 不用 ¥ 符号）→ CNY，低置信给下拉' },
  { id: 'mix-cad-site', text: '$1,299', expect: 'CAD 1299', amb: true, lang: 'en-CA', host: 'shop.example.ca',
    profile: { lang: 'en-CA', host: 'shop.example.ca', tld: 'ca', ratios: { kana: 0, hangul: 0, han: 0, latin: 0.8 }, counts: { latin: 800 }, census: {}, keywords: {} },
    note: '.ca 的 $ 是加元：域名证据 5 分压过 USD 的先验 2 分' },
  { id: 'mix-aud-site', text: '$99', expect: 'AUD 99', amb: true, lang: 'en-AU', host: 'shop.example.com.au',
    profile: { lang: 'en-AU', host: 'shop.example.com.au', tld: 'au', ratios: { kana: 0, hangul: 0, han: 0, latin: 0.8 }, counts: { latin: 800 }, census: {}, keywords: {} },
    note: '.com.au 的 $ 是澳元' },
  { id: 'mix-usd-default', text: '$99', expect: 'USD 99', amb: true, lang: 'en-US', host: 'shop.example.com',
    profile: { lang: 'en-US', host: 'shop.example.com', tld: 'com', ratios: { kana: 0, hangul: 0, han: 0, latin: 0.9 }, counts: { latin: 900 }, census: {}, keywords: {} },
    note: '没有任何其他证据时 $ 落回 USD（先验），仍是低置信 → 下拉可校准' },
  { id: 'mix-kr-se', text: '1 299 kr', expect: 'SEK 1299', amb: true, lang: 'sv', host: 'shop.example.se',
    profile: { lang: 'sv', host: 'shop.example.se', tld: 'se', ratios: { kana: 0, hangul: 0, han: 0, latin: 0.9 }, counts: { latin: 900 }, census: {}, keywords: {} },
    note: '北欧 kr 靠域名区分：.se → SEK（同时验证空格千分位 1 299）' },
  { id: 'mix-kr-no', text: '1 299 kr', expect: 'NOK 1299', amb: true, lang: 'no', host: 'shop.example.no',
    profile: { lang: 'no', host: 'shop.example.no', tld: 'no', ratios: { kana: 0, hangul: 0, han: 0, latin: 0.9 }, counts: { latin: 900 }, census: {}, keywords: {} },
    note: '.no → NOK' },
  { id: 'mix-kr-dk', text: '1 299 kr', expect: 'DKK 1299', amb: true, lang: 'da', host: 'shop.example.dk',
    profile: { lang: 'da', host: 'shop.example.dk', tld: 'dk', ratios: { kana: 0, hangul: 0, han: 0, latin: 0.9 }, counts: { latin: 900 }, census: {}, keywords: {} },
    note: '.dk → DKK' },
  { id: 'mix-kr-nolink', text: '1 299 kr', expect: 'SEK 1299', amb: true, lang: 'en', host: 'example.com',
    profile: { lang: 'en', host: 'example.com', tld: 'com', ratios: { kana: 0, hangul: 0, han: 0, latin: 0.9 }, counts: { latin: 900 }, census: {}, keywords: {} },
    note: '没有域名证据时 kr 只能猜第一个候选，且必须显示为猜测' },
  { id: 'mix-hangul', text: '45,000원', expect: 'KRW 45000', lang: 'ko', host: 'shop.example.kr',
    profile: { lang: 'ko', host: 'shop.example.kr', tld: 'kr', ratios: { kana: 0, hangul: 0.5, han: 0, latin: 0.1 }, counts: { hangul: 500 }, census: {}, keywords: {} },
    note: '谚文占比 + 韩文单位 + .kr → KRW' },
  { id: 'mix-thai', text: '฿1,250', expect: 'THB 1250', lang: 'th', host: 'shop.example.co.th',
    profile: { lang: 'th', host: 'shop.example.co.th', tld: 'th', ratios: { kana: 0, hangul: 0, han: 0, latin: 0.3 }, counts: {}, census: {}, keywords: {} },
    note: '.co.th 要能解析出 tld=th' },
];

if (typeof module !== 'undefined' && module.exports) module.exports = FXPH_CASES;
