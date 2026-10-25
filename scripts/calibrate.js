import fs from 'node:fs';
import { gradePass } from '../lib/grading.js';

// 校准校验：取一篇已知 4.5 分的弱作文，只跑 Pass A，看是否落在 4.0-5.5。
// 原文从 20261011_task2_science.md 的「逐段标注」里用引用行还原。

const FILE = 'C:/Users/cy/.ielts/writing/submissions/20261011_task2_science.md';
const raw = fs.readFileSync(FILE, 'utf8');
const lines = raw.split('\n');

let inSec = false;
const paras = [];
for (const ln of lines) {
  if (/^##\s/.test(ln)) {
    inSec = ln.includes('逐段标注');
    continue;
  }
  if (!inSec) continue;
  if (ln.startsWith('> ')) paras.push(ln.slice(2).trim());
}

const essay = paras.join('\n\n');
const words = essay.split(/\s+/).filter(Boolean).length;

const prompt = 'Some people think that the aim of science should be to improve people\'s lives. To what extent do you agree or disagree?';

console.log(`[cal] 还原段落 ${paras.length} 段 / ${words} 词`);
console.log(`[cal] 原文开头: ${essay.slice(0, 120).replace(/\n/g, ' ')}…`);
console.log(`[cal] 仪表板记录分: 4.5 (TR 5 / CC 4.5 / LR 4.5 / GA 4)`);
console.log('[cal] 跑 Pass A ...');

const t0 = Date.now();
try {
  const r = await gradePass({
    pass: 'A',
    task: 2,
    prompt,
    essay,
    wordCount: words,
    images: [],
    onPhase: (p) => console.log(`[cal] 阶段 ${p.type}`),
  });
  const d = r.data;
  console.log(`\n[cal] 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`[cal] Pass A → TR ${d.tr} / CC ${d.cc} / LR ${d.lr} / GA ${d.ga}  overall ${r.overall}`);
  console.log(`[cal] 参考区间 4.0-5.5 → ${r.overall >= 4 && r.overall <= 5.5 ? '✓ 落在区间内' : '✗ 偏离'}`);
  console.log(`[cal] 错误 ${d.errors.length} 类: ${d.errors.slice(0, 8).map((e) => `${e.tag}×${e.count}`).join(', ')}`);
  console.log(`[cal] LR 评论: ${(d.dims?.lr?.comment || '').slice(0, 160)}`);
  console.log(`[cal] GA 评论: ${(d.dims?.ga?.comment || '').slice(0, 160)}`);
} catch (e) {
  console.log(`[cal] 失败: ${e.message}`);
}
