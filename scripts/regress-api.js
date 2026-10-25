import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 回归：临时切到 api 模式，跑一次真实批改，核对 SSE 与落盘形状，然后还原。
const API = 'http://127.0.0.1:4100/api';

const j = async (p, opt = {}) => {
  const r = await fetch(API + p, { headers: { 'Content-Type': 'application/json' }, ...opt });
  const t = await r.text();
  let body;
  try { body = JSON.parse(t); } catch { body = t.slice(0, 300); }
  return { status: r.status, body };
};

const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
const key = cfg.env.ANTHROPIC_AUTH_TOKEN;

console.log('[1] 临时切到 api 模式');
const put = await j('/settings', {
  method: 'PUT',
  body: JSON.stringify({ mode: 'api', base: 'https://api.xiaomimimo.com/v1', key, model: 'mimo-v2.6-pro' }),
});
console.log('   ', put.status, JSON.stringify(put.body));

const essay = 'Some people believe that university education should be free for everyone. Others think students should pay. In my view, free tuition is fairer because it opens access to poor families.\n\nHowever, governments must fund it somehow, usually through higher taxes. That trade-off is real but acceptable if the quality of teaching is protected.';

console.log('[2] POST /api/grade（SSE）');
const t0 = Date.now();
const res = await fetch(`${API}/grade`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ task: 2, topic: 'regress-api', prompt: 'Should university education be free? Discuss.', essay, duration_min: 30 }),
});
if (!res.ok) {
  console.log('   HTTP', res.status, (await res.text()).slice(0, 300));
  process.exit(1);
}

const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
let buf = '';
let id = null;
const events = [];
let merged = null;

for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
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
    if (!data.length) continue;
    let d;
    try { d = JSON.parse(data.join('\n')); } catch { continue; }
    if (ev === 'ping') continue;
    events.push(ev);
    if (ev === 'start') { id = d.id; console.log(`    start id=${id} wordCount=${d.wordCount}`); }
    if (ev === 'task') console.log(`    task ${d.id} → ${d.status}${d.ms ? ` ${(d.ms / 1000).toFixed(1)}s` : ''}${d.score != null ? ` 分 ${d.score}` : ''}${d.message ? ` — ${String(d.message).slice(0, 120)}` : ''}`);
    if (ev === 'merged') {
      merged = d;
      console.log(`    merged overall ${d.score.overall} | 两次 ${d.pass_overall?.join(' / ')} spread=${d.spread} boundary=${d.boundary}`);
    }
    if (ev === 'revision') console.log(`    revision ${d.text ? d.text.split(/\s+/).filter(Boolean).length + ' 词' : '空'}`);
    if (ev === 'error') console.log(`    ERROR ${d.message}`);
    if (ev === 'done') console.log(`    done status=${d.status} file=${d.file}`);
  }
}

console.log(`    总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('    事件序列:', events.join(' → '));

if (id) {
  const detail = await j(`/assessments/${id}`);
  const m = detail.body.meta;
  console.log('\n[3] 落盘 meta');
  console.log('    字段:', Object.keys(m).join(', '));
  console.log('    source:', m.source, '| status:', m.status, '| pass_overall:', m.pass_overall, '| spread:', m.spread);
  console.log('    score:', JSON.stringify(m.score));
  console.log('    submission_file:', m.submission_file);
  const sub = `C:/Users/cy/.ielts/writing/submissions/${m.submission_file}`;
  console.log('    提交文件存在:', fs.existsSync(sub));
  console.log('    revised 字符数:', (detail.body.revised || '').length);
}

console.log('\n[4] 还原成 queue 模式并清掉 key');
const back = await j('/settings', { method: 'PUT', body: JSON.stringify({ mode: 'queue', key: '' }) });
console.log('   ', back.status, JSON.stringify(back.body));

if (id) {
  await j(`/assessments/${id}`, { method: 'DELETE' });
  console.log('[5] 已删除回归测试记录', id);
}
