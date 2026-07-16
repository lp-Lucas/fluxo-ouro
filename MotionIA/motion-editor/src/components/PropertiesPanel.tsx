'use client';

import { useState, useEffect, useCallback } from 'react';
import type { AnimationConfig, AnimDef } from '@/remotion/HtmlAnimator';
import type { ElemComputedStyle } from './HtmlCanvas';

export interface SelectedElement {
  id: string;
  html: string;
  computedStyle?: ElemComputedStyle;
}

/* ─── helpers ───────────────────────────────────────────────────────────── */
function getElementText(outerHtml: string): string {
  if (!outerHtml || typeof window === 'undefined') return '';
  try {
    const div = document.createElement('div');
    div.innerHTML = outerHtml;
    return (div.textContent ?? '').trim();
  } catch { return ''; }
}

function rgbToHex(rgb: string): string {
  if (!rgb || rgb === 'transparent' || rgb === 'rgba(0, 0, 0, 0)') return '';
  if (rgb.startsWith('#')) return rgb.toLowerCase();
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return '';
  return '#' + [m[1], m[2], m[3]].map(v => parseInt(v).toString(16).padStart(2, '0')).join('');
}

function parsePx(val: string): string {
  if (!val || val === 'auto' || val === 'none' || val === '0px') return '';
  return val.replace('px', '').trim();
}

/* ─── animation property defs ───────────────────────────────────────────── */
type PropKey = 'translateX' | 'translateY' | 'scale' | 'rotate' | 'opacity';

interface PropDef {
  key: PropKey;
  label: string;
  unit: string;
  displayUnit: string;
  quickFrom: number;
  quickTo: number;
  toDisplay: (v: number) => number;
  fromDisplay: (v: number) => number;
}

const ANIM_PROPS: PropDef[] = [
  { key: 'translateX', label: 'Posição X', unit: 'px', displayUnit: 'px', quickFrom: -80, quickTo: 0, toDisplay: v => Math.round(v), fromDisplay: v => v },
  { key: 'translateY', label: 'Posição Y', unit: 'px', displayUnit: 'px', quickFrom: 80,  quickTo: 0, toDisplay: v => Math.round(v), fromDisplay: v => v },
  { key: 'scale',      label: 'Escala',    unit: '',   displayUnit: '%',  quickFrom: 0,   quickTo: 100, toDisplay: v => Math.round(v * 100), fromDisplay: v => v / 100 },
  { key: 'rotate',     label: 'Rotação',   unit: 'deg',displayUnit: '°',  quickFrom: 180, quickTo: 0, toDisplay: v => Math.round(v), fromDisplay: v => v },
  { key: 'opacity',    label: 'Opacidade', unit: '',   displayUnit: '%',  quickFrom: 0,   quickTo: 100, toDisplay: v => Math.round(v * 100), fromDisplay: v => v / 100 },
];

const PRESETS = ['Surge de baixo', 'Fade in suave', 'Pop escala', 'Slide esquerda', 'Rotação'];

/* ─── inline editable AnimDef row ───────────────────────────────────────── */
function AnimDefRow({ anim, prop, onChange, onDelete }: {
  anim: AnimDef;
  prop: PropDef;
  onChange: (u: AnimDef) => void;
  onDelete: () => void;
}) {
  const [fv, setFv] = useState(String(prop.toDisplay(anim.from)));
  const [tv, setTv] = useState(String(prop.toDisplay(anim.to)));
  const [sf, setSf] = useState(String(anim.startFrame));
  const [ef, setEf] = useState(String(anim.endFrame));
  const [ea, setEa] = useState<'spring' | 'ease'>(anim.type);

  useEffect(() => {
    setFv(String(prop.toDisplay(anim.from)));
    setTv(String(prop.toDisplay(anim.to)));
    setSf(String(anim.startFrame));
    setEf(String(anim.endFrame));
    setEa(anim.type);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anim.from, anim.to, anim.startFrame, anim.endFrame, anim.type]);

  const commit = useCallback(() => {
    const s = parseInt(sf) || 0;
    const e = Math.max(parseInt(ef) || 30, s + 1);
    onChange({ ...anim, from: prop.fromDisplay(parseFloat(fv) || 0), to: prop.fromDisplay(parseFloat(tv) || 0), startFrame: s, endFrame: e, type: ea });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fv, tv, sf, ef, ea]);

  const ni = (val: string, set: (v: string) => void, color: string, w = 'w-11') => (
    <input type="number" value={val} onChange={e => set(e.target.value)} onBlur={commit}
      onKeyDown={e => e.key === 'Enter' && commit()}
      className={`${w} bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-[10px] ${color} font-mono focus:outline-none focus:border-indigo-500 text-center`} />
  );

  return (
    <div className="flex items-center gap-1 px-2 py-1 rounded bg-gray-900/60 group text-[10px]">
      <span className="text-gray-600 shrink-0">f</span>
      {ni(sf, setSf, 'text-sky-500', 'w-9')}
      <span className="text-gray-600">→</span>
      {ni(ef, setEf, 'text-amber-500', 'w-9')}
      <span className="text-gray-600 ml-1">val</span>
      {ni(fv, setFv, 'text-blue-300')}
      <span className="text-gray-600">→</span>
      {ni(tv, setTv, 'text-blue-300')}
      <span className="text-gray-500 shrink-0">{prop.displayUnit}</span>
      <select value={ea} onChange={e => { setEa(e.target.value as 'spring' | 'ease'); setTimeout(commit, 0); }}
        className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-[9px] text-gray-500 focus:outline-none">
        <option value="spring">spring</option>
        <option value="ease">ease</option>
      </select>
      <button onClick={onDelete}
        className="text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all ml-0.5 shrink-0">✕</button>
    </div>
  );
}

