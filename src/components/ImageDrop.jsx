import { useRef, useState } from 'react';

// 上传前压到长边 1600px、JPEG 0.85，控体积也控 token
function compress(file, maxSide = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读不出来')); };
    img.src = url;
  });
}

export default function ImageDrop({ value, onChange }) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  const handleFile = async (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      window.alert('只支持图片文件');
      return;
    }
    setBusy(true);
    try {
      onChange(await compress(file));
    } catch (e) {
      window.alert(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (value) {
    return (
      <div className="relative rounded-lg border border-slate-200 overflow-hidden group">
        <img src={value} alt="题目配图" className="w-full max-h-[240px] object-contain bg-slate-50" />
        <button
          type="button"
          onClick={() => onChange(null)}
          className="absolute top-2 right-2 rounded-md bg-white/90 border border-slate-200 px-2 py-1 text-xs text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          移除
        </button>
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        handleFile(e.dataTransfer.files?.[0]);
      }}
      onClick={() => inputRef.current?.click()}
      className={`rounded-lg border border-dashed px-4 py-6 text-center cursor-pointer transition-colors ${
        dragging ? 'border-brand-500 bg-brand-500/5' : 'border-slate-300 hover:border-slate-400'
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
      <div className="text-sm text-slate-500">
        {busy ? '压缩中…' : '把 Task 1 的图表拖进来，或点击选择'}
      </div>
      <div className="text-xs text-slate-400 mt-1">只上传题目图，不用传作文照片</div>
    </div>
  );
}
