// 按段落配对展示：原文灰底、改写绿底，上下堆叠。
// 走的是「保留段落结构」的改写指令，所以第 i 段和第 i 段对得上。

function splitParas(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function DiffStack({ original, revised }) {
  const a = splitParas(original);
  const b = splitParas(revised);
  const n = Math.max(a.length, b.length);

  if (n === 0) return null;

  return (
    <div className="space-y-5">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="space-y-1.5">
          <div className="text-[11px] text-slate-400">第 {i + 1} 段</div>
          {a[i] && (
            <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2.5 text-[13.5px] leading-relaxed text-slate-500">
              {a[i]}
            </div>
          )}
          {b[i] && (
            <div className="rounded-lg bg-emerald-50/70 border border-emerald-200 px-3 py-2.5 text-[13.5px] leading-relaxed text-emerald-950">
              {b[i]}
            </div>
          )}
          {!b[i] && a[i] && (
            <div className="text-xs text-slate-400 pl-1">这一段没有对应改写</div>
          )}
        </div>
      ))}
    </div>
  );
}