/* ─── style editor section ───────────────────────────────────────────────── */
function StyleEditor({ cs, onApply }: {
  cs: ElemComputedStyle | undefined;
  onApply: (updates: Record<string, string>) => void;
}) {
  const [width,   setWidth]  = useState('');
  const [height,  setHeight] = useState('');
  const [bgColor, setBgColor] = useState('');
  const [fgColor, setFgColor] = useState('');
  const [fSize,   setFSize]  = useState('');
  const [bRadius, setBRadius] = useState('');

  useEffect(() => {
    if (!cs) return;
    setWidth(parsePx(cs.width));
    setHeight(parsePx(cs.height));
    setBgColor(rgbToHex(cs.backgroundColor));
    setFgColor(rgbToHex(cs.color));
    setFSize(parsePx(cs.fontSize));
    setBRadius(parsePx(cs.borderRadius));
  }, [cs]);

  const apply = (updates: Record<string, string>) => onApply(updates);

  const numInput = (
    label: string,
    val: string,
    set: (v: string) => void,
    prop: string,
    unit = 'px',
  ) => (
    <div className="flex flex-col gap-0.5">
      <span className="text-[9px] text-gray-600 uppercase tracking-wider">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          value={val}
          onChange={e => set(e.target.value)}
          onBlur={() => apply({ [prop]: val ? `${val}${unit}` : '' })}
          onKeyDown={e => e.key === 'Enter' && apply({ [prop]: val ? `${val}${unit}` : '' })}
          placeholder="auto"
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[10px] text-white font-mono focus:outline-none focus:border-indigo-500"
        />
        <span className="text-[9px] text-gray-600 shrink-0">{unit}</span>
      </div>
    </div>
  );

  const colorInput = (
    label: string,
    val: string,
    set: (v: string) => void,
    prop: string,
  ) => (
    <div className="flex flex-col gap-0.5">
      <span className="text-[9px] text-gray-600 uppercase tracking-wider">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={val || '#000000'}
          onChange={e => { set(e.target.value); apply({ [prop]: e.target.value }); }}
          className="w-7 h-7 rounded cursor-pointer border border-gray-700 bg-gray-800 p-0.5"
        />
        <input
          type="text"
          value={val}
          onChange={e => set(e.target.value)}
          onBlur={() => { if (/^#[0-9a-fA-F]{6}$/.test(val)) apply({ [prop]: val }); }}
          placeholder="#000000"
          className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[10px] text-white font-mono focus:outline-none focus:border-indigo-500"
        />
      </div>
    </div>
  );

  return (
    <div className="px-3 py-3 flex flex-col gap-3">
      <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Estilo</span>

      {/* Dimensions */}
      <div className="grid grid-cols-2 gap-2">
        {numInput('Largura', width, setWidth, 'width')}
        {numInput('Altura',  height, setHeight, 'height')}
      </div>

      {/* Colors */}
      <div className="grid grid-cols-1 gap-2">
        {colorInput('Cor de fundo', bgColor, setBgColor, 'background-color')}
        {colorInput('Cor do texto', fgColor, setFgColor, 'color')}
      </div>

      {/* Font + border */}
      <div className="grid grid-cols-2 gap-2">
        {numInput('Fonte', fSize, setFSize, 'font-size')}
        {numInput('Borda r.', bRadius, setBRadius, 'border-radius')}
      </div>

      {cs && (
        <div className="text-[9px] text-gray-700">
          Tamanho atual: {cs.width} × {cs.height}
        </div>
      )}
    </div>
  );
}

/* ─── main props ─────────────────────────────────────────────────────────── */
interface Props {
  selectedElement: SelectedElement | null;
  animationConfig: AnimationConfig | undefined;
  animatedIds: Set<string>;
  onAnimate: (elementId: string, elementHtml: string, description: string) => Promise<void>;
  onTextUpdate: (elementId: string, text: string) => void;
  onStyleUpdate: (elementId: string, updates: Record<string, string>) => void;
  onAnimDefAdd: (elementId: string, def: AnimDef) => void;
  onAnimDefUpdate: (elementId: string, idx: number, def: AnimDef) => void;
  onAnimDefDelete: (elementId: string, idx: number) => void;
}

/* ═══════════════════════════════════════════════════════════════════════════
   PropertiesPanel
   ═══════════════════════════════════════════════════════════════════════════ */
export default function PropertiesPanel({
  selectedElement, animationConfig, animatedIds,
  onAnimate, onTextUpdate, onStyleUpdate,
  onAnimDefAdd, onAnimDefUpdate, onAnimDefDelete,
}: Props) {
  const [editText,    setEditText]    = useState('');
  const [description, setDescription] = useState('');
  const [isAnimating, setIsAnimating] = useState(false);
  const [animMsg,     setAnimMsg]     = useState('');

  useEffect(() => {
    if (!selectedElement) { setEditText(''); return; }
    setEditText(getElementText(selectedElement.html));
    setAnimMsg('');
  }, [selectedElement?.id]);

  if (!selectedElement) {
    return (
      <div className="flex flex-col p-4 gap-3">
        <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Propriedades</div>
        <div className="text-xs text-gray-600">Selecione um elemento no canvas para editar.</div>
      </div>
    );
  }

  const { id, html: elementHtml, computedStyle } = selectedElement;
  const existingAnims = animationConfig?.animations ?? [];

  const handleQuickAdd = (key: PropKey) => {
    const def = ANIM_PROPS.find(p => p.key === key)!;
    onAnimDefAdd(id, {
      property: key, unit: def.unit,
      from: def.fromDisplay(def.quickFrom), to: def.fromDisplay(def.quickTo),
      startFrame: 0, endFrame: 30, type: 'spring',
    });
  };

  const handleAnimate = async () => {
    if (!description.trim()) return;
    setIsAnimating(true); setAnimMsg('');
    try {
      await onAnimate(id, elementHtml, description);
      setAnimMsg('✓ Animação aplicada');
      setDescription('');
    } catch (e: unknown) {
      setAnimMsg('✗ ' + (e instanceof Error ? e.message : 'Erro'));
    } finally { setIsAnimating(false); }
  };

  return (
    <div className="flex flex-col divide-y divide-gray-800/60">

      {/* header */}
      <div className="px-3 py-2 flex items-center gap-2 bg-gray-900/40">
        <div className="w-2 h-2 rounded-full bg-indigo-400 shrink-0" />
        <span className="text-[11px] font-mono text-indigo-300 truncate">{id}</span>
        {animatedIds.has(id) && <span className="ml-auto text-[9px] text-emerald-400 shrink-0">● animado</span>}
      </div>

      {/* text editing */}
      {editText !== '' && (
        <div className="px-3 py-3 flex flex-col gap-2">
          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Texto</span>
          <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={2}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white resize-none focus:outline-none focus:border-indigo-500 transition-colors" />
          <button onClick={() => onTextUpdate(id, editText)}
            className="self-end text-[10px] px-3 py-1 rounded-lg bg-indigo-700 hover:bg-indigo-600 transition-colors font-medium">
            Atualizar texto
          </button>
        </div>
      )}

      {/* style editor — dimensions + colors */}
      <StyleEditor
        cs={computedStyle}
        onApply={updates => onStyleUpdate(id, updates)}
      />

      {/* animation keyframes */}
      <div className="px-3 py-3 flex flex-col gap-3">
        <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Animação</span>

        {ANIM_PROPS.map(prop => {
          const related = existingAnims
            .map((a, i) => ({ anim: a, i }))
            .filter(({ anim }) => anim.property === prop.key);

          return (
            <div key={prop.key} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-gray-500 w-20 shrink-0">{prop.label}</span>
                <span className="text-[9px] text-gray-700 flex-1">
                  {related.length === 0 ? '—' : `${related.length} keyframe${related.length > 1 ? 's' : ''}`}
                </span>
                <button onClick={() => handleQuickAdd(prop.key)}
                  className="text-[9px] px-1.5 py-0.5 rounded bg-gray-800 hover:bg-indigo-700 text-gray-500 hover:text-white transition-colors shrink-0">
                  + animar
                </button>
              </div>
              {related.map(({ anim, i }) => (
                <AnimDefRow key={i} anim={anim} prop={prop}
                  onChange={updated => onAnimDefUpdate(id, i, updated)}
                  onDelete={() => onAnimDefDelete(id, i)} />
              ))}
            </div>
          );
        })}
      </div>

      {/* AI animation */}
      <div className="px-3 py-3 flex flex-col gap-2">
        <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Animar com IA</span>
        <textarea value={description} onChange={e => setDescription(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleAnimate(); }}
          placeholder="Descreva a animação… (Ctrl+Enter)" rows={2} disabled={isAnimating}
          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-600 resize-none focus:outline-none focus:border-indigo-500 disabled:opacity-40 transition-colors" />
        <div className="flex flex-wrap gap-1">
          {PRESETS.map(p => (
            <button key={p} onClick={() => setDescription(p)}
              className="text-[9px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-500 hover:text-gray-300 hover:bg-gray-700 transition-colors">
              {p}
            </button>
          ))}
        </div>
        <button onClick={handleAnimate} disabled={!description.trim() || isAnimating}
          className="py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          {isAnimating ? 'Gerando…' : 'Animar'}
        </button>
        {animMsg && (
          <div className={`text-[10px] ${animMsg.startsWith('✓') ? 'text-emerald-400' : 'text-red-400'}`}>{animMsg}</div>
        )}
      </div>
    </div>
  );
}
