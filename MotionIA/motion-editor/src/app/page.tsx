'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import ImageUpload from '@/components/ImageUpload';
import VideoUpload from '@/components/VideoUpload';
import HtmlCanvas, { type HtmlCanvasHandle, type CanvasSize } from '@/components/HtmlCanvas';
import LayersPanel, { extractLayers, type Layer } from '@/components/LayersPanel';
import PropertiesPanel from '@/components/PropertiesPanel';
import AddElementPanel from '@/components/AddElementPanel';
import AnimateAllPanel from '@/components/AnimateAllPanel';
import Toolbar, { type EditorMode } from '@/components/Toolbar';
import Timeline from '@/components/Timeline';
import type { AnimationConfig, AnimDef } from '@/remotion/HtmlAnimator';
import type { ElementClip } from '@/lib/animation';

import type { SelectedElement } from '@/components/PropertiesPanel';

const RemotionPreview = dynamic(() => import('@/components/RemotionPreview'), {
  ssr: false,
  loading: () => null,
});

function calcCanvasSize(videoW: number, videoH: number, maxW = 800, maxH = 600): CanvasSize {
  const ratio = videoW / videoH;
  let w = maxW;
  let h = Math.round(w / ratio);
  if (h > maxH) { h = maxH; w = Math.round(h * ratio); }
  return { w, h };
}

