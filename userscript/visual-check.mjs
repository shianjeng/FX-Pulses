// 本地浏览器视觉检查；截图写入 .visual-check（不依赖真实汇率网络）。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const output = resolve('.visual-check');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
let cnyRate = 7;
await page.route('https://open.er-api.com/**', route => route.fulfill({
  status: 200,
  headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
  body: JSON.stringify({ rates: { USD: 1, CNY: cnyRate, JPY: 150, EUR: .92, GBP: .8, HKD: 7.8, TWD: 32, KRW: 1300 }, time_last_update_utc: '2026-09-20' }),
}));
await page.goto(pathToFileURL(resolve('smoke.html')).href);
await page.waitForFunction(() => window.__fxph && window.__fxph.rates().table);

async function capture(name, color, mode = 'simple', width = 1100) {
  await page.setViewportSize({ width, height: 760 });
  const result = await page.evaluate(({ color, mode }) => {
    const api = window.__fxph;
    api.hide();
    api.set('mode', mode);
    api.set('size', mode === 'detail' ? 'l' : 'm');
    const target = document.querySelector('.t');
    target.style.backgroundColor = color;
    const range = document.createRange();
    range.selectNodeContents(target.firstChild);
    const rect = range.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    return { hit: api.detectAt(x, y), palette: document.getElementById('fxph-host').dataset.palette };
  }, { color, mode });
  const card = page.locator('#fxph-host [data-part="card"]');
  await card.screenshot({ path: resolve(output, name + '.png') });
  const box = await card.boundingBox();
  if (!result.hit || box.x < 0 || box.x + box.width > width) throw new Error(`${name} 渲染超出视口`);
  console.log(name, result, box);
}

await capture('paper', 'rgb(255,255,255)');
await capture('ink', 'rgb(18,24,30)');
await capture('marine', 'rgb(201,230,243)');
await capture('sage', 'rgb(214,232,197)');
await capture('clay', 'rgb(245,210,195)');
await capture('detail-320', 'rgb(255,255,255)', 'detail', 320);
cnyRate = 8;
await page.evaluate(() => window.__fxph.refresh());
const refreshed = await page.locator('#fxph-host [data-part="amount-main"]').textContent();
if (!refreshed.includes('10,392')) throw new Error('已打开卡片未随汇率刷新：' + refreshed);
await page.evaluate(() => window.__fxph.settings());
const settings = page.locator('#fxph-host [data-part="settings"]');
await settings.screenshot({ path: resolve(output, 'settings-320.png') });
console.log('settings-320', await settings.boundingBox());
if (pageErrors.length) throw new Error('页面脚本异常：' + pageErrors.join(' | '));
await browser.close();
