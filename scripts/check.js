import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { PATHS } from '../lib/paths.js';
import { writingSubmissionSchema } from '../lib/contract.js';

// 校验 ~/.ielts/writing/submissions 下所有文件能否被老看板读出。
// 任一条不通过，老看板的 scanner 会「静默跳过」，用户会以为记录丢了。

const dir = PATHS.writing.submissions;
if (!fs.existsSync(dir)) {
  console.log(`目录不存在：${dir}`);
  process.exit(0);
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
let bad = 0;

for (const f of files) {
  const full = path.join(dir, f);
  try {
    const fm = matter.read(full).data;
    const r = writingSubmissionSchema.safeParse(fm);
    if (!r.success) {
      bad += 1;
      console.log(`✗ ${f}`);
      for (const i of r.error.issues) console.log(`    ${i.path.join('.')}: ${i.message}`);
    }
  } catch (e) {
    bad += 1;
    console.log(`✗ ${f} — 解析失败：${e.message}`);
  }
}

console.log(`\n共 ${files.length} 个文件，${bad} 个不合法。`);
process.exit(bad === 0 ? 0 : 1);
