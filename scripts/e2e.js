import fs from 'node:fs';
import matter from 'gray-matter';

// 端到端自测：拿一篇现成作文走完整批改，跑完打印摘要并校验落盘。
// 用法：node scripts/e2e.js [submission 文件名] [章节名]
// 会往 ~/.ielts 写一条真实记录，测完自己删。

const FILE = process.argv[2] || '20261019_task2_ageing_population.md';
const SECTION = process.argv[3] || '协作完成稿';
const SUB_DIR = 'C:/Users/cy/.ielts/writing/submissions';

const parsed = matter.read(`${SUB_DIR}/${FILE}`);
const body = parsed.content;

function section(name) {
  const lines = body.split('\n');
  const out = [];
  let on = false;
  for (const ln of lines) {
    if (/^##\s/.test(ln)) {
      on = ln.replace(/^##\s*/, '').trim() === name;
      continue;
    }
    if (on) out.push(ln);
  }
  return out.join('\n').trim();
}

const prompt = section('题目');
const essay = section(SECTION);
const words = essay.split(/\s+/).filter(Boolean).length;

console.log(`[e2e] 源文件 ${FILE}`);
console.log(`[e2e] 题目 ${prompt.length} 字符 | 作文 ${essay.length} 字符 / ${words} 词`);
console.log(`[e2e] 源记录分数 ${JSON.stringify(parsed.data.score)}`);

if (!prompt || !essay) {
  console.error('[e2e] 题目或正文为空，检查章节名');
  process.exit(1);
}

const t0 = Date.now();
const res = await fetch('http://127.0.0.1:4100/api/grade', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    task: parsed.data.task,
    prompt,
    essay,
    topic: 'e2e-' + String(parsed.data.topic || 'x'),
    duration_min: 40,
  }),
});

if (!res.ok) {
  console.error('[e2e] HTTP', res.status, (await res.text()).slice(0, 300));
  process.exit(1);
}

const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
let buf = '';
let id = null;
let done = null;
let merged = null;

for (;;) {
  const { value, done: streamDone } = await reader.read();
  if (streamDone) break;
  buf += value;
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const chunk = buf.slice(0, i);
    buf = buf.slice(i + 2);
    let ev = 'message';
    const data = [];
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length === 0) continue;
    let d;
    try { d = JSON.parse(data.join('\n')); } catch { continue; }

    if (ev === 'start') { id = d.id; console.log(`[e2e] id=${id}`); }
    if (ev === 'task') {
      console.log(`[e2e] ${d.id.padEnd(9)} ${d.status}${d.ms ? ` ${(d.ms / 1000).toFixed(1)}s` : ''}${d.score != null ? ` 分 ${d.score}` : ''}${d.message ? ` — ${String(d.message).slice(0, 160)}` : ''}`);
    }
    if (ev === 'merged') {
      merged = d;
      console.log(`[e2e] 综合 ${d.score.overall} | TR ${d.score.tr} CC ${d.score.cc} LR ${d.score.lr} GA ${d.score.ga}`);
      console.log(`[e2e] 两次独立 ${d.pass_overall.join(' / ')}，差 ${d.spread}，boundary=${d.boundary}`);
      console.log(`[e2e] 错误 ${d.errors.length} 类: ${d.errors.slice(0, 6).map((e) => `${e.tag}×${e.count}`).join(', ')}`);
      console.log(`[e2e] 优点 ${d.strengths.length} / 问题 ${d.weaknesses.length} / 下一步 ${d.next_actions.length}`);
      console.log(`[e2e] 问题1: ${String(d.weaknesses[0] || '').slice(0, 130)}`);
      const withComment = Object.entries(d.dims || {}).filter(([, v]) => v?.comment);
      console.log(`[e2e] 有逐维点评的维度: ${withComment.map(([k]) => k).join(',') || '(无)'}`);
    }
    if (ev === 'revision') {
      const n = d.text ? d.text.split(/\s+/).filter(Boolean).length : 0;
      console.log(`[e2e] 改写稿 ${n} 词${d.error ? ` — ${d.error}` : ''}`);
    }
    if (ev === 'error') console.log(`[e2e] ERROR ${d.message}`);
    if (ev === 'done') { done = d; console.log(`[e2e] done status=${d.status} file=${d.file}`); }
  }
}

console.log(`[e2e] 总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 校验落盘
if (id) {
  const detail = await (await fetch(`http://127.0.0.1:4100/api/assessments/${id}`)).json();
  console.log('[e2e] 落盘校验:');
  console.log('  meta.status =', detail.meta?.status);
  console.log('  meta.submission_file =', detail.meta?.submission_file);
  console.log('  original 字符数 =', (detail.original || '').length);
  console.log('  revised 字符数 =', (detail.revised || '').length);
  console.log('  merged.score =', JSON.stringify(detail.merged?.score));
  console.log('  提交文件存在 =', fs.existsSync(`${SUB_DIR}/${detail.meta?.submission_file}`));
}
