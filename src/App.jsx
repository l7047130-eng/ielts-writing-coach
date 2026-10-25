import { useCallback, useEffect, useRef, useState } from 'react';
import Compose from './pages/Compose.jsx';
import Result from './pages/Result.jsx';
import QueueWait from './pages/QueueWait.jsx';
import SettingsDialog from './components/SettingsDialog.jsx';
import { fetchJSON, sendJSON, streamRequest } from './api.js';

function blankLive(payload) {
  return {
    id: null,
    meta: {
      id: null,
      task: payload.task,
      topic: payload.topic || '',
      prompt: payload.prompt || '',
      word_count: null,
      status: 'SCORING',
      created_at: new Date().toISOString(),
    },
    original: payload.essay || '',
    prompt: payload.prompt || '',
    merged: null,
    revision: '',
    revisionError: null,
    tasks: {},
    error: null,
    chat: [],
    streaming: true,
    doneStatus: null,
  };
}

function reduceLive(prev, event, data) {
  if (!prev) return prev;
  switch (event) {
    case 'start':
      return {
        ...prev,
        id: data.id,
        meta: { ...prev.meta, id: data.id, topic: data.topic, word_count: data.wordCount },
      };
    case 'task':
      return { ...prev, tasks: { ...prev.tasks, [data.id]: data } };
    case 'merged':
      return { ...prev, merged: data };
    case 'revision':
      return { ...prev, revision: data.text || '', revisionError: data.error || null };
    case 'error':
      return { ...prev, error: data.message };
    case 'done':
      return { ...prev, streaming: false, doneStatus: data.status || null, id: data.id || prev.id };
    default:
      return prev;
  }
}

function detailToView(d) {
  const failed = d.meta?.status === 'FAILED';
  return {
    id: d.meta.id,
    meta: d.meta,
    original: d.original || '',
    prompt: d.meta.prompt || '',
    merged: d.merged || null,
    revision: d.revised || '',
    revisionError: null,
    tasks: {},
    error: failed ? '这次批改失败了，没有写入看板。原文还留着，可以重新批。' : null,
    chat: d.chat,
    streaming: false,
    doneStatus: d.meta?.status || null,
    reviewCount: d.meta?.review_count || 0,
  };
}

// 队列任务 → 等待页需要的形状
function taskToQueue(t, status = {}) {
  return {
    id: t.id,
    kind: t.kind || 'full',
    assessment_id: t.assessment_id || status.assessment_id || null,
    task: t.task,
    topic: t.topic || '',
    chars: t.chars || 0,
    trigger: t.trigger || '',
    startedAt: Date.parse(t.created_at) || Date.now(),
    status: status.status === 'failed' ? 'failed' : 'pending',
    note: status.note || null,
    error: status.failure?.reason || null,
    warnings: status.failure?.warnings || [],
  };
}

const isNotFound = (e) => e?.status === 404;

