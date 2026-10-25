import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import matter from 'gray-matter';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-store-'));
process.env.IELTS_HOME = HOME;
process.env.WRITING_COACH_CONFIG = path.join(HOME, 'config.json');

const store = await import('../lib/store.js');
const { persistAssessment } = await import('../lib/persist.js');
const { mergePasses, writingSubmissionSchema } = await import('../lib/contract.js');
const { stamp } = await import('../lib/ids.js');

const SUB = path.join(HOME, 'writing', 'submissions');
const ASM = path.join(HOME, 'writing', 'assessments');

const OLD_ID = '20260101_task2_legacy';
// 旧版本 slugify 保留中文，会生成中文 ID；必须继续可读、可展示、可复核
const OLD_CN_ID = '20261023_task2_公共图书馆';

function seedLegacy() {
  fs.mkdirSync(SUB, { recursive: true });
  fs.writeFileSync(path.join(SUB, `${OLD_ID}.md`), `---\ndate: 2026-01-01\ntask: 2\ntopic: legacy\nscore:\n  tr: 6\n  cc: 6\n  lr: 6\n  ga: 6\n  overall: 6\nerrors: []\n---\n\nold essay body`);
  fs.mkdirSync(path.join(ASM, OLD_ID), { recursive: true });
  fs.writeFileSync(path.join(ASM, OLD_ID, 'meta.json'), JSON.stringify({
    id: OLD_ID, created_at: '2026-01-01T00:00:00.000Z', date: '2026-01-01', task: 2,
    topic: 'legacy', status: 'COMPLETED', score: { tr: 6, cc: 6, lr: 6, ga: 6, overall: 6 },
  }));
  fs.writeFileSync(path.join(ASM, OLD_ID, 'original.md'), 'old essay body');
  fs.writeFileSync(path.join(ASM, OLD_ID, 'merged.json'), JSON.stringify({
    score: { tr: 6, cc: 6, lr: 6, ga: 6, overall: 6 },
    dims: { tr: { comment: '老记录', evidence: [], fix_example: '' } },
  }));

  // 中文 ID 的旧记录
  fs.writeFileSync(path.join(SUB, `${OLD_CN_ID}.md`), `---\ndate: 2026-10-23\ntask: 2\ntopic: 公共图书馆\nscore:\n  tr: 6.5\n  cc: 6\n  lr: 6\n  ga: 6\n  overall: 6\nerrors: []\n---\n\n中文话题的旧作文`);
  fs.mkdirSync(path.join(ASM, OLD_CN_ID), { recursive: true });
  fs.writeFileSync(path.join(ASM, OLD_CN_ID, 'meta.json'), JSON.stringify({
    id: OLD_CN_ID, created_at: '2026-10-23T00:00:00.000Z', date: '2026-10-23', task: 2,
    topic: '公共图书馆', status: 'COMPLETED', source: 'queue',
    score: { tr: 6.5, cc: 6, lr: 6, ga: 6, overall: 6 },
    pass_overall: [6],
  }));
  fs.writeFileSync(path.join(ASM, OLD_CN_ID, 'original.md'), '中文话题的旧作文');
  fs.writeFileSync(path.join(ASM, OLD_CN_ID, 'merged.json'), JSON.stringify({
    score: { tr: 6.5, cc: 6, lr: 6, ga: 6, overall: 6 },
    pass_overall: [6], spread: null, boundary: false, errors: [],
    dims: { tr: { comment: '中文旧记录的点评', evidence: [], fix_example: '' } },
  }));
  fs.writeFileSync(path.join(ASM, OLD_CN_ID, 'passes.json'), JSON.stringify({
    a: { data: { tr: 6.5, cc: 6, lr: 6, ga: 6 }, overall: 6 },
  }));
}

seedLegacy();

test('已有记录照旧能读，ID 不需要迁移', () => {
  const list = store.listAssessments();
  const legacy = list.find((x) => x.id === OLD_ID);
  assert.ok(legacy, '老记录应该出现在列表里');
  const detail = store.getAssessment(OLD_ID);
  assert.equal(detail.original, 'old essay body');
  assert.equal(detail.merged.score.overall, 6);
});

