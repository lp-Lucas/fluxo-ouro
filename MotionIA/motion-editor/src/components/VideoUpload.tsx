'use client';

import { useCallback, useRef, useState } from 'react';

interface VideoMeta {
  url: string;
  width: number;
  height: number;
  duration: number; // seconds
}

interface Props {
  onUpload: (meta: VideoMeta) => void;
  onClear: () => void;
  videoUrl: string | null;
}

export default function VideoUpload({ onUpload, onClear, videoUrl }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);

  const handleFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith('video/')) return;
      setLoading(true);
      const url = URL.createObjectURL(file);
      const vid = document.createElement('video');
      vid.onloadedmetadata = () => {
        onUpload({ url, width: vid.videoWidth, height: vid.videoHeight, duration: vid.duration });
        setLoading(false);
      };
      vid.onerror = () => setLoading(false);
      vid.src = url;
    },
    [onUpload],
  );

  const handleClear = () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    onClear();
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="px-3 pt-3 pb-3 border-b border-gray-800">
      <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
        Vídeo de fundo
      </div>

      {videoUrl ? (
        <div className="relative rounded overflow-hidden group" style={{ height: 72 }}>
          <video src={videoUrl} className="w-full h-full object-cover" muted autoPlay loop playsInline />
          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
            <button
              onClick={handleClear}
              className="text-[10px] text-white bg-red-600 hover:bg-red-500 px-2.5 py-1 rounded transition-colors"
            >
              ✕ Remover
            </button>
          </div>
          <div className="absolute bottom-1 left-1 text-[9px] text-white/60 bg-black/40 px-1 rounded">
            🎬 vídeo carregado
          </div>
        </div>
      ) : (
        <label
          className="flex flex-col items-center justify-center border-2 border-dashed border-gray-700 rounded-lg p-3 cursor-pointer hover:border-sky-500/70 transition-colors"
          style={{ minHeight: 72 }}
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
          onDragOver={(e) => e.preventDefault()}
        >
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          />
          <span className="text-2xl mb-1">{loading ? '⏳' : '🎬'}</span>
          <span className="text-[10px] text-gray-500 text-center leading-snug">
            {loading ? 'Carregando…' : 'Clique ou solte um vídeo aqui'}
          </span>
        </label>
      )}
    </div>
  );
}
