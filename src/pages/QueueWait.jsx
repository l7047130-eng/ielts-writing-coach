import { useEffect, useRef, useState } from 'react';

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function CopyButton({ text, label = '复制', className = '' }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className={`rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50 ${className}`}
    >
      {done ? '已复制' : label}
    </button>
  );
}

export default function QueueWait({ queue, onCancel, onLeave, onRecheck, onPaste, busy }) {
  const [now, setNow] = useState(Date.now());
  const [reply, setReply] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (queue.status === 'failed') setShowPaste(true);
  }, [queue.status]);

  const elapsed = now - (queue.startedAt || now);
  const failed = queue.status === 'failed';
  const isReview = queue.kind === 'review';
  const writing = !failed && queue.note;
  const trigger = queue.trigger || '跑一下写作批改队列：读 ~/.ielts/writing/queue/pending/ 下的每个 json，按文件里 instruction 字段的要求完成批改，结果写到该文件 output_path 指定的位置。';

  return (
    <div className="h-full overflow-y-auto scroll-thin">
      <div className="max-w-2xl mx-auto px-6 py-8">
        <div className="flex items-center gap-3">
          <span className={`h-2.5 w-2.5 rounded-full ${failed ? 'bg-rose-500' : 'bg-sky-500 animate-pulse'}`} />
          <h1 className="text-base font-medium">
            {failed ? '这次没有批成' : isReview ? '已加入复核队列' : '已加入批改队列'}
          </h1>
          <span className="text-xs text-slate-400 tabular-nums">{fmtDuration(elapsed)}</span>
          <div className="flex-1" />
          {!failed && (
            <button
              type="button"
              onClick={onLeave}
              className="text-xs text-slate-400 hover:text-slate-700"
              title="任务留在磁盘上，稍后从左侧「等待中的任务」点回来"
            >
              稍后再弄
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (window.confirm('取消会删掉这个任务文件，正文不再保留。确定？')) onCancel();
            }}
            className="text-xs text-slate-400 hover:text-rose-600"
          >
            取消任务
          </button>
        </div>

        <p className="mt-2 text-sm text-slate-500 leading-relaxed">
          {failed
            ? (queue.error || '结果校验没通过')
            : isReview
              ? '复核任务已经写成文件。去开一个新对话跑它——同一段对话里模型会看见自己上一次的结论，那就不算独立评分了。'
              : '任务已经写成本地文件，下一步去 WorkBuddy 里跑一次。处理完这里会自动跳转，不用手动刷新。'}
        </p>

        {!failed && writing && (
          <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            {queue.note} —— 还在读，继续等就行。
          </div>
        )}

        {failed && (
          <div className="mt-4 rounded-lg bg-rose-50 border border-rose-200 px-3.5 py-3">
            <div className="text-xs font-medium text-rose-800 mb-1">具体原因</div>
            {queue.warnings?.length ? (
              <ul className="space-y-1">
                {queue.warnings.map((w, i) => (
                  <li key={i} className="text-[12px] text-rose-700 leading-relaxed">· {w}</li>
                ))}
              </ul>
            ) : (
              <div className="text-[12px] text-rose-700 leading-relaxed">服务端没有给出更细的原因。</div>
            )}
            <div className="text-[11px] text-rose-600/80 mt-2 leading-relaxed">
              这些结果不会被写进看板。换一份合格的回复，或者修好 done 文件后点「重新检查」。
            </div>
          </div>
        )}

        {failed && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onRecheck}
              className="rounded-lg bg-slate-900 text-white text-xs px-3.5 py-2 hover:bg-slate-800"
            >
              重新检查结果
            </button>
            <button
              type="button"
              onClick={() => setShowPaste(true)}
              className="rounded-lg border border-slate-200 text-xs px-3.5 py-2 text-slate-600 hover:bg-slate-50"
            >
              换一份回复再试
            </button>
            <button
              type="button"
              onClick={onLeave}
              className="rounded-lg border border-slate-200 text-xs px-3.5 py-2 text-slate-600 hover:bg-slate-50"
            >
              返回编辑（保留任务）
            </button>
          </div>
        )}

        {!failed && (
          <>
            <div className="card mt-5">
              <div className="text-xs font-medium text-slate-500 mb-2">任务文件</div>
              <div className="font-mono text-[12px] text-slate-600 break-all bg-slate-50 rounded-md px-3 py-2">
                ~/.ielts/writing/queue/pending/{queue.id}.json
              </div>
              <div className="text-[11px] text-slate-400 mt-2">
                评分规则和作文都在这个文件里，共 {queue.chars || 0} 字符。AI 不需要额外指令。
                {isReview ? ' 复核任务只要求四个分数，不带点评。' : ''}
              </div>
            </div>

            <div className="card mt-4">
              <div className="text-xs font-medium text-slate-500 mb-2">在 WorkBuddy 里说这一句</div>
              <div className="flex items-start gap-2">
                <div className="flex-1 text-[13px] leading-relaxed text-slate-700 bg-slate-50 rounded-md px-3 py-2">
                  {trigger}
                </div>
                <CopyButton text={trigger} label="复制" className="mt-1 shrink-0" />
              </div>
              <div className="text-[11px] text-slate-400 mt-2">
                装了 writing-coach-grader Skill 的话，直接敲 <code className="text-slate-500">/grade</code> 也行。
              </div>
            </div>
          </>
        )}

        {(!failed || showPaste) && (
          <div className="mt-4 rounded-lg border border-slate-200 overflow-hidden">
            {!failed && (
              <button
                type="button"
                onClick={() => setShowPaste((v) => !v)}
                className="w-full text-left px-4 py-2.5 text-xs text-slate-500 hover:bg-slate-50 flex items-center"
              >
                <span>{showPaste ? '收起' : '已经拿到回复了？直接粘进来'}</span>
                <span className="flex-1" />
                <span className="text-slate-300">{showPaste ? '−' : '+'}</span>
              </button>
            )}
            {showPaste && (
              <div className="px-4 pb-3 space-y-2 pt-2">
                <textarea
                  ref={boxRef}
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  rows={7}
                  placeholder={isReview
                    ? '粘贴复核结果：{ "passB": { "tr": 6.5, "cc": 6, "lr": 6, "ga": 6 } }，也可以直接是四个分数。'
                    : '把 AI 回复的 JSON 整段粘在这里。四个分数但没有点评的，会被当成复核结果拒收。'}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-[12.5px] font-mono leading-relaxed outline-none focus:border-slate-400 resize-y"
                />
                <div className="flex items-center gap-2">
                  <div className="text-[11px] text-slate-400 flex-1">
                    成功后会直接跳到结果页；不合规会立刻告诉你是哪一条不合格。
                  </div>
                  <button
                    type="button"
                    onClick={() => onPaste(reply)}
                    disabled={busy || !reply.trim()}
                    className="rounded-lg bg-slate-900 text-white text-xs px-3 py-1.5 disabled:opacity-40 hover:bg-slate-800"
                  >
                    {busy ? '解析中…' : '解析这份回复'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
