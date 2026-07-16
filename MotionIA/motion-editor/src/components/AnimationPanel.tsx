'use client';

import { useState } from 'react';

interface SelectedElement {
  id: string;
  html: string;
}

interface Props {
  selectedElement: SelectedElement | null;
  onAnimate: (elementId: string, elementHtml: string, description: string) => Promise<void>;
  animatedIds: Set<string>;
}

export default function AnimationPanel({ selectedElement, onAnimate, animatedIds }: Props) {
  const [description, setDescription] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [lastResult, setLastResult] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedElement || !description.trim()) return;
    setIsLoading(true);
    setLastResult('');
    try {
      await onAnimate(selectedElement.id, selectedElement.html, description);
      setLastResult('✓ Animação aplicada!');
      setDescription('');
    } catch {
      setLastResult('✗ Erro ao gerar animação');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col p-4 gap-4">
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
        Animação
      </div>

      {/* Selected element info */}
      <div className={`rounded-lg border p-3 text-xs transition-colors ${
        selectedElement
          ? 'border-indigo-500/50 bg-indigo-950/30'
          : 'border-gray-800 bg-gray-900/30'
      }`}>
        {selectedElement ? (
          <>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
              <span className="text-indigo-300 font-mono">{selectedElement.id}</span>
              {animatedIds.has(selectedElement.id) && (
                <span className="ml-auto text-emerald-400 text-[10px]">● animado</span>
              )}
            </div>
            <div className="text-gray-500 font-mono truncate">
              {selectedElement.html.slice(0, 80)}...
            </div>
          </>
        ) : (
          <span className="text-gray-600">Nenhum elemento selecionado</span>
        )}
      </div>

      {/* Animation prompt */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={selectedElement
            ? 'Descreva a animação...\nEx: surge de baixo com bounce\nEx: fade in suave\nEx: escala entrando com pop'
            : 'Selecione um elemento primeiro'}
          disabled={!selectedElement || isLoading}
          rows={4}
          className="w-full bg-gray-900 border border-gray-700 rounded-lg p-2.5 text-sm text-white placeholder-gray-600 resize-none focus:outline-none focus:border-indigo-500 disabled:opacity-40"
        />

        <button
          type="submit"
          disabled={!selectedElement || !description.trim() || isLoading}
          className="w-full py-2 rounded-lg text-sm font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {isLoading ? 'Gerando...' : 'Animar'}
        </button>

        {lastResult && (
          <div className={`text-xs text-center ${lastResult.startsWith('✓') ? 'text-emerald-400' : 'text-red-400'}`}>
            {lastResult}
          </div>
        )}
      </form>

      {/* Quick presets */}
      {selectedElement && !isLoading && (
        <div className="flex flex-col gap-1.5">
          <div className="text-xs text-gray-600">Atalhos:</div>
          {[
            'Surge de baixo com bounce',
            'Fade in suave',
            'Pop com escala',
            'Slide da esquerda',
          ].map((preset) => (
            <button
              key={preset}
              onClick={() => setDescription(preset)}
              className="text-left text-xs px-2.5 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
            >
              {preset}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
