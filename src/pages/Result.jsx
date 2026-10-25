import { useEffect, useRef, useState } from 'react';
import {
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer,
} from 'recharts';
import ProgressRow from '../components/ProgressRow.jsx';
import DiffStack from '../components/DiffStack.jsx';
import { DIM_META, ERROR_TAGS, ERROR_TYPES } from '../labels.js';

const TASKS = ['pass1', 'pass2', 'revision'];

function bandColor(v) {
  if (v >= 7) return 'text-emerald-600';
  if (v >= 6) return 'text-sky-600';
  if (v >= 5) return 'text-amber-600';
  return 'text-rose-600';
}

// ---------------------------------------------------------------------------
// 顶部信息条
// ---------------------------------------------------------------------------
function Header({ view }) {
  const meta = view.meta || {};
  const merged = view.merged;
  return (
    <header className="shrink-0 border-b border-slate-200 bg-white px-6 py-3 flex items-center gap-4">
      <span className="rounded-md bg-slate-900 text-white text-xs px-2 py-1">Task {meta.task}</span>
      <span className="text-sm text-slate-700 truncate max-w-[320px]" title={meta.topic}>
        {meta.topic || '未命名'}
      </span>
      {meta.word_count ? (
        <span className="text-xs text-slate-400 tabular-nums">{meta.word_count} 词</span>
      ) : null}
      {meta.duration_min ? (
        <span className="text-xs text-slate-400 tabular-nums">{meta.duration_min} 分钟</span>
      ) : null}

      <div className="flex-1" />

      {merged?.boundary && merged?.spread != null ? (
        <span
          className="rounded-md border border-amber-300 bg-amber-50 text-amber-800 text-xs px-2 py-1"
          title={`两次独立评分的总分相差 ${merged.spread} 分（${merged.pass_overall?.join(' vs ')}）`}
        >
          边界样本 · 两次差 {merged.spread}
        </span>
      ) : null}

      {merged ? (
        <span className={`stat-num text-2xl ${bandColor(merged.score.overall)}`}>
          {merged.score.overall.toFixed(1)}
        </span>
      ) : view.streaming ? (
        <span className="text-xs text-slate-400">评分中…</span>
      ) : null}
    </header>
  );
}

