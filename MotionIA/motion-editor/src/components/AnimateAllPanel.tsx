'use client';

import { useState } from 'react';
import type { AnimationConfig } from '@/remotion/HtmlAnimator';

const PRESETS = [
  'Cada elemento surge de baixo com bounce, delay de 5 frames entre eles',
  'Fade in em sequência da esquerda para a direita, delay de 4 frames',
  'Pop de escala em cascata, spring com delay de 6 frames por elemento',
  'Slide da esquerda todos juntos, depois fade in em sequência',
  'Elementos aparecem de cima para baixo, spring suave',
];

interface Props {
  html: string;
  onApply: (configs: AnimationConfig[]) => void;
}

function extractElements(html: string) {
  if (typeof window === 'undefined') return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(doc.querySelectorAll('[data-element-id]')).map((el) => ({
    id: el.getAttribute('data-element-id') ?? '',
    tag: el.tagName.toLowerCase(),
    text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 50),
  }));
}

export default function AnimateAllPanel({ html, onApply }: Props) {
  const [prompt, setPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastCount, setLastCount] = useState(0);

  if (!html) return null;

  const handleAnimate = async () => {
    if (!prompt.trim()) return;
    const elements = extractElements(html);
    if (elements.length === 0) {
      setError('Nenhum elemento encontrado no HTML');
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      const res = await fetch('/api/animate-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ elements, description: prompt }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const configs = data.configs as AnimationConfig[];
      onApply(configs);
      setLastCount(configs.length);
      setPrompt('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Erro ao animar');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col p-4 gap-3 border-b border-gray-800">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          Animar tudo
        </span>
        {lastCount > 0 && !isLoading && (
          <span className="text-[10px] text-violet-400">{lastCount} elementos animados</span>
        )}
      </div>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleAnimate(); }}
        placeholder="Descreva a animação para todos os elementos…&#10;Ex: surgem de baixo em cascata com bounce"
        rows={3}
        disabled={isLoading}
        className="w-full bg-gray-900 border border-gray-700 rounded-lg p-2.5 text-xs text-white placeholder-gray-600 resize-none focus:outline-none focus:border-violet-500 disabled:opacity-40"
      />

      {/* Quick presets */}
      <div className="flex flex-col gap-1">
        {PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => setPrompt(p)}
            className="text-left text-[10px] px-2 py-1.5 rounded bg-gray-800 text-gray-500 hover:bg-gray-700 hover:text-gray-300 transition-colors leading-snug"
          >
            {p}
          </button>
        ))}
      </div>

      <button
        onClick={handleAnimate}
        disabled={!prompt.trim() || isLoading}
        className="w-full py-2 rounded-lg text-xs font-semibold bg-violet-700 hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {isLoading ? 'Gerando animações…' : '✦ Animar todos os elementos'}
      </button>

      {error && <div className="text-xs text-red-400">{error}</div>}
    </div>
  );
}
