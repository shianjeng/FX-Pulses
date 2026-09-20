/*
 * 解析层单测（node 直接跑，不需要浏览器）
 *   node node-check.mjs
 * 它只验证 fx-pulse-hover.user.js 的纯逻辑层，不涉及 DOM / 油猴 API。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fx = require('./fx-pulse-hover.user.js');
const CASES = require('./cases.js');

const DEFAULT_CTX = { lang: 'zh-CN', host: 'example.com', memory: {}, signals: '' };

function ctxOf(c) {
  const ctx = {
    lang: c.lang === undefined ? DEFAULT_CTX.lang : c.lang,
    host: c.host || DEFAULT_CTX.host,
    memory: {},
    signals: c.signals || '',
  };
  if (c.profile) ctx.profile = c.profile;   // v0.2：混合识别的页面画像
  return ctx;
}

function check(c) {
  const { accepted, rejected } = fx.parseAll(c.text, ctxOf(c), { includeRejected: true });
  const first = accepted[0] || null;

  if (c.expect === null) {
    if (accepted.length === 0) return { ok: true, actual: '（未识别 ✓）' };
    return { ok: false, actual: accepted.map((a) => a.code + ' ' + a.amount).join(', ') };
  }

  const [code, amountStr] = c.expect.split(' ');
  const want = Number(amountStr);
  if (!first) {
    return { ok: false, actual: '（没识别出来）' + (rejected.length ? ' ← ' + rejected[0].reason : '') };
  }
  let ok = first.code === code && Math.abs(first.amount - want) < 1e-6;
  const ambOk = !c.amb || (first.alts && first.alts.length > 1);
  const altOk = first.alts && first.alts.indexOf(first.code) >= 0;   // 选中的币种必须在候选里
  const actual = `${first.code} ${first.amount} · conf=${first.conf} · alts=[${(first.alts || []).join('/')}] · ${first.why}`;
  if (!ok) return { ok: false, actual };
  if (!ambOk) return { ok: false, actual: actual + ' ← 缺少候选币种' };
  if (!altOk) return { ok: false, actual: actual + ' ← 选中的币种不在候选里' };
  if (accepted.length > 1) {
    return { ok: false, actual: actual + ` ← 额外多识别出 ${accepted.length - 1} 处：` + accepted.slice(1).map((a) => a.raw).join(' | ') };
  }
  return { ok: true, actual };
}

let pass = 0;
const failures = [];
for (const c of CASES) {
  const r = check(c);
  if (r.ok) {
    pass++;
    console.log(`  ok   ${c.id.padEnd(16)} ${JSON.stringify(c.text)}`);
  } else {
    failures.push({ c, r });
    console.log(`  FAIL ${c.id.padEnd(16)} ${JSON.stringify(c.text)}\n         期望: ${c.expect}\n         实际: ${r.actual}`);
  }
}

console.log(`\n${pass}/${CASES.length} 通过`);
if (failures.length) {
  console.log('失败用例 id：' + failures.map((f) => f.c.id).join(', '));
  process.exitCode = 1;
}
