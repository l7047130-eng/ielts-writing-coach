import { useEffect, useState } from 'react';
import { fetchJSON, sendJSON } from '../api.js';

const PRESETS = [
  { label: 'MiMo', base: 'https://api.xiaomimimo.com/v1' },
  { label: 'DeepSeek', base: 'https://api.deepseek.com/v1' },
  { label: 'Moonshot', base: 'https://api.moonshot.cn/v1' },
  { label: '火山方舟', base: 'https://ark.cn-beijing.volces.com/api/v3' },
];

export default function SettingsDialog({ open, onClose, onSaved, canClose }) {
  const [mode, setMode] = useState('queue');
  const [base, setBase] = useState('');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [keyPreview, setKeyPreview] = useState('');
  const [models, setModels] = useState([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setTest(null);
    fetchJSON('/settings')
      .then((s) => {
        setMode(s.mode || 'queue');
        setBase(s.base || '');
        setModel(s.model || '');
        setKeyPreview(s.keyPreview || '');
        setKey('');
      })
      .catch((e) => setError(e.message));
  }, [open]);

  if (!open) return null;

  const pullModels = async () => {
    setLoadingModels(true);
    setError(null);
    try {
      const r = await sendJSON('/settings/models', 'POST', { base, key });
      setModels(r.models || []);
      if ((r.models || []).length === 0) setError('接口返回了空列表，可能是这个端点不支持 /models');
    } catch (e) {
      setError(`拉模型失败：${e.message}`);
    } finally {
      setLoadingModels(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setError(null);
    setTest(null);
    try {
      setTest(await sendJSON('/settings/test', 'POST', { base, key, model }));
    } catch (e) {
      setError(e.message);
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (mode === 'api' && (!base.trim() || !model.trim())) {
      setError('API 模式下接口地址和模型名必填');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const s = await sendJSON('/settings', 'PUT', { mode, base, key, model });
      onSaved?.(s);
      onClose?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 px-4">
      <div className="w-full max-w-[560px] rounded-xl bg-white shadow-xl border border-slate-200">
        <div className="flex items-center px-5 py-4 border-b border-slate-100">
          <div>
            <h2 className="text-sm font-medium">模型设置</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              任何 OpenAI 兼容接口。模型必须支持图片，Task 1 靠它读图表。
            </p>
          </div>
          <div className="flex-1" />
          {canClose && (
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 text-lg leading-none px-2"
            >
              ×
            </button>
          )}
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs">
            {[['queue', '文件队列（不花 token）'], ['api', '自己的 API']].map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setMode(k)}
                className={`flex-1 py-2 transition-colors ${
                  mode === k ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === 'queue' ? (
            <div className="rounded-lg bg-slate-50 border border-slate-100 px-3.5 py-3 text-xs text-slate-600 leading-relaxed">
              作文提交后写成 <code className="text-slate-700">~/.ielts/writing/queue/pending/</code> 下的任务文件，
              你在 WorkBuddy 里跑一次批改队列就出结果。
              <span className="block mt-1.5 text-slate-400">
                不消耗任何 API token，下面的接口配置用不到。想换回直连再切上面那个。
              </span>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">接口地址</label>
            <input
              value={base}
              onChange={(e) => setBase(e.target.value)}
              placeholder="https://api.deepseek.com/v1"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400 font-mono"
            />
            <div className="flex flex-wrap gap-1.5 mt-2">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setBase(p.base)}
                  className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                    base === p.base
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 text-slate-500 hover:border-slate-400'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">API Key</label>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={keyPreview ? `已保存 ${keyPreview}，留空则不修改` : 'sk-...'}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400 font-mono"
            />
            <p className="text-[11px] text-slate-400 mt-1">
              存在项目目录的 config.local.json，已加入 .gitignore，不会进版本库。
            </p>
          </div>

          <div>
            <div className="flex items-center mb-1.5">
              <label className="text-xs font-medium text-slate-500">模型名</label>
              <div className="flex-1" />
              <button
                type="button"
                onClick={pullModels}
                disabled={loadingModels}
                className="text-[11px] text-slate-500 hover:text-slate-800 disabled:opacity-40"
              >
                {loadingModels ? '拉取中…' : '从接口拉取列表'}
              </button>
            </div>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="例如 mimo-v2.6-pro"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400 font-mono"
            />
            {models.length > 0 && (
              <div className="mt-2 max-h-28 overflow-y-auto scroll-thin rounded-lg border border-slate-100 p-1.5 flex flex-wrap gap-1.5">
                {models.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setModel(m)}
                    className={`rounded-md px-2 py-1 text-[11px] font-mono transition-colors ${
                      model === m ? 'bg-slate-900 text-white' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>
            </>
          )}

          {test && (
            <div className="rounded-lg border border-slate-200 px-3 py-2.5 text-xs space-y-1.5">
              <div className="text-[11px] text-slate-400">
                请求通 / 能力验证通 是两件事，分别看。
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className={test.textRequest ? 'text-slate-600' : 'text-rose-600'}>
                  {test.textRequest ? '✓' : '✗'} 文本接口可达
                </span>
                <span className={test.text ? 'text-emerald-600' : 'text-amber-600'}>
                  {test.text ? '✓' : '✗'} 文本能力已验证
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className={test.visionRequest ? 'text-slate-600' : 'text-rose-600'}>
                  {test.visionRequest ? '✓' : '✗'} 接受图片
                </span>
                <span className={test.vision ? 'text-emerald-600' : 'text-amber-600'}>
                  {test.vision ? '✓' : '✗'} 读图能力已验证
                </span>
              </div>
              {test.textSample ? (
                <div className="text-[11px] text-slate-400">文本回答：{test.textSample}</div>
              ) : null}
              {test.visionSample ? (
                <div className="text-[11px] text-slate-400">读图回答：{test.visionSample}</div>
              ) : null}
              {test.error && <div className="text-rose-600 break-words">{test.error}</div>}
              {!test.vision && test.visionRequest && (
                <div className="text-amber-700 leading-relaxed">
                  接口收得下图片，但没读出内容。Task 2 能用，Task 1 会失准。
                </div>
              )}
              {!test.visionRequest && !test.error && (
                <div className="text-amber-700 leading-relaxed">
                  这个模型多半吃不了图片。Task 2 能用，Task 1 会失败，换一个多模态模型。
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700 break-words">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-slate-100 flex items-center gap-2">
          <button
            type="button"
            onClick={runTest}
            disabled={testing || !base.trim() || !model.trim()}
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            {testing ? '测试中…' : '测试连接'}
          </button>
          <div className="flex-1" />
          {canClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-2 text-xs text-slate-500 hover:bg-slate-50"
            >
              取消
            </button>
          )}
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-slate-900 text-white px-4 py-2 text-xs disabled:opacity-40 hover:bg-slate-800"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