test('旧中文 ID 记录可读、可展示、可复核（不需要迁移）', () => {
  const list = store.listAssessments();
  const cn = list.find((x) => x.id === OLD_CN_ID);
  assert.ok(cn, `中文 ID 记录被列表过滤掉了：${list.map((x) => x.id).join(', ')}`);
  assert.equal(cn.topic, '公共图书馆');

  const detail = store.getAssessment(OLD_CN_ID);
  assert.ok(detail, 'getAssessment 不该对中文 ID 返回 null');
  assert.equal(detail.original, '中文话题的旧作文');
  assert.equal(detail.meta.topic, '公共图书馆');
  assert.ok(detail.passes?.a?.data, '复核需要的原始评分还在');

  // 新分配不会撞到旧中文记录
  const fresh = store.reserveId(2, '公共图书馆');
  assert.notEqual(fresh, OLD_CN_ID);
  assert.match(fresh, /公共图书馆/);
  store.releaseClaim(fresh);
});

test('中文/中英混合话题都能生成 ID，且连续提交不撞号', async () => {
  const { isSafeId } = await import('../lib/ids.js');
  const cases = ['公共图书馆', '雅思 Task2 写作', '大学教育 should be free'];
  for (const topic of cases) {
    const a = store.reserveId(2, topic);
    const b = store.reserveId(2, topic);
    assert.ok(isSafeId(a), `${topic} 生成的 ID 不合法：${a}`);
    assert.notEqual(a, b, `${topic} 连续两次拿到同一个 ID`);
    store.releaseClaim(a);
    store.releaseClaim(b);
  }
});

test('写新记录不会碰老记录，ID 与老 ID 不冲突', () => {
  const { compact } = stamp();
  const id = store.reserveId(2, 'legacy');
  assert.notEqual(id, OLD_ID);
  assert.match(id, new RegExp(`^${compact}_task2_legacy`));
  assert.equal(fs.readFileSync(path.join(SUB, `${OLD_ID}.md`), 'utf8').includes('old essay body'), true);
});

test('persistAssessment 落盘的文件仍然满足老看板的 schema', () => {
  const id = store.reserveId(2, 'schema-check');
  const a = { tr: 6, cc: 6.5, lr: 6, ga: 5.5, dims: {}, errors: [], strengths: [], weaknesses: [], next_actions: [] };
  const b = { tr: 6.5, cc: 6.5, lr: 6.5, ga: 6, dims: {}, errors: [], strengths: [], weaknesses: [], next_actions: [] };
  const merged = mergePasses(a, b);

  const out = persistAssessment({
    id,
    task: 2,
    topic: 'schema-check',
    prompt: 'p',
    essay: 'body of the essay',
    wordCount: 4,
    durationMin: 40,
    merged: { ...merged, errors: [], dims: {}, strengths: [], weaknesses: [], next_actions: [] },
    passes: { a: { data: a, overall: 6 }, b: { data: b, overall: 6.5 } },
    revision: 'revised body of the essay',
    source: 'queue',
  });

  const fm = matter.read(path.join(SUB, out.file)).data;
  const r = writingSubmissionSchema.safeParse(fm);
  assert.equal(r.success, true, `落盘 frontmatter 不合法：${JSON.stringify(r.error?.issues)}`);
  // 均值 6.25/6.5/6.25/5.75 → 6.1875，只 round 一次 → 6.0
  assert.equal(fm.score.overall, 6);
  assert.equal(fm.task, 2);
  assert.equal(fm.duration_min, 40);

  const detail = store.getAssessment(id);
  assert.equal(detail.original, 'body of the essay');
  assert.equal(detail.revised, 'revised body of the essay');
  assert.equal(detail.meta.status, 'COMPLETED');
});