export default function App() {
  const [items, setItems] = useState([]);
  const [mode, setMode] = useState('compose');   // compose | queue | result
  const [detail, setDetail] = useState(null);
  const [live, setLive] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [settings, setSettings] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [queue, setQueue] = useState(null);
  const [queueBusy, setQueueBusy] = useState(false);
  const [pendingTasks, setPendingTasks] = useState([]);
  const abortRef = useRef(null);

  const apiMode = settings?.mode === 'api';

  const refresh = useCallback(async () => {
    try {
      const d = await fetchJSON('/assessments');
      setItems(d.items || []);
    } catch (e) {
      console.error('拉列表失败', e);
    }
  }, []);

  // 拉待处理队列：刷新页面后靠它把等待中的任务找回来
  const refreshQueue = useCallback(async () => {
    try {
      const d = await fetchJSON('/queue');
      setPendingTasks(d.items || []);
      return d;
    } catch (e) {
      console.error('拉队列失败', e);
      return null;
    }
  }, []);

  // 首次进来自动弹设置：没配模型就什么都干不了
  useEffect(() => {
    fetchJSON('/health')
      .then((h) => {
        setSettings(h);
        if (h.missing?.length > 0) setSettingsOpen(true);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { refresh(); refreshQueue(); }, [refresh, refreshQueue]);

  // 流结束且成功 → 换成磁盘里的详情（能拿到对话记录），顺手刷列表
  useEffect(() => {
    if (!live || live.streaming) return;
    if (live.doneStatus !== 'COMPLETED' || !live.id) return;
    let alive = true;
    (async () => {
      await refresh();
      try {
        const d = await fetchJSON(`/assessments/${live.id}`);
        if (!alive) return;
        setDetail(d);
        setActiveId(d.meta.id);
        setLive(null);
      } catch { /* 保留流里的内容 */ }
    })();
    return () => { alive = false; };
  }, [live, refresh]);

  const startGrade = async (payload) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setDetail(null);
    setActiveId(null);
    setLive(blankLive(payload));
    setMode('result');
    try {
      await streamRequest('/grade', payload, (event, data) => {
        setLive((p) => reduceLive(p, event, data));
      }, ac.signal);
    } catch (e) {
      if (e.name !== 'AbortError') {
        setLive((p) => (p ? { ...p, error: e.message, streaming: false } : p));
      }
    } finally {
      setLive((p) => (p && p.streaming ? { ...p, streaming: false } : p));
    }
  };

  // ---- 文件队列模式 ----
  const enterQueue = (q) => {
    setQueue(q);
    setMode('queue');
    setDetail(null);
    setLive(null);
    setActiveId(null);
  };

  const startQueue = async (payload) => {
    abortRef.current?.abort();
    setDetail(null);
    setLive(null);
    setActiveId(null);
    try {
      const r = await sendJSON('/queue', 'POST', payload);
      enterQueue({
        id: r.id,
        kind: r.kind || 'full',
        assessment_id: r.assessment_id || null,
        chars: r.chars,
        hint: r.hint || null,
        trigger: r.trigger,
        startedAt: Date.now(),
        status: 'pending',
        warnings: [],
      });
      refreshQueue();
    } catch (e) {
      window.alert(`入队失败：${e.message}`);
    }
  };

  // 从侧栏点回一个还没处理完的任务
  const resumeTask = async (t) => {
    abortRef.current?.abort();
    try {
      const st = await fetchJSON(`/queue/${t.id}`).catch((e) => {
        if (isNotFound(e)) return { status: 'missing' };
        throw e;
      });
      if (st.status === 'imported' && st.assessment_id) {
        await openAssessment(st.assessment_id);
        await refreshQueue();
        return;
      }
      if (st.status === 'missing') {
        await refreshQueue();
        window.alert('这个任务已经不在了，可能刚被导入或删掉。');
        return;
      }
      if (st.pending?.instruction) delete st.pending.instruction;
      enterQueue(taskToQueue({ ...t, trigger: t.trigger }, st));
      if (!t.trigger) {
        const d = await refreshQueue();
        if (d?.trigger) setQueue((q) => (q ? { ...q, trigger: d.trigger } : q));
      }
    } catch (e) {
      window.alert(`读取任务失败：${e.message}`);
    }
  };

  // 轮询：done 合法就自动 ingest；确定失败就停下并说清楚原因
  useEffect(() => {
    if (!queue || queue.status !== 'pending' || mode !== 'queue') return undefined;
    let alive = true;
    let timer = null;
    let delay = 2000;
    let emptyTicks = 0;

    const stopWithFailure = (reason, warnings, extra = {}) => {
      setQueue((q) => (q ? {
        ...q,
        status: 'failed',
        error: reason || '结果校验没通过',
        warnings: warnings?.length ? warnings : (reason ? [reason] : []),
        ...extra,
      } : q));
    };

    const schedule = () => {
      if (!alive) return;
      delay = Math.min(5000, delay + 500);
      timer = setTimeout(tick, delay);
    };

    const tick = async () => {
      if (!alive) return;
      let st;
      try {
        st = await fetchJSON(`/queue/${queue.id}`);
      } catch (e) {
        if (!alive) return;
        if (isNotFound(e)) {
          // 任务文件没了：多半是另一个页面已经导入成功
          stopWithFailure('任务已经不在队列里了，可能已在另一个页面导入完成。看看左侧记录列表。');
          refreshQueue();
          return;
        }
        schedule();
        return;
      }
      if (!alive) return;

      if (st.status === 'pending') {
        emptyTicks += 1;
        setQueue((q) => (q ? { ...q, note: st.note || null, resultState: st.resultState } : q));
        schedule();
        return;
      }

      if (st.status === 'failed') {
        stopWithFailure(st.failure?.reason, st.failure?.warnings, { resultState: st.resultState });
        refreshQueue();
        return;
      }

      if (st.status === 'imported' && st.assessment_id) {
        setQueue(null);
        openAssessment(st.assessment_id);
        refreshQueue();
        return;
      }

      if (st.status === 'done') {
        setQueue((q) => (q ? { ...q, resultState: 'ready' } : q));
        try {
          const r = await sendJSON(`/queue/${queue.id}/ingest`, 'POST');
          if (!alive) return;
          setDetail(r.detail);
          setActiveId(r.id);
          setQueue(null);
          setMode('result');
          refresh();
          refreshQueue();
        } catch (e) {
          if (!alive) return;
          if (e.status === 409) {
            // 结果文件刚出现但还没读完，继续等
            schedule();
            return;
          }
          if (e.status === 404) {
            stopWithFailure(e.message);
            refreshQueue();
            return;
          }
          // 422 / 500：明确失败，停止无限重试
          stopWithFailure(e.message, e.warnings);
          refreshQueue();
        }
        return;
      }

      schedule();
    };

    timer = setTimeout(tick, 1500);
    return () => { alive = false; clearTimeout(timer); };
  }, [queue?.id, queue?.status, mode, refresh, refreshQueue]);

  const submitPaste = async (reply) => {
    if (!queue || !reply.trim()) return;
    setQueueBusy(true);
    try {
      const r = await sendJSON(`/queue/${queue.id}/ingest`, 'POST', { reply });
      setDetail(r.detail);
      setActiveId(r.id);
      setQueue(null);
      setMode('result');
      refresh();
      refreshQueue();
    } catch (e) {
      setQueue((q) => (q ? {
        ...q,
        status: 'failed',
        error: e.message,
        warnings: e.warnings?.length ? e.warnings : [e.message],
      } : q));
    } finally {
      setQueueBusy(false);
    }
  };

  // 只是离开等待页，任务留在磁盘上，稍后能从左边再点回来
  const leaveQueue = () => {
    setQueue(null);
    setMode('compose');
    refreshQueue();
  };

  // 真取消：删掉任务文件
  const cancelQueue = async () => {
    if (queue?.id) {
      try { await sendJSON(`/queue/${queue.id}`, 'DELETE'); } catch { /* ignore */ }
    }
    setQueue(null);
    setMode('compose');
    refreshQueue();
  };

  // 失败后手动再检查一次（比如刚替换了 done 文件）
  const recheckQueue = () => {
    setQueue((q) => (q ? { ...q, status: 'pending', error: null, warnings: [], note: null } : q));
  };

  const handleSubmit = (payload) => (
    apiMode ? startGrade(payload) : startQueue(payload)
  );

  // 发起复核：材料由后端从存档里取，前端只报一个记录 id
  const startReview = async (id) => {
    if (!id) return;
    try {
      const r = await sendJSON('/queue', 'POST', { kind: 'review', id });
      enterQueue({
        id: r.id,
        kind: 'review',
        assessment_id: r.assessment_id,
        chars: r.chars,
        hint: r.hint || null,
        trigger: r.trigger,
        startedAt: Date.now(),
        status: 'pending',
        warnings: [],
      });
      refreshQueue();
    } catch (e) {
      window.alert(`发起复核失败：${e.message}`);
    }
  };

  const openAssessment = async (id) => {
    abortRef.current?.abort();
    setLive(null);
    setQueue(null);
    try {
      const d = await fetchJSON(`/assessments/${id}`);
      setDetail(d);
      setActiveId(id);
      setMode('result');
    } catch (e) {
      console.error(e);
    }
  };

  const newAssessment = () => {
    abortRef.current?.abort();
    setLive(null);
    setDetail(null);
    setActiveId(null);
    setQueue(null);
    setMode('compose');
  };

  const removeItem = async (id, ev) => {
    ev.stopPropagation();
    if (!window.confirm('删掉这条记录？对应的看板数据文件也会一起删。')) return;
    await sendJSON(`/assessments/${id}`, 'DELETE');
    if (activeId === id) newAssessment();
    refresh();
  };

  const retryRevision = async () => {
    const id = detail?.meta?.id;
    if (!id) return;
    if (!apiMode) {
      setDetail((d) => (d ? { ...d, revisionError: '重新生成改写要走模型直连。到右上角设置里切到「自己的 API」模式再用。' } : d));
      return;
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setDetail((d) => (d ? { ...d, revisionError: null, revisionBusy: true } : d));
    try {
      await streamRequest(`/assessments/${id}/revise`, {}, (event, data) => {
        if (event === 'revision' && data?.text) {
          setDetail((d) => (d ? { ...d, revised: data.text } : d));
        }
      }, ac.signal);
    } catch (e) {
      if (e.name !== 'AbortError') {
        setDetail((d) => (d ? { ...d, revisionError: e.message } : d));
      }
    } finally {
      setDetail((d) => (d ? { ...d, revisionBusy: false } : d));
    }
  };

  const sendChat = async ({ question, onDelta }) => {
    const id = detail?.meta?.id;
    if (!id) throw new Error('这条记录还没落盘，稍等一秒再问');
    if (!apiMode) {
      throw new Error('追问对话要走模型直连。当前是文件队列模式，到右上角设置里切到「自己的 API」再来。');
    }
    await streamRequest(`/assessments/${id}/chat`, { question }, (event, data) => {
      if (event === 'delta') onDelta(data.text);
    });
    // 重新拉一次，保证对话记录和磁盘一致
    try {
      const d = await fetchJSON(`/assessments/${id}`);
      setDetail(d);
    } catch { /* ignore */ }
  };

  const view = detail ? detailToView(detail) : live;

  return (
    <div className="flex h-full">
      <aside className="w-[220px] shrink-0 border-r border-slate-200 bg-white flex flex-col">
        <div className="px-4 py-4 border-b border-slate-100">
          <div className="flex items-start">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">写作批改</div>
              <div className="text-xs text-slate-400 mt-0.5 truncate" title={apiMode ? (settings?.model || '') : '文件队列'}>
                {apiMode ? (settings?.model || '未配置模型') : '文件队列模式'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              title="模型设置"
              className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={newAssessment}
          className="mx-3 mt-3 rounded-lg bg-slate-900 text-white text-sm py-2 hover:bg-slate-800 transition-colors"
        >
          + 新批一篇
        </button>

        <div className="flex-1 overflow-y-auto scroll-thin mt-3 pb-4">
          {pendingTasks.length > 0 && (
            <div className="px-2 mb-2">
              <div className="px-1.5 mb-1 text-[11px] text-slate-400">
                等待中的任务 · {pendingTasks.length}
              </div>
              <div className="space-y-0.5">
                {pendingTasks.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => resumeTask(t)}
                    className={`w-full text-left px-2 py-1.5 rounded-md flex items-center gap-1.5 text-[11px] transition-colors ${
                      queue?.id === t.id ? 'bg-sky-50 text-sky-800' : 'hover:bg-slate-50 text-slate-600'
                    }`}
                    title={t.id}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${t.failed ? 'bg-rose-500' : t.has_result ? 'bg-emerald-500' : 'bg-sky-400'}`} />
                    <span className="truncate flex-1">
                      T{t.task} · {t.topic || t.id}
                    </span>
                    <span className="text-[10px] text-slate-400 shrink-0">
                      {t.failed ? '失败' : t.has_result ? '有结果' : (t.kind === 'review' ? '复核' : '')}
                    </span>
                  </button>
                ))}
              </div>
              <div className="mx-1 my-2 border-t border-slate-100" />
            </div>
          )}

          {items.length === 0 && pendingTasks.length === 0 && (
            <div className="px-4 py-6 text-xs text-slate-400 leading-relaxed">
              还没有记录。批完一篇，这里会出现，同时写进老看板的写作页。
            </div>
          )}
          {items.map((it) => {
            const isActive = activeId === it.id;
            const failed = it.status === 'FAILED';
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => openAssessment(it.id)}
                className={`group w-full text-left px-3 py-2.5 mx-1 rounded-lg flex items-center gap-2 transition-colors ${
                  isActive ? 'bg-slate-100' : 'hover:bg-slate-50'
                }`}
                style={{ width: 'calc(100% - 8px)' }}
              >
                <span className="text-xs text-slate-400 w-10 shrink-0 tabular-nums">
                  {String(it.date || '').slice(5)}
                </span>
                <span className="text-xs text-slate-500 w-5 shrink-0">T{it.task}</span>
                <span className="text-xs text-slate-600 truncate flex-1" title={it.topic}>
                  {it.topic}
                </span>
                {failed ? (
                  <span className="text-[11px] text-rose-500 shrink-0">失败</span>
                ) : (
                  <span className="text-xs font-semibold tabular-nums shrink-0">
                    {it.score?.overall ?? '—'}
                  </span>
                )}
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => removeItem(it.id, e)}
                  className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-rose-500 text-xs shrink-0"
                >
                  ✕
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-hidden">
        {mode === 'queue' && queue ? (
          <QueueWait
            queue={queue}
            busy={queueBusy}
            onCancel={cancelQueue}
            onLeave={leaveQueue}
            onRecheck={recheckQueue}
            onPaste={submitPaste}
          />
        ) : mode === 'compose' || !view ? (
          <Compose onSubmit={handleSubmit} gradingMode={settings?.mode || 'queue'} />
        ) : (
          <Result
            view={detail ? { ...view, revisionBusy: detail.revisionBusy } : view}
            apiMode={apiMode}
            onRetryRevision={retryRevision}
            onReview={() => startReview(detail?.meta?.id)}
            onChat={sendChat}
          />
        )}
      </main>

      <SettingsDialog
        open={settingsOpen}
        canClose={Boolean(settings?.missing?.length === 0)}
        onClose={() => setSettingsOpen(false)}
        onSaved={(s) => setSettings({ ...s, missing: [] })}
      />
    </div>
  );
}
