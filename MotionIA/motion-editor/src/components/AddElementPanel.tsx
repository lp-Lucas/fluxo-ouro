'use client';

import { useRef, useState } from 'react';

interface Preset {
  label: string;
  icon: string;
  html: (id: string) => string;
}

const PRESETS: Preset[] = [
  {
    label: 'Título',
    icon: 'H',
    html: (id) =>
      `<h2 data-element-id="${id}" style="font-size:28px;font-weight:700;color:#111827;margin:0;padding:4px 0;font-family:sans-serif">Título aqui</h2>`,
  },
  {
    label: 'Parágrafo',
    icon: 'P',
    html: (id) =>
      `<p data-element-id="${id}" style="font-size:14px;color:#4b5563;margin:0;padding:4px 0;max-width:220px;line-height:1.6;font-family:sans-serif">Texto aqui. Edite como quiser.</p>`,
  },
  {
    label: 'Botão',
    icon: '▶',
    html: (id) =>
      `<button data-element-id="${id}" style="padding:10px 22px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;font-weight:600;font-family:sans-serif">Botão</button>`,
  },
  {
    label: 'Badge',
    icon: '●',
    html: (id) =>
      `<span data-element-id="${id}" style="display:inline-block;padding:4px 12px;background:#6366f1;color:#fff;border-radius:999px;font-size:12px;font-weight:600;font-family:sans-serif">Badge</span>`,
  },
  {
    label: 'Card',
    icon: '▣',
    html: (id) =>
      `<div data-element-id="${id}" style="padding:18px 20px;background:#fff;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,0.10);min-width:160px;font-family:sans-serif"><p style="margin:0 0 4px;font-weight:600;color:#111827;font-size:14px">Card</p><p style="margin:0;color:#6b7280;font-size:12px">Conteúdo aqui</p></div>`,
  },
  // 'Imagem' is handled separately via file picker — no html() needed here
  {
    label: 'Imagem',
    icon: '🖼',
    html: (_id) => '', // placeholder; overridden by handleImagePreset
  },
  {
    label: 'Divisor',
    icon: '—',
    html: (id) =>
      `<hr data-element-id="${id}" style="border:none;border-top:2px solid #e5e7eb;width:200px;margin:0" />`,
  },
  {
    label: 'Ícone ★',
    icon: '★',
    html: (id) =>
      `<span data-element-id="${id}" style="font-size:32px;line-height:1;color:#f59e0b">★</span>`,
  },
];

interface Props {
  pendingPos: { x: number; y: number } | null;
  onInsert: (html: string) => void;
}

export default function AddElementPanel({ pendingPos, onInsert }: Props) {
  const [description, setDescription] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const imageInputRef = useRef<HTMLInputElement>(null);

  const handlePreset = (preset: Preset) => {
    if (preset.label === 'Imagem') {
      imageInputRef.current?.click();
      return;
    }
    const id = `new-${Date.now()}`;
    onInsert(preset.html(id));
  };

  const handleImageFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const src = ev.target?.result as string;
      const id = `new-${Date.now()}`;
      onInsert(
        `<img data-element-id="${id}" src="${src}" style="max-width:220px;max-height:160px;border-radius:8px;display:block;object-fit:cover" />`,
      );
    };
    reader.readAsDataURL(file);
    e.target.value = ''; // allow re-selecting the same file
  };

  const handleAiGenerate = async () => {
    if (!description.trim()) return;
    setIsLoading(true);
    setError('');
    try {
      const res = await fetch('/api/add-element', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      onInsert(data.html);
      setDescription('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Erro ao gerar elemento');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col p-4 gap-4">
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
        Adicionar Elemento
      </div>

      {/* Click position indicator */}
      <div className={`rounded-lg border p-2.5 text-xs ${pendingPos ? 'border-emerald-500/40 bg-emerald-950/20 text-emerald-300' : 'border-gray-800 bg-gray-900/30 text-gray-600'}`}>
        {pendingPos
          ? `Posição: ${Math.round(pendingPos.x)}×${Math.round(pendingPos.y)} px — escolha um elemento abaixo`
          : 'Clique no canvas para escolher onde inserir'}
      </div>

      {/* Preset grid */}
      <div>
        <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-2">Elementos rápidos</div>
        <div className="grid grid-cols-2 gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              onClick={() => handlePreset(preset)}
              disabled={!pendingPos}
              className="flex items-center gap-2 px-2.5 py-2 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-35 disabled:cursor-not-allowed text-left transition-colors"
            >
              <span className="text-sm w-4 text-center shrink-0 text-gray-400">{preset.icon}</span>
              <span className="text-xs text-gray-300">{preset.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* AI generate */}
      <div className="flex flex-col gap-2 border-t border-gray-800 pt-4">
        <div className="text-[10px] text-gray-600 uppercase tracking-wider">Gerar com IA</div>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Ex: botão verde grande com ícone de WhatsApp"
          disabled={isLoading || !pendingPos}
          rows={3}
          className="w-full bg-gray-900 border border-gray-700 rounded-lg p-2.5 text-xs text-white placeholder-gray-600 resize-none focus:outline-none focus:border-emerald-500 disabled:opacity-40"
        />
        <button
          onClick={handleAiGenerate}
          disabled={!description.trim() || isLoading || !pendingPos}
          className="w-full py-2 rounded-lg text-xs font-medium bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {isLoading ? 'Gerando...' : 'Gerar elemento'}
        </button>
        {error && <div className="text-xs text-red-400">{error}</div>}
      </div>

      {/* Hidden file input for image upload */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleImageFile}
      />
    </div>
  );
}