test('persistAssessment 的 date 可以沿用（复核不把老记录挪到今天）', () => {
  const id = store.reserveId(2, 'keep-date');
  const merged = mergePasses(
    { tr: 6, cc: 6, lr: 6, ga: 6 },
    { tr: 6, cc: 6, lr: 6, ga: 6 },
  );
  const clean = { ...merged, errors: [], dims: {}, strengths: [], weaknesses: [], next_actions: [] };
  const out = persistAssessment({
    id, task: 2, topic: 'keep-date', prompt: 'p', essay: 'x', wordCount: 1,
    merged: clean, passes: { a: { data: clean }, b: { data: clean } },
    date: '2026-01-05',
  });
  const fm = matter.read(path.join(SUB, out.file)).data;
  assert.equal(fm.date, '2026-01-05');
});

test('deleteAssessment 连带删契约文件，且拒绝非法 id', () => {
  const id = store.reserveId(2, 'delete-me');
  const merged = mergePasses({ tr: 6, cc: 6, lr: 6, ga: 6 }, { tr: 6, cc: 6, lr: 6, ga: 6 });
  persistAssessment({
    id, task: 2, topic: 'delete-me', prompt: 'p', essay: 'x', wordCount: 1,
    merged: { ...merged, errors: [], dims: {}, strengths: [], weaknesses: [], next_actions: [] },
    passes: { a: { data: merged }, b: { data: merged } },
  });
  assert.ok(fs.existsSync(path.join(SUB, `${id}.md`)));

  assert.equal(store.deleteAssessment('..\\..\\evil'), false, '非法 id 直接短路');
  assert.equal(fs.existsSync(path.join(HOME, 'evil')), false);
  store.deleteAssessment(id);
  assert.equal(fs.existsSync(path.join(SUB, `${id}.md`)), false);
  assert.equal(fs.existsSync(path.join(ASM, id)), false);
  assert.equal(store.getAssessment(id), null);
});

test('列表会跳过不合规的目录名，不会整体挂掉', () => {
  fs.mkdirSync(path.join(ASM, 'bad..name'), { recursive: true });
  const list = store.listAssessments();
  assert.ok(Array.isArray(list));
  assert.equal(list.some((x) => x.id === 'bad..name'), false);
});

test('图片复制三重校验：来源目录、目标目录、图片类型', async () => {
  const { QPATHS, IMAGE_EXTS } = await import('../lib/paths.js');
  const id = store.reserveId(2, 'image-guard');
  const outside = path.join(HOME, 'private-sentinel.txt');
  fs.writeFileSync(outside, 'SECRET');

  // 1) 来源不在允许目录 → 拒
  assert.throws(
    () => store.saveImageFromFile(id, outside, { allowRoots: [QPATHS.attachments] }),
    /来源目录不合法/,
  );
  // 2) 不给来源白名单 → 拒（防止以后忘传）
  assert.throws(() => store.saveImageFromFile(id, outside), /来源目录未指定/);

  // 3) 允许目录里的非图片类型 → 拒
  fs.mkdirSync(QPATHS.attachments, { recursive: true });
  const notImage = path.join(QPATHS.attachments, `${id}.txt`);
  fs.writeFileSync(notImage, 'not an image');
  assert.throws(
    () => store.saveImageFromFile(id, notImage, { allowRoots: [QPATHS.attachments] }),
    /图片类型不支持/,
  );

  // 4) 合法图片 → 允许复制
  const okSrc = path.join(QPATHS.attachments, `${id}.png`);
  fs.writeFileSync(okSrc, Buffer.from('89504e470d0a1a0a', 'hex'));
  const name = store.saveImageFromFile(id, okSrc, { allowRoots: [QPATHS.attachments] });
  assert.equal(name, 'image.png');
  assert.ok(fs.existsSync(path.join(ASM, id, 'image.png')));

  // 5) base64 也只认图片 mime
  assert.throws(() => store.saveImage(id, 'data:text/plain;base64,aGVsbG8='), /图片类型不支持/);

  // 哨兵没被动过，也没进数据目录
  assert.equal(fs.readFileSync(outside, 'utf8'), 'SECRET');
  assert.equal(fs.readdirSync(path.join(ASM, id)).some((f) => f.includes('sentinel')), false);
  assert.ok(IMAGE_EXTS.includes('.png'));
  store.releaseClaim(id);
});
