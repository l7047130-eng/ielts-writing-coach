/**
 * 浏览器端验证（真 Chromium，本地临时数据目录，假结果文件）
 *
 *   node scripts/verify-ui.mjs
 *
 * 覆盖：提交 → 等待 → 刷新恢复 → 失败提示 → 修正后重试 → 成功结果 → 发起复核
 * 全程不碰 ~/.ielts，不调用任何模型接口。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer, fullGrade, ageFile, queueDirs } from '../tests/helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// ---- 找 playwright-core 与 Chromium -------------------------------------
function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE_PATH,
    path.join(process.env.USERPROFILE || '', '.workbuddy/binaries/node/workspace/node_modules'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      return require(path.join(dir, 'playwright-core'));
    } catch { /* 试下一个 */ }
  }
  throw new Error('没找到 playwright-core。装一个：在 ~/.workbuddy/binaries/node/workspace 里 npm i playwright-core');
}

function findChromium() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!fs.existsSync(base)) throw new Error(`没找到 ms-playwright：${base}`);
  const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
  for (const d of dirs) {
    for (const sub of ['chrome-win64', 'chrome-win']) {
      const exe = path.join(base, d, sub, 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  throw new Error('没找到 chromium 可执行文件');
}

const ESSAY = 'Public libraries provide access to useful information. They help students find books and offer quiet places to study. Local governments should continue to support these services.';
const PROMPT = 'Some people think public libraries are a waste of money because everything is online. To what extent do you agree or disagree?';

const outDir = path.join(ROOT, 'review-artifacts', new Date().toISOString().slice(0, 10));
fs.mkdirSync(outDir, { recursive: true });

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ui-'));
const CONFIG = path.join(HOME, 'config.json');
fs.writeFileSync(CONFIG, JSON.stringify({ mode: 'queue' }));
const Q = queueDirs(HOME);

const server = await startServer({ home: HOME, config: CONFIG });
const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(`uncaught: ${e}`));
// 4xx 是流程里预期会出现的（比如故意喂不合格结果），网络日志不算前端异常
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/Failed to load resource/.test(t)) return;
  pageErrors.push(`console: ${t}`);
});

const shot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
const txt = (s) => page.getByText(s, { exact: false }).first();

async function submitEssay() {
  await page.goto(server.base, { waitUntil: 'load' });
  await page.getByPlaceholder('话题标签（可选，给看板归档用）').fill('lib-ui');
  await page.getByPlaceholder(/粘贴 Task 2 题目/).fill(PROMPT);
  await page.getByPlaceholder('粘贴或手打作文，段与段之间空一行。').fill(ESSAY);
  await page.getByRole('button', { name: '加入批改队列' }).click();
}

try {
  // ---- 1. 提交 → 等待页 ----
  await submitEssay();
  await txt('已加入批改队列').waitFor({ timeout: 15000 });
  await page.waitForSelector('text=pending/', { timeout: 10000 });
  const pathLine = await page.locator('div.font-mono').first().innerText();
  const id = /pending[\\/](.+)\.json/.exec(pathLine)?.[1];
  check('提交后进入等待页并写出任务文件', Boolean(id), id || pathLine);
  await shot('01-queue-wait');

  // ---- 2. 刷新后能找回任务 ----
  await page.reload({ waitUntil: 'load' });
  await txt('等待中的任务').waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: /T2 · lib-ui/ }).click();
  await txt('已加入批改队列').waitFor({ timeout: 10000 });
  check('刷新页面后能从侧栏回到等待中的任务', true);
  await shot('02-resume-after-reload');

  // ---- 3. 不合格结果 → 明确失败，不再无限转圈 ----
  const badDone = path.join(Q.done, `${id}.json`);
  fs.mkdirSync(Q.done, { recursive: true });
  fs.writeFileSync(badDone, JSON.stringify({ tr: 6, cc: 6, lr: 6, ga: 6 }));  // 只有分数
  ageFile(badDone, 20);

  await txt('这次没有批成').waitFor({ timeout: 20000 });
  const reason = await page.locator('div.bg-rose-50').first().innerText();
  check('不合格结果进入明确失败状态并给出原因', /点评|不完整/.test(reason), reason.replace(/\s+/g, ' ').slice(0, 90));
  await shot('03-failed-with-reason');

  // ---- 4. 换成合法结果 → 重新检查 → 成功 ----
  const goodDone = path.join(Q.done, `${id}.json`);
  fs.writeFileSync(goodDone, JSON.stringify({ passA: fullGrade(), revision: null }));
  ageFile(goodDone, 20);
  await page.getByRole('button', { name: '重新检查结果' }).click();
  await txt('综合评分').waitFor({ timeout: 25000 });
  const overall = await page.locator('span.stat-num.text-5xl, div.stat-num.text-5xl').first().innerText();
  check('修正结果后重试，成功跳到结果页', overall.trim() === '6.5', `综合分 ${overall.trim()}`);
  await shot('04-result');

  // ---- 5. 队列模式下追问：明确提示切模式，不静默发直连请求 ----
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await page.getByPlaceholder('问点什么').fill('Why is the score six?');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await txt('没有拿到回答').waitFor({ timeout: 10000 });
  const chatErr = await page.locator('div.bg-rose-50').first().innerText();
  check('队列模式下追问给出可读提示（不是静默失败）', /文件队列模式/.test(chatErr), chatErr.replace(/\s+/g, ' ').slice(0, 80));
  await shot('05-chat-blocked-in-queue-mode');

  // ---- 6. 复核入口 ----
  await page.getByRole('button', { name: '评分', exact: true }).click();
  await page.getByRole('button', { name: '发起复核' }).click();
  await txt('已加入复核队列').waitFor({ timeout: 15000 });
  check('结果页可以发起复核，并提示在新对话里跑', true);
  await shot('06-review-queued');

  check('全流程没有未捕获的前端异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  check('流程执行', false, e.message.split('\n')[0]);
  await shot('99-failure');
} finally {
  await browser.close();
  await server.stop();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过，截图在 ${outDir}`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
