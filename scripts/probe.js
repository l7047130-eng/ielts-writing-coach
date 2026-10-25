import { publicSettings, missingFields } from '../lib/settings.js';
import { testConnection } from '../lib/llm.js';

// 命令行版的「测试连接」。界面上也有同样的按钮，这个用于排查。

const cfg = publicSettings();
const missing = missingFields();

console.log('=== 当前配置（config.local.json）===');
console.log('接口地址:', cfg.base || '(未填)');
console.log('模型    :', cfg.model || '(未填)');
console.log('API Key :', cfg.hasKey ? cfg.keyPreview : '(未填)');

if (missing.length) {
  console.log(`\n还缺 ${missing.join(' / ')}。`);
  console.log('打开界面点右上角齿轮填写，或者直接改 config.local.json。');
  process.exit(1);
}

console.log('\n=== 探测 ===');
const t0 = Date.now();
const r = await testConnection();
console.log(`耗时 ${Date.now() - t0}ms`);
console.log('文本对话:', r.text ? '✓' : '✗');
console.log('视觉通路:', r.vision ? '✓' : '✗（Task 1 会失败，换多模态模型）');
if (r.error) console.log('错误:', r.error);
process.exit(r.text && r.vision ? 0 : 2);
