import { writeSubmission, listAssessments } from '../lib/store.js';
import { overallOf, toHalf } from '../lib/contract.js';

// 冒烟测试：写一条假记录，验证契约落盘能通过。
const score = { tr: 6, cc: 6.5, lr: 6, ga: 5.5 };
score.overall = overallOf(score);

const written = writeSubmission(
  {
    date: new Date().toISOString().slice(0, 10),
    task: 2,
    topic: 'smoke-test',
    score: {
      tr: toHalf(score.tr),
      cc: toHalf(score.cc),
      lr: toHalf(score.lr),
      ga: toHalf(score.ga),
      overall: toHalf(score.overall),
    },
    errors: [
      { type: 'grammar', tag: 'article_misuse', count: 3 },
      { type: 'lexical', tag: 'basic_vocabulary', count: 2 },
    ],
    word_count: 268,
    duration_min: 38,
    essay: 'This file is written by scripts/smoke.js to verify the contract. It should be deleted afterwards.\n\nSecond paragraph here.',
  },
  'smoketest'
);

console.log('已写入:', written.file);
console.log('assessment 目录数:', listAssessments().length);
console.log('分数:', JSON.stringify({ ...score, overall: score.overall }));
