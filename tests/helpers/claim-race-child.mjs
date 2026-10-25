/**
 * 占位交接竞态的子进程。
 *
 * 用法：
 *   node claim-race-child.mjs <mode:A|B> <alloc:reserveId|reserveNamedId> <home> <barrier> <topic> <tag>
 *
 * mode=B：在**第一次** claims/'wx' 打开之前停住（此时 isIdTaken 已经跑过、返回未占用），
 *         等父进程放行。这正好复现「B 检查完 → A 落盘并释放占位 → B 占位成功」的交接窗口。
 * 随后执行完整落盘流程：分配 ID → 入队 → 写图片与正式记录 → 撤占位。
 */
import fs from 'node:fs';
import path from 'node:path';

const [mode, alloc, home, barrier, topic, tag] = process.argv.slice(2);

process.env.IELTS_HOME = home;
process.env.WRITING_COACH_CONFIG = path.join(home, 'config.json');

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFile = (f) => { while (!fs.existsSync(f)) sleepSync(15); };
const touch = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '1'); };

if (mode === 'B') {
  const realOpen = fs.openSync.bind(fs);
  let paused = false;
  fs.openSync = (file, flags, ...rest) => {
    const isClaim = String(file).includes('claims') && String(flags) === 'wx';
    if (isClaim && !paused) {
      paused = true;
      // 已经跑过 isIdTaken 且判定未占用，正要抢占位 —— 停在这里
      touch(path.join(barrier, 'b-ready'));
      waitFile(path.join(barrier, 'b-go'));
    }
    return realOpen(file, flags, ...rest);
  };
}

const ids = await import('../../lib/ids.js');
const queue = await import('../../lib/queue.js');
const store = await import('../../lib/store.js');
const persist = await import('../../lib/persist.js');

const id = alloc === 'reserveNamedId'
  ? ids.reserveNamedId(`review-${topic}`, { assessment_id: topic })
  : ids.reserveId(2, topic);

const essay = `Essay body written by ${tag}. ${tag} keeps its own text and image.`;

queue.enqueue({
  id,
  kind: 'full',
  created_at: new Date().toISOString(),
  task: 2,
  topic,
  essay,
  word_count: 9,
});

// 1x1 红色 PNG，走正规附件通道
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const attachment = queue.saveAttachment(id, TINY_PNG);

const score = { tr: 6, cc: 6, lr: 6, ga: 6, overall: 6 };
const merged = {
  score,
  raw: score,
  pass_overall: [6],
  spread: null,
  boundary: false,
  errors: [],
  dims: {},
  strengths: [`${tag} 的优点`],
  weaknesses: [],
  next_actions: [],
};

persist.persistAssessment({
  id,
  task: 2,
  topic,
  prompt: 'prompt',
  essay,
  imagePath: attachment,
  wordCount: 9,
  merged,
  passes: { a: { data: merged, overall: 6 } },
  source: 'queue',
  createdAt: new Date().toISOString(),
});

ids.settleClaim(id);

process.stdout.write(`${JSON.stringify({
  id,
  tag,
  essay,
  attachment: attachment ? path.basename(attachment) : null,
  claimFile: fs.existsSync(path.join(home, 'writing', 'queue', 'claims', `${id}.json`)),
})}\n`);
