// 把 theme.css 与 GPT-Image 资产打包进可直接安装的单文件 userscript。
import { readFileSync, writeFileSync } from 'node:fs';

const scriptPath = new URL('./fx-pulse-hover.user.js', import.meta.url);
const cssPath = new URL('./theme.css', import.meta.url);
const imagePath = new URL('./assets/exchange-globe.png', import.meta.url);
const image = readFileSync(imagePath).toString('base64');
const css = readFileSync(cssPath, 'utf8').replace(
  'url("./assets/exchange-globe.png")',
  `url("data:image/png;base64,${image}")`,
);
if (css.includes('./assets/exchange-globe.png')) throw new Error('图像引用未成功内嵌');
const source = readFileSync(scriptPath, 'utf8');
const start = '  // BEGIN EMBEDDED_NEWSPAPER_THEME';
const end = '  // END EMBEDDED_NEWSPAPER_THEME';
const first = source.indexOf(start);
const last = source.indexOf(end, first);
if (first < 0 || last < 0 || source.indexOf(start, first + start.length) >= 0) {
  throw new Error('主题区域标记缺失或重复');
}
const replacement = `${start}\n  const NEWSPAPER_CSS = ${JSON.stringify(css)};\n  ${end}`;
const output = source.slice(0, first) + replacement + source.slice(last + end.length);
writeFileSync(scriptPath, output);
console.log(`已内嵌主题和图像：${css.length} 字符`);
