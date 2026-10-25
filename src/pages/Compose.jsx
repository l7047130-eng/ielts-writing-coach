import { useEffect, useMemo, useState } from 'react';
import ImageDrop from '../components/ImageDrop.jsx';

const DRAFT_KEY = 'writing-coach-draft';

export default function Compose({ onSubmit, gradingMode = 'queue' }) {
  const [task, setTask] = useState(2);
  const [topic, setTopic] = useState('');
  const [prompt, setPrompt] = useState('');
  const [essay, setEssay] = useState('');
  const [image, setImage] = useState(null);
  const [duration, setDuration] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 恢复草稿
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.task === 1 || d.task === 2) setTask(d.task);
      if (typeof d.topic === 'string') setTopic(d.topic);
      if (typeof d.prompt === 'string') setPrompt(d.prompt);
      if (typeof d.essay === 'string') setEssay(d.essay);
      if (typeof d.duration === 'string') setDuration(d.duration);
      if (d.image) setImage(d.image);
    } catch { /* ignore */ }
  }, []);

  // 存草稿。图片太大就不进 localStorage，免得超配额。
  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        task,
        topic,
        prompt,
        essay,
        duration,
        image: image && image.length < 900000 ? image : null,
      }));
    } catch { /* ignore */ }
  }, [task, topic, prompt, essay, duration, image]);

  const wordCount = useMemo(
    () => essay.trim().split(/\s+/).filter(Boolean).length,
    [essay]
  );
  const minWords = task === 1 ? 150 : 250;
  const short = wordCount > 0 && wordCount < minWords;
  // API 模式下 Task 1 必须有图（模型要直接读）；队列模式下图可选，AI 从文件读
  const missing = gradingMode === 'api' && task === 1 && !image;
  const canSubmit = Boolean(prompt.trim()) && Boolean(essay.trim()) && !missing && !submitting;
  const isQueue = gradingMode === 'queue';

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit({
        task,
        topic: topic.trim() || prompt.trim().slice(0, 30),
        prompt: prompt.trim(),
        essay: essay.trim(),
        imageBase64: image || null,
        duration_min: duration ? Number(duration) : undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <header className="shrink-0 border-b border-slate-200 bg-white px-6 py-3 flex items-center gap-4">
        <div className="flex rounded-lg border border-slate-200 overflow-hidden text-sm">
          {[1, 2].map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTask(t)}
              className={`px-3 py-1.5 transition-colors ${
                task === t ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              Task {t}
            </button>
          ))}
        </div>

        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="话题标签（可选，给看板归档用）"
          className="w-56 rounded-lg border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-slate-400"
        />

        <input
          value={duration}
          onChange={(e) => setDuration(e.target.value.replace(/[^\d]/g, ''))}
          placeholder="用时"
          className="w-20 rounded-lg border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-slate-400 tabular-nums"
        />
        <span className="text-xs text-slate-400">分钟</span>

        <div className="flex-1" />

        <span className={`text-sm tabular-nums ${short ? 'text-amber-600' : 'text-slate-500'}`}>
          {wordCount} 词{short ? `（建议 ≥${minWords}）` : ''}
        </span>

        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="rounded-lg bg-slate-900 text-white text-sm px-4 py-2 disabled:opacity-40 hover:bg-slate-800 transition-colors"
        >
          {submitting
            ? (isQueue ? '写入队列…' : '开始批改…')
            : (isQueue ? '加入批改队列' : '开始批改')}
        </button>
      </header>

      <div className="flex-1 overflow-y-auto scroll-thin">
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-5">
          <section>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">
              题目 {task === 1 ? '（Task 1 请连同图表一起上传）' : ''}
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder={task === 1
                ? '粘贴题目文字，例如：The chart below shows the number of…'
                : '粘贴 Task 2 题目，例如：Some people think… To what extent do you agree?'}
              className="w-full rounded-lg border border-slate-200 px-3.5 py-3 text-sm leading-relaxed outline-none focus:border-slate-400 resize-y"
            />
          </section>

          {task === 1 && (
            <section>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">题目配图</label>
              <ImageDrop value={image} onChange={setImage} />
              {missing ? (
                <div className="text-xs text-rose-600 mt-1.5">
                  API 模式下 Task 1 必须上传题目图，图表数据靠多模态模型直接读。
                </div>
              ) : isQueue ? (
                <div className="text-xs text-slate-400 mt-1.5">
                  队列模式下可选：传了 AI 会从本地文件读图；不传就只能按题目文字评。
                </div>
              ) : null}
            </section>
          )}

          <section>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">作文正文</label>
            <textarea
              value={essay}
              onChange={(e) => setEssay(e.target.value)}
              rows={18}
              placeholder="粘贴或手打作文，段与段之间空一行。"
              className="w-full rounded-lg border border-slate-200 px-3.5 py-3 text-[15px] leading-[1.85] outline-none focus:border-slate-400 resize-y"
            />
          </section>

          <section className="text-xs text-slate-400 leading-relaxed pb-8">
            {isQueue ? (
              <>
                提交后任务会写成 <code className="text-slate-500">~/.ielts/writing/queue/pending/</code> 下的一个文件。
                你在 WorkBuddy 里跑一次批改队列就会出结果，不消耗任何 API token。
                结果照旧写进 <code className="text-slate-500">~/.ielts/writing/submissions/</code>，老看板能直接读到。
              </>
            ) : (
              <>
                会跑两次独立评分做一致性检测，再生成一份同题改写稿。
                结果同时写进 <code className="text-slate-500">~/.ielts/writing/submissions/</code>，
                老看板的写作页能直接读到。
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
