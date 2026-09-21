/* Shared fixtures: the generated extension parser must agree with the legacy
   userscript parser on every one of these. Add a case whenever a detection bug
   is fixed, so the generator cannot silently drift from the source of truth. */
module.exports = [
  // Plain markers, prefix and suffix
  {id: 'usd-prefix', text: 'It costs $19.99 today'},
  {id: 'usd-code', text: 'Total: USD 1,299.50'},
  {id: 'cny-rmb', text: '合计 RMB 1280 元'},
  {id: 'cny-word', text: '价格 人民币 88.50'},
  {id: 'jpy-kanji', text: '価格は 1,980 円です', lang: 'ja'},
  {id: 'jpy-code', text: 'JPY 12,800'},
  {id: 'eur-symbol', text: 'Nur €49,90 heute', lang: 'de'},
  {id: 'gbp-symbol', text: 'Only £12.00'},
  {id: 'krw-symbol', text: '가격 ₩35,000', lang: 'ko'},
  {id: 'thb-symbol', text: 'ราคา ฿1,250', lang: 'th'},

  // Disambiguated dollar and yen families
  {id: 'hkd', text: 'HK$ 980'},
  {id: 'twd', text: 'NT$ 1,590'},
  {id: 'usd-explicit', text: 'US$ 45'},
  {id: 'aud', text: 'A$ 60'},
  {id: 'cad', text: 'C$ 60'},
  {id: 'yen-ambiguous-jp-host', text: '¥5,800', host: 'store.example.jp', lang: 'ja'},
  {id: 'yen-ambiguous-cn-host', text: '¥5,800', host: 'shop.example.cn', lang: 'zh-CN'},
  {id: 'yen-fullwidth', text: '￥1,200', host: 'example.cn'},
  {id: 'dollar-au-host', text: '$120', host: 'shop.example.au'},
  {id: 'dollar-unknown-host', text: '$120', host: 'example.com'},
  {id: 'yuan-ambiguous-tw', text: '定價 1,200 元', host: 'shop.example.tw', lang: 'zh-TW'},
  {id: 'kroner-ambiguous', text: 'Pris 299 kr', host: 'butikk.example.no'},

  // Magnitudes
  {id: 'wan', text: '总价 12.8 万元'},
  {id: 'yi', text: '融资 3 亿日元', lang: 'zh-CN'},
  {id: 'man-ja', text: '価格 5万円', lang: 'ja'},
  {id: 'k-suffix', text: 'About $12k'},
  {id: 'm-suffix', text: 'Raised $3.5M'},

  // Number formats
  {id: 'thousands-comma', text: '$1,234,567.89'},
  {id: 'european-decimal', text: '1.234,56 EUR', lang: 'de'},
  {id: 'space-thousands', text: '1 234 567 JPY'},
  {id: 'bare-decimal', text: 'USD 0.99'},

  // Must NOT be quoted
  {id: 'negative-dash', text: '-$10'},
  {id: 'negative-unicode', text: '−10 USD'},
  {id: 'accounting-parens', text: '($10)'},
  {id: 'trailing-negative', text: 'USD -10'},
  {id: 'no-marker', text: 'just 1234 items'},
  {id: 'km-unit', text: 'drove 100 km today'},
  {id: 'mb-unit', text: 'downloaded 100 MB'},
  {id: 'php-language', text: 'requires PHP 8.2 or newer'},
  {id: 'version-string', text: 'version 2.10.4 released'},
  {id: 'percent', text: 'grew 12% this year'},

  // Mixed sentences with several amounts
  {id: 'two-amounts', text: 'Was $199, now $149'},
  {id: 'mixed-currencies', text: '日本では 1,980 円、中国では 98 元です', lang: 'ja'},
];