export default function Home() {
  const [html, setHtml] = useState('');
  const [selectedElement, setSelectedElement] = useState<SelectedElement | null>(null);
  const [animationConfigs, setAnimationConfigs] = useState<AnimationConfig[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<EditorMode>('select');
  const [pendingAddPos, setPendingAddPos] = useState<{ x: number; y: number } | null>(null);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Video state
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ w: 800, h: 550 });

  // Timeline / playback state
  const [currentFrame, setCurrentFrame] = useState(0);
  const [elementClips, setElementClips] = useState<ElementClip[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showExport, setShowExport] = useState(false);

  const canvasRef    = useRef<HtmlCanvasHandle>(null);
  const historyStack = useRef<string[]>([]);
  const historyIdx   = useRef(-1);

  // ── Computed values ───────────────────────────────────────────────────────
  const videoDurationFrames = videoDuration > 0 ? Math.round(videoDuration * 30) : 0;

  const totalFrames = useMemo(() => {
    if (videoDurationFrames > 0) return videoDurationFrames;
    const animFrames = animationConfigs.flatMap(c => c.animations.map(a => a.endFrame));
    return Math.max(90, animFrames.length > 0 ? Math.max(...animFrames) + 15 : 0);
  }, [videoDurationFrames, animationConfigs]);

  // ── History ───────────────────────────────────────────────────────────────
  const syncHistoryState = () => {
    setCanUndo(historyIdx.current > 0);
    setCanRedo(historyIdx.current < historyStack.current.length - 1);
  };

  const pushHistory = useCallback((newHtml: string) => {
    historyStack.current = historyStack.current.slice(0, historyIdx.current + 1);
    historyStack.current.push(newHtml);
    historyIdx.current = historyStack.current.length - 1;
    syncHistoryState();
  }, []);

  const undo = useCallback(() => {
    if (historyIdx.current <= 0) return;
    historyIdx.current--;
    setHtml(historyStack.current[historyIdx.current]);
    syncHistoryState();
  }, []);

  const redo = useCallback(() => {
    if (historyIdx.current >= historyStack.current.length - 1) return;
    historyIdx.current++;
    setHtml(historyStack.current[historyIdx.current]);
    syncHistoryState();
  }, []);

  // ── Sync layers from HTML ─────────────────────────────────────────────────
  useEffect(() => {
    setLayers(extractLayers(html));
  }, [html]);

  // ── Sync elementClips when layers change ──────────────────────────────────
  useEffect(() => {
    setElementClips(prev => {
      const layerIds = new Set(layers.map(l => l.id));
      const filtered = prev.filter(c => layerIds.has(c.elementId));
      const existingIds = new Set(filtered.map(c => c.elementId));
      const newClips = layers
        .filter(l => !existingIds.has(l.id))
        .map(l => ({ elementId: l.id, inFrame: 0, outFrame: null } as ElementClip));
      return [...filtered, ...newClips];
    });
  }, [layers]);

  // ── Playback loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => {
      setCurrentFrame(f => {
        if (f >= totalFrames - 1) { setIsPlaying(false); return 0; }
        return f + 1;
      });
    }, 1000 / 30);
    return () => clearInterval(id);
  }, [isPlaying, totalFrames]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as Element;
      const inInput = target?.matches('input,textarea,[contenteditable]');

      if (e.key === ' ' && !inInput) {
        e.preventDefault();
        setIsPlaying(p => !p);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !inInput) {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo]);

  // ── Video handlers ────────────────────────────────────────────────────────
  const handleVideoUpload = ({ url, width, height, duration }: { url: string; width: number; height: number; duration: number }) => {
    setVideoUrl(url);
    setVideoDuration(duration);
    setCanvasSize(calcCanvasSize(width, height));
    setCurrentFrame(0);
    setIsPlaying(false);
  };

  const handleVideoClear = () => {
    setVideoUrl(null);
    setVideoDuration(0);
    setCanvasSize({ w: 800, h: 550 });
    setIsPlaying(false);
  };

  // ── HTML / image handlers ─────────────────────────────────────────────────
  const handleImageUpload = async (base64: string, mimeType: string) => {
    setIsGenerating(true);
    setError('');
    setAnimationConfigs([]);
    setSelectedElement(null);
    setPendingAddPos(null);
    setCurrentFrame(0);
    setIsPlaying(false);
    try {
      const res = await fetch('/api/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, mimeType }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setHtml(data.html);
      pushHistory(data.html);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Erro ao gerar HTML');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAnimate = async (elementId: string, elementHtml: string, description: string) => {
    const res = await fetch('/api/animate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ elementId, elementHtml, description }),
    });
    const config = await res.json();
    if (config.error) throw new Error(config.error);
    setAnimationConfigs((prev) => {
      const filtered = prev.filter((c) => c.elementId !== elementId);
      return [...filtered, config as AnimationConfig];
    });
  };

  const handleHtmlChange = (newHtml: string) => {
    setHtml(newHtml);
    pushHistory(newHtml);
    if (mode === 'delete') setSelectedElement(null);
  };

  const handleAddAt = (x: number, y: number) => setPendingAddPos({ x, y });

  const handleInsertElement = (elementHtml: string) => {
    if (!pendingAddPos) return;
    canvasRef.current?.insertElement(elementHtml, pendingAddPos.x, pendingAddPos.y);
    setPendingAddPos(null);
  };

  const handleUpdateAnimation = useCallback((updated: AnimationConfig) => {
    setAnimationConfigs((prev) =>
      prev.map((c) => (c.elementId === updated.elementId ? updated : c)),
    );
  }, []);

  // ── Style / text / animDef handlers ──────────────────────────────────────
  const handleStyleUpdate = useCallback((elementId: string, updates: Record<string, string>) => {
    if (!html) return;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const el  = doc.querySelector(`[data-element-id="${elementId}"]`) as HTMLElement | null;
    if (!el) return;
    for (const [prop, value] of Object.entries(updates)) {
      if (value) el.style.setProperty(prop, value);
      else el.style.removeProperty(prop);
    }
    const updated = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
    setHtml(updated);
    pushHistory(updated);
  }, [html, pushHistory]);

  const handleTextUpdate = useCallback((elementId: string, newText: string) => {
    if (!html) return;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const el = doc.querySelector(`[data-element-id="${elementId}"]`);
    if (!el) return;
    if (el.children.length === 0) {
      el.textContent = newText;
    } else {
      const textNode = Array.from(el.childNodes).find(
        n => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim(),
      );
      if (textNode) textNode.textContent = newText;
      else el.prepend(document.createTextNode(newText));
    }
    const updated = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
    setHtml(updated);
    pushHistory(updated);
  }, [html, pushHistory]);

  const handleAnimDefAdd = useCallback((elementId: string, def: AnimDef) => {
    setAnimationConfigs(prev => {
      const existing = prev.find(c => c.elementId === elementId);
      if (existing) {
        return prev.map(c =>
          c.elementId === elementId
            ? { ...c, animations: [...c.animations, def], durationFrames: Math.max(c.durationFrames ?? 0, def.endFrame + 15) }
            : c,
        );
      }
      return [...prev, { elementId, animations: [def], durationFrames: def.endFrame + 15 }];
    });
  }, []);

  const handleAnimDefUpdate = useCallback((elementId: string, idx: number, def: AnimDef) => {
    setAnimationConfigs(prev =>
      prev.map(c =>
        c.elementId === elementId
          ? {
              ...c,
              animations: c.animations.map((a, i) => i === idx ? def : a),
              durationFrames: Math.max(...c.animations.map((a, i) => (i === idx ? def : a).endFrame + 15)),
            }
          : c,
      ),
    );
  }, []);

  const handleAnimDefDelete = useCallback((elementId: string, idx: number) => {
    setAnimationConfigs(prev =>
      prev
        .map(c =>
          c.elementId === elementId
            ? { ...c, animations: c.animations.filter((_, i) => i !== idx) }
            : c,
        )
        .filter(c => c.animations.length > 0),
    );
  }, []);

  // ── Timeline handlers ─────────────────────────────────────────────────────
  const handleClipChange = useCallback((elementId: string, inFrame: number, outFrame: number | null) => {
    setElementClips(prev => prev.map(c => c.elementId === elementId ? { ...c, inFrame, outFrame } : c));
  }, []);

  // ── Layer / mode handlers ─────────────────────────────────────────────────
  const handleLayerSelect = (layer: Layer) => {
    setMode('select');
    setSelectedElement({ id: layer.id, html: layer.outerHtml });
    setPendingAddPos(null);
  };

  const handleModeChange = (newMode: EditorMode) => {
    setMode(newMode);
    setPendingAddPos(null);
    if (newMode !== 'select') setSelectedElement(null);
  };

  const animatedIds = new Set(animationConfigs.map((c) => c.elementId));

  const selectedAnimConfig = useMemo(
    () => animationConfigs.find(c => c.elementId === selectedElement?.id),
    [animationConfigs, selectedElement?.id],
  );

  const showTimeline = !!(videoUrl || html);

  return (
    <div className="flex h-screen bg-gray-950 text-white overflow-hidden">
      {/* ── Left sidebar ── */}
      <div className="w-56 border-r border-gray-800 flex flex-col shrink-0 overflow-y-auto">
        <VideoUpload
          videoUrl={videoUrl}
          onUpload={handleVideoUpload}
          onClear={handleVideoClear}
        />

        <ImageUpload onUpload={handleImageUpload} isLoading={isGenerating} />

        <LayersPanel
          layers={layers}
          animatedIds={animatedIds}
          selectedId={selectedElement?.id ?? null}
          onSelect={handleLayerSelect}
        />

        {error && (
          <div className="mx-3 p-2 rounded bg-red-900/30 border border-red-800 text-xs text-red-300">
            {error}
          </div>
        )}
      </div>

      {/* ── Center: toolbar + canvas + timeline ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {(html || videoUrl) && (
          <Toolbar
            mode={mode}
            onChange={handleModeChange}
            disabled={isGenerating}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
          />
        )}

        <HtmlCanvas
          ref={canvasRef}
          html={html}
          animationConfigs={animationConfigs}
          selectedElementId={selectedElement?.id ?? null}
          mode={mode}
          videoUrl={videoUrl}
          canvasSize={canvasSize}
          currentFrame={currentFrame}
          elementClips={elementClips}
          totalFrames={totalFrames}
          onSelectElement={setSelectedElement}
          onHtmlChange={handleHtmlChange}
          onAddAt={handleAddAt}
        />

        {showTimeline && (
          <Timeline
            totalFrames={totalFrames}
            currentFrame={currentFrame}
            elementClips={elementClips}
            layers={layers}
            videoUrl={videoUrl}
            isPlaying={isPlaying}
            onFrameChange={setCurrentFrame}
            onPlayToggle={() => setIsPlaying(p => !p)}
            onClipChange={handleClipChange}
          />
        )}
      </div>

      {/* ── Right panel ── */}
      <div className="w-72 border-l border-gray-800 flex flex-col shrink-0 overflow-y-auto">
        <AnimateAllPanel html={html} onApply={(configs) => setAnimationConfigs(configs)} />

        {mode === 'add' ? (
          <AddElementPanel pendingPos={pendingAddPos} onInsert={handleInsertElement} />
        ) : (
          <PropertiesPanel
            selectedElement={selectedElement}
            animationConfig={selectedAnimConfig}
            animatedIds={animatedIds}
            onAnimate={handleAnimate}
            onTextUpdate={handleTextUpdate}
            onStyleUpdate={handleStyleUpdate}
            onAnimDefAdd={handleAnimDefAdd}
            onAnimDefUpdate={handleAnimDefUpdate}
            onAnimDefDelete={handleAnimDefDelete}
          />
        )}

        {/* Export button */}
        {(html || videoUrl) && (
          <div className="px-3 py-2 border-t border-gray-800 shrink-0">
            <button
              className="w-full text-xs py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
              onClick={() => setShowExport(p => !p)}
            >
              {showExport ? '▲ ocultar exportação' : '▼ exportar vídeo'}
            </button>
          </div>
        )}

        {showExport && (
          <RemotionPreview
            html={html}
            animationConfigs={animationConfigs}
            videoSrc={videoUrl}
            compositionWidth={canvasSize.w}
            compositionHeight={canvasSize.h}
            videoDurationFrames={videoDurationFrames}
            elementClips={elementClips}
          />
        )}
      </div>
    </div>
  );
}
