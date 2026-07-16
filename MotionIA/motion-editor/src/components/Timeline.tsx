'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { ElementClip } from '@/lib/animation';
import type { Layer } from './LayersPanel';

const LABEL_W = 110;
const TRACK_H = 26;
const RULER_H = 22;
const FPS = 30;

function formatTime(frame: number): string {
  const s = Math.floor(frame / FPS);
  const f = frame % FPS;
  return `${s}:${f.toString().padStart(2, '0')}`;
}

interface Props {
  totalFrames: number;
  currentFrame: number;
  elementClips: ElementClip[];
  layers: Layer[];
  videoUrl: string | null;
  isPlaying: boolean;
  onFrameChange: (frame: number) => void;
  onPlayToggle: () => void;
  onClipChange: (elementId: string, inFrame: number, outFrame: number | null) => void;
}

type DragState =
  | { type: 'playhead' }
  | { type: 'clip'; id: string; origIn: number; origOut: number | null; startX: number }
  | { type: 'clipIn'; id: string; origIn: number; origOut: number | null; startX: number }
  | { type: 'clipOut'; id: string; origIn: number; origOut: number | null; startX: number };

export default function Timeline({
  totalFrames, currentFrame, elementClips, layers, videoUrl, isPlaying,
  onFrameChange, onPlayToggle, onClipChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  // Keep latest callbacks in refs so event handlers don't go stale
  const onFrameChangeRef = useRef(onFrameChange);
  const onClipChangeRef = useRef(onClipChange);
  const totalFramesRef = useRef(totalFrames);
  useEffect(() => { onFrameChangeRef.current = onFrameChange; }, [onFrameChange]);
  useEffect(() => { onClipChangeRef.current = onClipChange; }, [onClipChange]);
  useEffect(() => { totalFramesRef.current = totalFrames; }, [totalFrames]);

  const xToFrame = useCallback((clientX: number): number => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const relX = clientX - rect.left - LABEL_W;
    const contentW = rect.width - LABEL_W;
    if (contentW <= 0) return 0;
    return Math.max(0, Math.min(totalFramesRef.current - 1, Math.round((relX / contentW) * totalFramesRef.current)));
  }, []);

  // Global mousemove/up for all drag types
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const tf = totalFramesRef.current;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const contentW = rect.width - LABEL_W;

      if (drag.type === 'playhead') {
        onFrameChangeRef.current(xToFrame(e.clientX));
      } else if (drag.type === 'clip') {
        const dF = Math.round(((e.clientX - drag.startX) / contentW) * tf);
        const clipLen = drag.origOut !== null ? drag.origOut - drag.origIn : tf - drag.origIn;
        const newIn = Math.max(0, Math.min(tf - clipLen, drag.origIn + dF));
        onClipChangeRef.current(drag.id, newIn, drag.origOut !== null ? newIn + clipLen : null);
      } else if (drag.type === 'clipIn') {
        const dF = Math.round(((e.clientX - drag.startX) / contentW) * tf);
        const maxIn = (drag.origOut ?? tf) - 1;
        const newIn = Math.max(0, Math.min(maxIn, drag.origIn + dF));
        onClipChangeRef.current(drag.id, newIn, drag.origOut);
      } else if (drag.type === 'clipOut') {
        const dF = Math.round(((e.clientX - drag.startX) / contentW) * tf);
        const rawOut = (drag.origOut ?? tf) + dF;
        const newOut = Math.max(drag.origIn + 1, Math.min(tf, rawOut));
        onClipChangeRef.current(drag.id, drag.origIn, newOut >= tf ? null : newOut);
      }
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [xToFrame]);

  const handleRulerDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { type: 'playhead' };
    onFrameChange(xToFrame(e.clientX));
  };

  const pct = (f: number) => `${(f / totalFrames) * 100}%`;

  // Ruler time markers — pick a sensible interval
  const interval = totalFrames <= 60 ? 5 : totalFrames <= 150 ? 15 : totalFrames <= 450 ? 30 : 60;
  const markers = Array.from({ length: Math.floor(totalFrames / interval) + 1 }, (_, i) => i * interval);

  const visibleLayers = (layers ?? []).filter(l => (elementClips ?? []).some(c => c.elementId === l.id));

  // Playhead X in the track area (right of label column) expressed as CSS calc
  const playheadLeft = `calc(${LABEL_W}px + (100% - ${LABEL_W}px) * ${currentFrame / Math.max(1, totalFrames)})`;

  return (
    <div
      className="border-t border-gray-800 bg-gray-950 flex flex-col select-none shrink-0"
      style={{ height: 200 }}
    >
      {/* ── Controls bar ─────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-3 shrink-0 border-b border-gray-800" style={{ height: 34 }}>
        <button
          className="text-gray-300 hover:text-white transition-colors text-sm w-5 text-center leading-none"
          onClick={onPlayToggle}
          title={isPlaying ? 'Pausar (Space)' : 'Reproduzir (Space)'}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>

        <span className="font-mono text-[11px] text-gray-300">
          {formatTime(currentFrame)}
          <span className="text-gray-600"> / {formatTime(totalFrames)}</span>
        </span>

        <span className="text-[10px] text-gray-700 ml-auto">30 fps · {(totalFrames / FPS).toFixed(1)}s</span>
      </div>

      {/* ── Track area ───────────────────────────────────────── */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto overflow-x-hidden relative"
      >
        {/* Ruler — sticky so it stays visible when scrolling many tracks */}
        <div
          className="flex sticky top-0 z-10 bg-gray-900 border-b border-gray-700 cursor-col-resize"
          style={{ height: RULER_H }}
          onMouseDown={handleRulerDown}
        >
          {/* Label spacer */}
          <div className="shrink-0 bg-gray-900 border-r border-gray-700" style={{ width: LABEL_W }} />

          {/* Ruler content */}
          <div className="flex-1 relative overflow-hidden">
            {markers.map(f => (
              <div
                key={f}
                className="absolute top-0 bottom-0 flex flex-col items-center justify-between"
                style={{ left: pct(f), transform: 'translateX(-50%)' }}
              >
                <span className="text-[9px] text-gray-600 leading-tight mt-0.5 whitespace-nowrap">
                  {formatTime(f)}
                </span>
                <div className="w-px h-2 bg-gray-600" />
              </div>
            ))}
            {/* Playhead indicator in ruler */}
            <div
              className="absolute top-0 bottom-0 w-px bg-red-500 z-20 pointer-events-none"
              style={{ left: pct(currentFrame) }}
            />
          </div>
        </div>

        {/* ── Video track ──────────────────────────────────── */}
        {videoUrl && (
          <div className="flex border-b border-gray-800" style={{ height: TRACK_H }}>
            <div
              className="shrink-0 flex items-center gap-1 px-2 text-[11px] text-gray-500 border-r border-gray-700"
              style={{ width: LABEL_W }}
            >
              <span>🎬</span>
              <span className="truncate">vídeo</span>
            </div>
            <div className="flex-1 relative bg-gray-950">
              <div className="absolute inset-y-3 left-0 right-0 rounded bg-sky-800/40 border border-sky-700/30" />
            </div>
          </div>
        )}

        {/* ── Element tracks ───────────────────────────────── */}
        {visibleLayers.map(layer => {
          const clip = elementClips.find(c => c.elementId === layer.id)!;
          const inPct = pct(clip.inFrame);
          const outF = clip.outFrame ?? totalFrames;
          const outPct = pct(outF);
          const displayLabel = (layer.text || layer.tag).slice(0, 14);

          return (
            <div key={layer.id} className="flex border-b border-gray-800" style={{ height: TRACK_H }}>
              {/* Label */}
              <div
                className="shrink-0 flex items-center gap-1.5 px-2 text-[11px] text-gray-400 border-r border-gray-700"
                style={{ width: LABEL_W }}
              >
                <span className="text-[9px] text-gray-700 font-mono shrink-0">{layer.id.slice(-4)}</span>
                <span className="truncate">{displayLabel}</span>
              </div>

              {/* Track content */}
              <div className="flex-1 relative bg-gray-950">
                {/* Clip bar */}
                <div
                  className="absolute inset-y-2 rounded bg-indigo-700/50 border border-indigo-600/40 hover:border-indigo-500/70 cursor-grab active:cursor-grabbing group"
                  style={{ left: inPct, right: `calc(100% - ${outPct})` }}
                  onMouseDown={e => {
                    e.stopPropagation();
                    e.preventDefault();
                    dragRef.current = { type: 'clip', id: layer.id, origIn: clip.inFrame, origOut: clip.outFrame, startX: e.clientX };
                  }}
                >
                  {/* In-point handle */}
                  <div
                    className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-indigo-300/20 rounded-l"
                    onMouseDown={e => {
                      e.stopPropagation();
                      e.preventDefault();
                      dragRef.current = { type: 'clipIn', id: layer.id, origIn: clip.inFrame, origOut: clip.outFrame, startX: e.clientX };
                    }}
                  />
                  {/* Out-point handle */}
                  <div
                    className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-indigo-300/20 rounded-r"
                    onMouseDown={e => {
                      e.stopPropagation();
                      e.preventDefault();
                      dragRef.current = { type: 'clipOut', id: layer.id, origIn: clip.inFrame, origOut: clip.outFrame, startX: e.clientX };
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })}

        {/* ── Playhead spanning all track rows ─────────────── */}
        <div
          className="absolute top-0 bottom-0 w-px bg-red-500/75 z-20 pointer-events-none"
          style={{ left: playheadLeft }}
        />
      </div>
    </div>
  );
}
