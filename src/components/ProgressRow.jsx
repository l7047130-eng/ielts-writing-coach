const LABEL = {
  pass1: '第一次评分（严格考官）',
  pass2: '第二次评分（descriptor 打勾）',
  revision: '生成改写稿',
};

const STATUS_STYLE = {
  running: { dot: 'bg-sky-500 animate-pulse', text: 'text-slate-600', tail: '进行中' },
  retrying: { dot: 'bg-amber-500 animate-pulse', text: 'text-amber-700', tail: '重试中' },
  ok: { dot: 'bg-emerald-500', text: 'text-emerald-700', tail: '完成' },
  fail: { dot: 'bg-rose-500', text: 'text-rose-700', tail: '失败' },
  idle: { dot: 'bg-slate-300', text: 'text-slate-400', tail: '等待' },
};

export default function ProgressRow({ id, task }) {
  const status = task?.status || 'idle';
  const style = STATUS_STYLE[status] || STATUS_STYLE.idle;

  return (
    <div className="py-2.5">
      <div className={`flex items-center gap-3 ${style.text}`}>
        <span className={`h-2 w-2 rounded-full shrink-0 ${style.dot}`} />
        <span className="text-sm flex-1">{LABEL[id] || id}</span>
        <span className="text-xs tabular-nums text-slate-400">
          {status === 'ok' && task?.ms ? `${(task.ms / 1000).toFixed(1)}s` : ''}
          {status === 'ok' && task?.score != null ? ` · ${task.score}` : ''}
          {status === 'ok' ? '' : style.tail}
        </span>
      </div>
      {status === 'fail' && task?.message ? (
        <div className="ml-5 mt-1 text-[11.5px] leading-relaxed text-rose-600 break-words">
          {task.message}
        </div>
      ) : null}
    </div>
  );
}