// ---------------------------------------------------------------------------
// 原文
// ---------------------------------------------------------------------------
function EssayPane({ view, compact = false }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 px-5 pt-4 pb-2 text-xs font-medium text-slate-500">
        原文{view.meta?.task === 1 ? '（Task 1 的图表信息由模型读图）' : ''}
      </div>
      <div className={`flex-1 min-h-0 overflow-y-auto scroll-thin px-5 pb-6 ${compact ? '' : ''}`}>
        <div className="prose-essay">{view.original}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 评分还没回来：进度 + 原文
// ---------------------------------------------------------------------------
function PendingBody({ view }) {
  return (
    <div className="flex-1 min-h-0 flex">
      <div className="w-[55%] min-w-0 border-r border-slate-200 flex flex-col">
        <EssayPane view={view} />
      </div>
      <div className="w-[45%] min-w-0 overflow-y-auto scroll-thin px-5 py-5">
        <div className="card">
          <div className="text-sm font-medium mb-1">批改进行中</div>
          <div className="text-xs text-slate-400 mb-3">
            三次调用并行，通常 30-90 秒。关掉页面不会中断，但结果不会自动回来。
          </div>
          <div className="divide-y divide-slate-100">
            {TASKS.map((id) => (
              <ProgressRow key={id} id={id} task={view.tasks?.[id]} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 评分面板
// ---------------------------------------------------------------------------
function DimCard({ meta, score, detail }) {
  const pct = Math.max(0, Math.min(100, (Number(score) / 9) * 100));
  return (
    <div className="rounded-lg border border-slate-200 p-3.5">
      <div className="flex items-baseline justify-between">
        <div>
          <span className="text-xs font-medium text-slate-500">{meta.label}</span>
          <span className="text-xs text-slate-400 ml-1.5">{meta.cn}</span>
        </div>
        <span className={`stat-num text-lg ${bandColor(score)}`}>{Number(score).toFixed(1)}</span>
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div
          className={`h-full rounded-full ${score >= 7 ? 'bg-emerald-500' : score >= 6 ? 'bg-sky-500' : score >= 5 ? 'bg-amber-500' : 'bg-rose-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {detail?.comment ? (
        <p className="mt-2.5 text-[13px] leading-relaxed text-slate-600">{detail.comment}</p>
      ) : null}
      {detail?.evidence?.length ? (
        <div className="mt-2 space-y-1">
          {detail.evidence.slice(0, 2).map((q, i) => (
            <div key={i} className="text-[12px] text-slate-500 bg-slate-50 rounded px-2 py-1 leading-relaxed">
              「{q}」
            </div>
          ))}
        </div>
      ) : null}
      {detail?.fix_example ? (
        <div className="mt-2 text-[12.5px] leading-relaxed text-emerald-900 bg-emerald-50 border border-emerald-200 rounded px-2 py-1.5">
          改法：{detail.fix_example}
        </div>
      ) : null}
    </div>
  );
}

function ListBlock({ title, items, tone }) {
  if (!items?.length) return null;
  const dot = tone === 'good' ? 'bg-emerald-500' : tone === 'bad' ? 'bg-rose-500' : 'bg-sky-500';
  return (
    <div>
      <div className="text-xs font-medium text-slate-500 mb-1.5">{title}</div>
      <ul className="space-y-1.5">
        {items.map((s, i) => (
          <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-slate-600">
            <span className={`mt-[7px] h-1.5 w-1.5 rounded-full shrink-0 ${dot}`} />
            <span>{s}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ScorePane({ merged, view, onReview }) {
  const radarData = DIM_META.map((d) => ({ dim: d.label, value: merged.score[d.key] }));
  const reviewed = Number(view.meta?.review_count || 0);
  const canReview = view.meta?.status === 'COMPLETED';

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-5">
        <div>
          <div className="text-xs text-slate-500">综合评分</div>
          <div className={`stat-num text-5xl ${bandColor(merged.score.overall)}`}>
            {merged.score.overall.toFixed(1)}
          </div>
          <div className="text-[11px] text-slate-400 mt-1 tabular-nums">
            {merged.pass_overall?.length > 1
              ? `两次独立评分 ${merged.pass_overall.join(' / ')}`
              : '单评 · 未做一致性检测'}
          </div>
        </div>
        <div className="flex-1 h-[150px]">
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={radarData} outerRadius="72%">
              <PolarGrid stroke="#e2e8f0" />
              <PolarAngleAxis dataKey="dim" tick={{ fontSize: 10, fill: '#64748b' }} />
              <PolarRadiusAxis domain={[0, 9]} tick={false} axisLine={false} />
              <Radar dataKey="value" stroke="#0284c7" fill="#0ea5e9" fillOpacity={0.28} />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {merged.pass_overall?.length > 1 ? (
        <div className="text-[11px] text-slate-400 -mt-2">
          两次评分相差 ≥0.5 会标记为边界样本，说明这篇正好卡在档位分界上。
        </div>
      ) : (
        <div className="text-[11px] text-slate-400 -mt-2 leading-relaxed">
          单评结果，没有做一致性检测。同一篇作文在不同模型、不同对话里可能差 0.5 分。
        </div>
      )}

      <div className="rounded-lg border border-slate-200 px-3.5 py-3">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-slate-600">
              复核 · 第二次独立评分
              {reviewed ? <span className="ml-1.5 text-slate-400">已做 {reviewed} 次</span> : null}
            </div>
            <div className="text-[11px] text-slate-400 mt-1 leading-relaxed">
              把这篇再入队一次，只要求四个分数。跑的时候必须开新对话，
              同一个对话里模型会看见自己上一次的结论，那就不算独立。
            </div>
          </div>
          <button
            type="button"
            onClick={onReview}
            disabled={!canReview || !onReview}
            title={canReview ? '生成一个只含四个分数的复核任务' : '只有已完成批改的记录可以复核'}
            className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            发起复核
          </button>
        </div>
      </div>

      <div className="space-y-2.5">
        {DIM_META.map((d) => (
          <DimCard key={d.key} meta={d} score={merged.score[d.key]} detail={merged.dims?.[d.key]} />
        ))}
      </div>

      <div className="space-y-4 pt-1">
        <ListBlock title="优点" items={merged.strengths} tone="good" />
        <ListBlock title="主要问题" items={merged.weaknesses} tone="bad" />
        <ListBlock title="下一步" items={merged.next_actions} tone="next" />
      </div>

      {merged.errors?.length ? (
        <div>
          <div className="text-xs font-medium text-slate-500 mb-2">
            错误清单（{merged.errors.length} 类）
          </div>
          <div className="space-y-2">
            {merged.errors.map((e, i) => (
              <div key={i} className="rounded-lg border border-slate-200 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] text-slate-700">
                    {ERROR_TAGS[e.tag] || e.tag}
                  </span>
                  <span className="text-[11px] text-slate-400">{ERROR_TYPES[e.type] || e.type}</span>
                  <span className="flex-1" />
                  <span className="text-xs tabular-nums text-slate-500">×{e.count}</span>
                </div>
                {e.examples?.length ? (
                  <div className="mt-1 space-y-0.5">
                    {e.examples.map((x, j) => (
                      <div key={j} className="text-[12px] text-slate-500 leading-relaxed">{x}</div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="text-[11px] text-slate-400 leading-relaxed pb-6">
        分数是模型按 band descriptor 的判断，不同考官之间会有 0.5 分浮动。
        它能告诉你现在大概在哪一档，但真正让你上去的是「主要问题」里那几条。
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 改写
// ---------------------------------------------------------------------------
function RewritePane({ view, onRetryRevision }) {
  const original = view.original;
  const revised = view.revision;
  const busy = Boolean(view.revisionBusy);

  return (
    <div className="space-y-4 pb-6">
      <div className="flex items-center gap-3">
        <div className="text-xs text-slate-500 flex-1">
          {revised ? '灰底是原文，绿底是改写。逐段对照。' : busy ? '改写稿生成中…' : '还没有改写稿'}
        </div>
        <button
          type="button"
          onClick={onRetryRevision}
          disabled={busy}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
        >
          {busy ? '生成中…' : revised ? '重新生成' : '生成改写'}
        </button>
      </div>

      {view.revisionError ? (
        <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700 leading-relaxed">
          改写没拿到：{view.revisionError}
          <button
            type="button"
            onClick={onRetryRevision}
            disabled={busy}
            className="ml-2 underline decoration-rose-300 hover:text-rose-900 disabled:opacity-40"
          >
            重试
          </button>
        </div>
      ) : null}

      {revised ? (
        <DiffStack original={original} revised={revised} />
      ) : (
        <div className="text-sm text-slate-400 py-10 text-center">
          {busy ? '还在写…' : '点右上角生成改写'}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 对话
// ---------------------------------------------------------------------------
function ChatPane({ view, onChat }) {
  const [msgs, setMsgs] = useState(view.chat || []);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [incoming, setIncoming] = useState('');
  const [lastFailed, setLastFailed] = useState(null);
  const bottom = useRef(null);
  const incomingRef = useRef('');

  useEffect(() => { setMsgs(view.chat || []); }, [view.chat]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [msgs, incoming]);

  const ask = async (q) => {
    setSending(true);
    setIncoming('');
    incomingRef.current = '';
    setLastFailed(null);
    setMsgs((m) => [...m, { role: 'user', content: q }]);
    try {
      await onChat({
        question: q,
        onDelta: (t) => {
          incomingRef.current += t;
          setIncoming(incomingRef.current);
        },
      });
      if (incomingRef.current.trim()) {
        setMsgs((m) => [...m, { role: 'assistant', content: incomingRef.current }]);
      }
    } catch (e) {
      // 半截回答也要留下，否则用户拿到的信息比实际更少
      if (incomingRef.current.trim()) {
        setMsgs((m) => [...m, { role: 'assistant', content: incomingRef.current }]);
      }
      setMsgs((m) => [...m, { role: 'error', content: `没有拿到回答：${e.message}` }]);
      setLastFailed(q);
    } finally {
      setSending(false);
      setIncoming('');
      incomingRef.current = '';
    }
  };

  const send = () => {
    const q = draft.trim();
    if (!q || sending) return;
    setDraft('');
    ask(q);
  };

  return (
    <div className="h-full flex flex-col -mx-5 -mb-4">
      <div className="flex-1 overflow-y-auto scroll-thin px-5 space-y-3 py-2">
        {msgs.length === 0 && !incoming && (
          <div className="text-xs text-slate-400 leading-relaxed py-6">
            可以追问，比如「第二段为什么只有 6 分」「这句还有别的改法吗」。
            回答会引用你的原句。
          </div>
        )}
        {msgs.map((m, i) => {
          if (m.role === 'error') {
            return (
              <div key={i} className="flex justify-start">
                <div className="max-w-[92%] rounded-xl px-3.5 py-2.5 text-[12.5px] leading-relaxed bg-rose-50 border border-rose-200 text-rose-700">
                  {m.content}
                  {lastFailed && i === msgs.length - 1 ? (
                    <button
                      type="button"
                      onClick={() => { setMsgs((x) => x.slice(0, -1)); ask(lastFailed); }}
                      disabled={sending}
                      className="ml-2 underline decoration-rose-300 hover:text-rose-900 disabled:opacity-40"
                    >
                      重试
                    </button>
                  ) : null}
                </div>
              </div>
            );
          }
          return (
            <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div
                className={`max-w-[92%] rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap ${
                  m.role === 'user'
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-700'
                }`}
              >
                {m.content}
              </div>
            </div>
          );
        })}
        {incoming && (
          <div className="flex justify-start">
            <div className="max-w-[92%] rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap bg-slate-100 text-slate-700">
              {incoming}
            </div>
          </div>
        )}
        <div ref={bottom} />
      </div>

      <div className="shrink-0 border-t border-slate-200 pt-3 pb-4 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={sending ? '回答中…' : '问点什么'}
          disabled={sending}
          className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400 disabled:bg-slate-50"
        />
        <button
          type="button"
          onClick={send}
          disabled={sending || !draft.trim()}
          className="rounded-lg bg-slate-900 text-white text-sm px-4 disabled:opacity-40"
        >
          发送
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function Result({ view, onRetryRevision, onChat, onReview, apiMode = true }) {
  const [tab, setTab] = useState('score');
  const merged = view.merged;

  return (
    <div className="h-full flex flex-col">
      <Header view={view} />

      {view.error ? (
        <div className="mx-6 mt-3 rounded-lg bg-rose-50 border border-rose-200 px-3.5 py-2.5 text-sm text-rose-700">
          {view.error}
        </div>
      ) : null}

      {!merged ? (
        <PendingBody view={view} />
      ) : (
        <div className="flex-1 min-h-0 flex">
          <div className="w-[55%] min-w-0 border-r border-slate-200 flex flex-col">
            <EssayPane view={view} />
          </div>

          <div className="w-[45%] min-w-0 flex flex-col">
            <div className="shrink-0 flex border-b border-slate-200 bg-white">
              {[
                ['score', '评分'],
                ['rewrite', '改写'],
                ['chat', '对话'],
              ].map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setTab(k)}
                  className={`px-4 py-2.5 text-sm transition-colors border-b-2 -mb-px ${
                    tab === k
                      ? 'border-slate-900 text-slate-900 font-medium'
                      : 'border-transparent text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {!apiMode && tab !== 'score' && (
              <div className="mx-5 mt-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[11.5px] text-amber-800 leading-relaxed">
                当前是文件队列模式，{tab === 'chat' ? '追问对话' : '重新生成改写'}需要走到模型直连。
                右上角设置里切到「自己的 API」再用；队列模式只负责批改与落盘。
              </div>
            )}
            <div className="flex-1 min-h-0 overflow-y-auto scroll-thin px-5 py-4">
              {tab === 'score' && <ScorePane merged={merged} view={view} onReview={onReview} />}
              {tab === 'rewrite' && (
                <RewritePane view={view} onRetryRevision={onRetryRevision} />
              )}
              {tab === 'chat' && <ChatPane view={view} onChat={onChat} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
