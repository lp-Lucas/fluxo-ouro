import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FlowAspect } from "../../../../shared/flow";

/**
 * CANVAS DE ESBOÇO (opção "Esboço" da geração de telas): o usuário desenha o BLUEPRINT da
 * tela — posição/escala/texto dos elementos, espaço negativo. O PNG do artboard vira a
 * restrição GEOMÉTRICA do gerador (modo "esboco" do compilador).
 *
 * Reescrito do zero em <canvas> puro (saiu o tldraw: exigia licença, os assets dele davam
 * bloqueio/tela-preta sob o subpath do OS, e pesava ~2.2MB no bundle). Zero dependência
 * externa, zero asset remoto — funciona igual em localhost e sob o proxy do OS.
 *
 * Ferramentas: seleção (mover/redimensionar), caneta, retângulo, elipse, seta, texto,
 * borracha · grid+snap · cores · undo/redo · zoom+pan · duplicar (Ctrl+D) · export PNG.
 * Persistência: snapshot JSON na frase (onUse) + autosave local por frase (não perde num
 * remount).
 */

const DIMS: Record<FlowAspect, { w: number; h: number }> = {
  "9:16": { w: 540, h: 960 },
  "16:9": { w: 960, h: 540 },
  "1:1": { w: 720, h: 720 },
};
const GRID = 20;
const HANDLE = 6; // raio de acerto dos punhos de resize (px de tela)
const PALETTE = ["#111111", "#e5484d", "#2563eb", "#16a34a", "#f59e0b", "#8b5cf6", "#ec4899", "#ffffff"];

type Pt = { x: number; y: number };
type BBox = { x: number; y: number; w: number; h: number };
type Tool = "select" | "pen" | "rect" | "ellipse" | "arrow" | "text" | "eraser" | "pan";
type RectS = { id: string; type: "rect" | "ellipse"; x: number; y: number; w: number; h: number; stroke: string; sw: number; fill: string };
type ArrowS = { id: string; type: "arrow"; x: number; y: number; w: number; h: number; stroke: string; sw: number };
type PenS = { id: string; type: "pen"; pts: Pt[]; stroke: string; sw: number };
type TextS = { id: string; type: "text"; x: number; y: number; text: string; size: number; color: string };
type ImageS = { id: string; type: "image"; x: number; y: number; w: number; h: number; src: string };
type Shape = RectS | ArrowS | PenS | TextS | ImageS;
type View = { tx: number; ty: number; scale: number };
type Drag =
  | { mode: "pan"; startS: Pt; startV: View }
  | { mode: "pen"; id: string }
  | { mode: "erase" }
  | { mode: "create"; id: string; start: Pt }
  | { mode: "move"; id: string; startW: Pt; orig: Shape }
  | { mode: "resize"; id: string; handle: string; start: BBox; orig: Shape };

const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));

// medidor de texto (offscreen) — bbox do texto p/ seleção/resize/export
const _m = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
const fontOf = (size: number) => `600 ${size}px Inter, system-ui, sans-serif`;
function textBBox(s: TextS): BBox {
  const lines = s.text.split("\n");
  let w = 8;
  if (_m) { _m.font = fontOf(s.size); for (const l of lines) w = Math.max(w, _m.measureText(l || " ").width); }
  return { x: s.x, y: s.y, w, h: Math.max(1, lines.length) * s.size * 1.25 };
}
function getBBox(s: Shape): BBox {
  if (s.type === "pen") {
    const xs = s.pts.map((p) => p.x), ys = s.pts.map((p) => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y) };
  }
  if (s.type === "text") return textBBox(s);
  const x = Math.min(s.x, s.x + s.w), y = Math.min(s.y, s.y + s.h);
  return { x, y, w: Math.max(1, Math.abs(s.w)), h: Math.max(1, Math.abs(s.h)) };
}
function setBBox(s: Shape, nb: BBox): Shape {
  const ob = getBBox(s), fx = nb.w / (ob.w || 1), fy = nb.h / (ob.h || 1);
  if (s.type === "pen") { s.pts = s.pts.map((p) => ({ x: nb.x + (p.x - ob.x) * fx, y: nb.y + (p.y - ob.y) * fy })); return s; }
  if (s.type === "text") { s.x = nb.x; s.y = nb.y; s.size = Math.max(6, s.size * fy); return s; }
  s.x = nb.x; s.y = nb.y; s.w = nb.w; s.h = nb.h; return s;
}
function translate(s: Shape, dx: number, dy: number): Shape {
  if (s.type === "pen") s.pts = s.pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  else { s.x += dx; s.y += dy; }
  return s;
}
function distSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Ícones (SVG inline, stroke = currentColor) — zero asset externo, peso consistente.
const ICONS: Record<string, React.ReactNode> = {
  select: <path d="M5 4l13 6.5-5.4 1.6L10 18z" />,
  pen: <path d="M4.5 15.5l8-8 3 3-8 8h-3z" />,
  rect: <rect x="4" y="6" width="15" height="11" rx="1.5" />,
  ellipse: <ellipse cx="11.5" cy="11.5" rx="8" ry="6" />,
  arrow: <path d="M5 18L18 5M18 5h-6.5M18 5v6.5" />,
  text: <path d="M5 6V4.5h13V6M11.5 4.5V18.5M9 18.5h5" />,
  eraser: <path d="M9 18l-4-4a1.5 1.5 0 010-2l7-7a1.5 1.5 0 012 0l3 3a1.5 1.5 0 010 2l-6 6H9zM8.5 12.5l4 4" />,
  pan: <path d="M8 11V6a1.4 1.4 0 012.8 0v4.5m0-1v-2a1.4 1.4 0 012.8 0v3m0-1.5a1.4 1.4 0 012.8 0V14a5.5 5.5 0 01-5.5 5.5h-1a5.5 5.5 0 01-4.3-2.1l-2.4-3.1a1.4 1.4 0 012.2-1.8L8 13" />,
  image: <><rect x="3.5" y="5.5" width="16" height="12" rx="1.5" /><circle cx="8.5" cy="10" r="1.6" /><path d="M4.5 16l4.5-4 3.5 3 3-2.5 3.5 3.5" /></>,
  undo: <path d="M8 8H4.5V4.5M5 11.5a6.5 6.5 0 116.5 6.5" />,
  redo: <path d="M14 8h3.5V4.5M17 11.5A6.5 6.5 0 1010.5 18" />,
  dup: <><rect x="7" y="7" width="11" height="11" rx="1.5" /><path d="M4 13V4h9" /></>,
  trash: <path d="M4.5 6.5h13M9 6.5V4h4v2.5M6.5 6.5l1 12h7l1-12" />,
  grid: <path d="M4 9h15M4 14h15M9 4v15M14 4v15" />,
  fit: <path d="M4 8V4h4M18 8V4h-4M4 14v4h4M18 14v4h-4" />,
};
const Icon = ({ name, w = 18 }: { name: string; w?: number }) => (
  <svg width={w} height={w} viewBox="0 0 23 23" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{ICONS[name]}</svg>
);

export function SketchCanvas({ aspect, snapshot, phraseId, onUse, onClose }: {
  aspect: FlowAspect;
  /** snapshot salvo na frase (JSON deste editor) — reabre o esboço onde parou. */
  snapshot?: string;
  /** id da frase — chave da persistência local (não perde o desenho num remount). */
  phraseId: string;
  /** "Usar esboço": PNG do artboard (dataURL) + snapshot p/ persistir. */
  onUse: (png: string, snapshot: string) => void;
  onClose: () => void;
}) {
  const art = DIMS[aspect];
  const lsKey = `flow-sketch-${phraseId}`;

  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState("#111111");
  const [fill, setFill] = useState(false);
  const [snap, setSnap] = useState(true);
  const [zoom, setZoom] = useState(100);
  const [strokeW, setStrokeW] = useState(3);
  const [editing, setEditing] = useState<string | null>(null);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const scene = useRef<Shape[]>([]);
  const view = useRef<View>({ tx: 0, ty: 0, scale: 1 });
  const sel = useRef<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const size = useRef({ w: 0, h: 0 });
  const space = useRef(false);
  const undoS = useRef<string[]>([]);
  const redoS = useRef<string[]>([]);
  const raf = useRef<number | undefined>(undefined);

  // refs "vivos" p/ handlers que não devem recriar (tool/color/etc mudam sem re-attach)
  const toolR = useRef(tool); toolR.current = tool;
  const colorR = useRef(color); colorR.current = color;
  const fillR = useRef(fill); fillR.current = fill;
  const snapR = useRef(snap); snapR.current = snap;
  const editingR = useRef(editing); editingR.current = editing;
  const strokeWR = useRef(strokeW); strokeWR.current = strokeW;
  const imgCache = useRef<Map<string, HTMLImageElement>>(new Map());
  const fileInput = useRef<HTMLInputElement | null>(null);

  const find = (id: string | null) => scene.current.find((s) => s.id === id);
  const snapV = (v: number) => (snapR.current ? Math.round(v / GRID) * GRID : v);
  const w2s = (x: number, y: number) => ({ x: x * view.current.scale + view.current.tx, y: y * view.current.scale + view.current.ty });
  const s2w = (x: number, y: number) => ({ x: (x - view.current.tx) / view.current.scale, y: (y - view.current.ty) / view.current.scale });

  const serialize = () => JSON.stringify({ v: 1, aspect, shapes: scene.current });
  const saveLocal = useCallback(() => { try { localStorage.setItem(lsKey, serialize()); } catch { /* quota */ } }, [lsKey, aspect]);
  const pushUndo = () => { undoS.current.push(serialize()); if (undoS.current.length > 80) undoS.current.shift(); redoS.current = []; };

  // ---------- desenho ----------
  const drawShape = (ctx: CanvasRenderingContext2D, s: Shape) => {
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    if (s.type === "rect") {
      ctx.lineWidth = s.sw;
      if (s.fill !== "none") { ctx.fillStyle = s.fill; ctx.fillRect(s.x, s.y, s.w, s.h); }
      ctx.strokeStyle = s.stroke; ctx.strokeRect(s.x, s.y, s.w, s.h);
    } else if (s.type === "ellipse") {
      ctx.lineWidth = s.sw; ctx.beginPath();
      ctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.abs(s.w / 2), Math.abs(s.h / 2), 0, 0, Math.PI * 2);
      if (s.fill !== "none") { ctx.fillStyle = s.fill; ctx.fill(); }
      ctx.strokeStyle = s.stroke; ctx.stroke();
    } else if (s.type === "arrow") {
      const x2 = s.x + s.w, y2 = s.y + s.h, a = Math.atan2(y2 - s.y, x2 - s.x), hl = Math.max(9, s.sw * 3.2);
      ctx.strokeStyle = s.stroke; ctx.fillStyle = s.stroke; ctx.lineWidth = s.sw;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - hl * Math.cos(a - 0.42), y2 - hl * Math.sin(a - 0.42));
      ctx.lineTo(x2 - hl * Math.cos(a + 0.42), y2 - hl * Math.sin(a + 0.42));
      ctx.closePath(); ctx.fill();
    } else if (s.type === "pen") {
      ctx.lineWidth = s.sw; ctx.strokeStyle = s.stroke; ctx.beginPath();
      s.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    } else if (s.type === "text") {
      ctx.fillStyle = s.color; ctx.textBaseline = "top"; ctx.font = fontOf(s.size);
      s.text.split("\n").forEach((l, i) => ctx.fillText(l, s.x, s.y + i * s.size * 1.25));
    } else if (s.type === "image") {
      const img = imgCache.current.get(s.src);
      if (img && img.complete && img.naturalWidth) ctx.drawImage(img, s.x, s.y, s.w, s.h);
      else { ctx.fillStyle = "rgba(0,0,0,0.05)"; ctx.fillRect(s.x, s.y, s.w, s.h); ctx.strokeStyle = "rgba(0,0,0,0.2)"; ctx.lineWidth = 1; ctx.strokeRect(s.x, s.y, s.w, s.h); }
    }
  };

  const draw = useCallback(() => {
    const cv = canvasRef.current; if (!cv) return;
    const ctx = cv.getContext("2d"); if (!ctx) return;
    const dpr = window.devicePixelRatio || 1, { w: cw, h: ch } = size.current, v = view.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch); ctx.fillStyle = "#26262b"; ctx.fillRect(0, 0, cw, ch);
    // espaço do artboard (world)
    ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.tx, dpr * v.ty);
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, art.w, art.h);
    ctx.strokeStyle = "rgba(0,0,0,0.06)"; ctx.lineWidth = 1 / v.scale; ctx.beginPath();
    for (let x = 0; x <= art.w; x += GRID) { ctx.moveTo(x, 0); ctx.lineTo(x, art.h); }
    for (let y = 0; y <= art.h; y += GRID) { ctx.moveTo(0, y); ctx.lineTo(art.w, y); }
    ctx.stroke();
    ctx.save(); ctx.beginPath(); ctx.rect(-2, -2, art.w + 4, art.h + 4); ctx.clip();
    for (const s of scene.current) drawShape(ctx, s);
    ctx.restore();
    ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 1 / v.scale; ctx.strokeRect(0, 0, art.w, art.h);
    // punhos de seleção (screen space)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = find(sel.current);
    if (s && toolR.current === "select") {
      const bb = getBBox(s), tl = w2s(bb.x, bb.y), br = w2s(bb.x + bb.w, bb.y + bb.h);
      ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 1.5;
      ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.fillStyle = "#fff"; ctx.strokeStyle = "#2563eb";
      for (const [hx, hy] of handlePts(bb)) {
        const p = w2s(hx, hy);
        ctx.beginPath(); ctx.rect(p.x - 4, p.y - 4, 8, 8); ctx.fill(); ctx.stroke();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [art.w, art.h]);

  const schedule = useCallback(() => {
    if (raf.current != null) return;
    raf.current = requestAnimationFrame(() => { raf.current = undefined; draw(); });
  }, [draw]);

  const handlePts = (bb: BBox): [number, number][] => [
    [bb.x, bb.y], [bb.x + bb.w / 2, bb.y], [bb.x + bb.w, bb.y],
    [bb.x + bb.w, bb.y + bb.h / 2], [bb.x + bb.w, bb.y + bb.h],
    [bb.x + bb.w / 2, bb.y + bb.h], [bb.x, bb.y + bb.h], [bb.x, bb.y + bb.h / 2],
  ];
  const handleName = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  const hitHandle = (sx: number, sy: number, s: Shape): string | null => {
    const bb = getBBox(s), pts = handlePts(bb);
    for (let i = 0; i < pts.length; i++) {
      const p = w2s(pts[i][0], pts[i][1]);
      if (Math.abs(sx - p.x) <= HANDLE && Math.abs(sy - p.y) <= HANDLE) return handleName[i];
    }
    return null;
  };
  const isHit = (w: Pt, s: Shape): boolean => {
    const sc = view.current.scale;
    if (s.type === "pen") return s.pts.some((p, i) => i > 0 && distSeg(w, s.pts[i - 1], p) < 6 / sc);
    if (s.type === "arrow") return distSeg(w, { x: s.x, y: s.y }, { x: s.x + s.w, y: s.y + s.h }) < 8 / sc;
    const bb = getBBox(s), pad = 4 / sc;
    return w.x >= bb.x - pad && w.x <= bb.x + bb.w + pad && w.y >= bb.y - pad && w.y <= bb.y + bb.h + pad;
  };
  const hitTop = (w: Pt): Shape | undefined => {
    for (let i = scene.current.length - 1; i >= 0; i--) if (isHit(w, scene.current[i])) return scene.current[i];
    return undefined;
  };
  const computeResize = (b: BBox, h: string, wx: number, wy: number): BBox => {
    let x = b.x, y = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
    if (h.includes("w")) x = wx; if (h.includes("e")) x2 = wx;
    if (h.includes("n")) y = wy; if (h.includes("s")) y2 = wy;
    const nx = Math.min(x, x2), ny = Math.min(y, y2);
    return { x: nx, y: ny, w: Math.max(4, Math.abs(x2 - x)), h: Math.max(4, Math.abs(y2 - y)) };
  };

  // ---------- ciclo de vida ----------
  useLayoutEffect(() => {
    // carrega: snapshot da frase > autosave local > vazio
    let loaded: Shape[] | null = null;
    for (const src of [snapshot, (() => { try { return localStorage.getItem(lsKey) ?? undefined; } catch { return undefined; } })()]) {
      if (!src) continue;
      try { const d = JSON.parse(src); if (Array.isArray(d?.shapes)) { loaded = d.shapes; break; } } catch { /* formato velho/inválido */ }
    }
    scene.current = loaded ?? [];
    for (const s of scene.current) if (s.type === "image") getImg(s.src);
    // tamanho + fit inicial
    const wrap = wrapRef.current, cv = canvasRef.current; if (!wrap || !cv) return;
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect(); size.current = { w: r.width, h: r.height };
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
      cv.style.width = `${r.width}px`; cv.style.height = `${r.height}px`;
      if (view.current.scale === 1 && view.current.tx === 0) fit();
      else schedule();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fit = () => {
    const { w: cw, h: ch } = size.current; if (!cw) return;
    const s = clamp(Math.min((cw - 56) / art.w, (ch - 56) / art.h), 0.1, 8);
    view.current = { scale: s, tx: (cw - art.w * s) / 2, ty: (ch - art.h * s) / 2 };
    setZoom(Math.round(s * 100)); schedule();
  };

  // wheel (não-passivo p/ preventDefault do zoom)
  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      if (editingR.current) return;
      e.preventDefault();
      const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top, v = view.current;
      const ns = clamp(v.scale * Math.exp(-e.deltaY * 0.0015), 0.1, 8);
      const wx = (sx - v.tx) / v.scale, wy = (sy - v.ty) / v.scale;
      view.current = { scale: ns, tx: sx - wx * ns, ty: sy - wy * ns };
      setZoom(Math.round(ns * 100)); schedule();
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [schedule]);

  // atalhos de teclado
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editingR.current) return;
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (meta && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if (meta && e.key.toLowerCase() === "d") { e.preventDefault(); duplicate(); return; }
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); del(); return; }
      if (e.key === "Escape") { sel.current = null; tick(); schedule(); return; }
      if (e.key === " ") { space.current = true; return; }
      const map: Record<string, Tool> = { v: "select", p: "pen", r: "rect", o: "ellipse", a: "arrow", t: "text", e: "eraser", h: "pan" };
      const t = map[e.key.toLowerCase()]; if (t) setTool(t);
    };
    const onUp = (e: KeyboardEvent) => { if (e.key === " ") space.current = false; };
    window.addEventListener("keydown", onKey); window.addEventListener("keyup", onUp);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // colar imagem do clipboard (Ctrl+V)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (editingR.current) return;
      const items = e.clipboardData?.items; if (!items) return;
      for (const it of Array.from(items)) if (it.type.startsWith("image/")) {
        const f = it.getAsFile(); if (f) { const r = new FileReader(); r.onload = () => addImage(r.result as string); r.readAsDataURL(f); }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- ações ----------
  const undo = () => { const p = undoS.current.pop(); if (p == null) return; redoS.current.push(serialize()); try { scene.current = JSON.parse(p).shapes ?? []; } catch { /* */ } sel.current = null; setEditing(null); tick(); schedule(); saveLocal(); };
  const redo = () => { const n = redoS.current.pop(); if (n == null) return; undoS.current.push(serialize()); try { scene.current = JSON.parse(n).shapes ?? []; } catch { /* */ } tick(); schedule(); saveLocal(); };
  const del = () => { if (!sel.current) return; pushUndo(); scene.current = scene.current.filter((s) => s.id !== sel.current); sel.current = null; tick(); schedule(); saveLocal(); };
  const duplicate = () => {
    const s = find(sel.current); if (!s) return; pushUndo();
    const c = clone(s); c.id = uid(); translate(c, GRID, GRID); scene.current.push(c); sel.current = c.id; tick(); schedule(); saveLocal();
  };
  const applyColor = (c: string) => {
    setColor(c);
    const s = find(sel.current); if (!s) return; pushUndo();
    if (s.type === "text") s.color = c; else if (s.type !== "image") s.stroke = c;
    tick(); schedule(); saveLocal();
  };
  const applyStroke = (n: number) => {
    setStrokeW(n);
    const s = find(sel.current); if (!s || s.type === "text" || s.type === "image") return;
    pushUndo(); s.sw = n; tick(); schedule(); saveLocal();
  };
  const getImg = (src: string): HTMLImageElement => {
    let img = imgCache.current.get(src);
    if (!img) { img = new Image(); img.onload = () => schedule(); img.src = src; imgCache.current.set(src, img); }
    return img;
  };
  const addImage = (src: string, at?: Pt) => {
    const probe = new Image();
    probe.onload = () => {
      const k = Math.min(1, (art.w * 0.6) / probe.naturalWidth, (art.h * 0.6) / probe.naturalHeight);
      const w = Math.max(8, Math.round(probe.naturalWidth * k)), h = Math.max(8, Math.round(probe.naturalHeight * k));
      const cx = at ? at.x : art.w / 2, cy = at ? at.y : art.h / 2;
      pushUndo();
      imgCache.current.set(src, probe);
      const s: ImageS = { id: uid(), type: "image", x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h, src };
      scene.current.push(s); sel.current = s.id; setTool("select"); tick(); schedule(); saveLocal();
    };
    probe.src = src;
  };
  const readFiles = (files: FileList | null, at?: Pt) => {
    if (!files) return;
    Array.from(files).filter((f) => f.type.startsWith("image/")).forEach((f) => {
      const r = new FileReader(); r.onload = () => addImage(r.result as string, at); r.readAsDataURL(f);
    });
  };

  // ---------- ponteiro ----------
  const localXY = (e: React.PointerEvent) => { const r = canvasRef.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  const onDown = (e: React.PointerEvent) => {
    if (editingR.current) commitText();
    const cv = canvasRef.current!;
    const { x: sx, y: sy } = localXY(e), w = s2w(sx, sy), t = toolR.current;

    // TEXTO: cria e entra em edição SEM capturar o ponteiro — a captura roubava o foco do
    // textarea assim que ele montava (parecia que "não funcionava"). Foco via rAF pós-mount.
    if (t === "text") {
      e.preventDefault(); // bloqueia o foco-default do mousedown que roubava o textarea recém-criado
      pushUndo();
      const s: TextS = { id: uid(), type: "text", x: snapV(w.x), y: snapV(w.y), text: "", size: 28, color: colorR.current };
      scene.current.push(s); sel.current = s.id; setEditing(s.id); setTool("select");
      tick(); schedule(); return;
    }
    cv.setPointerCapture(e.pointerId);

    if (space.current || t === "pan" || e.button === 1) { drag.current = { mode: "pan", startS: { x: sx, y: sy }, startV: { ...view.current } }; return; }

    if (t === "select") {
      const cur = find(sel.current);
      if (cur) { const h = hitHandle(sx, sy, cur); if (h) { pushUndo(); drag.current = { mode: "resize", id: cur.id, handle: h, start: getBBox(cur), orig: clone(cur) }; return; } }
      const hit = hitTop(w);
      if (hit) { sel.current = hit.id; pushUndo(); drag.current = { mode: "move", id: hit.id, startW: w, orig: clone(hit) }; }
      else sel.current = null;
      tick(); schedule(); return;
    }
    if (t === "eraser") { pushUndo(); const hit = hitTop(w); if (hit) scene.current = scene.current.filter((s) => s.id !== hit.id); drag.current = { mode: "erase" }; tick(); schedule(); return; }
    if (t === "pen") { pushUndo(); const s: PenS = { id: uid(), type: "pen", pts: [w], stroke: colorR.current, sw: strokeWR.current }; scene.current.push(s); drag.current = { mode: "pen", id: s.id }; return; }
    // rect / ellipse / arrow
    pushUndo();
    const id = uid(), ox = snapV(w.x), oy = snapV(w.y);
    const s: Shape = t === "arrow"
      ? { id, type: "arrow", x: ox, y: oy, w: 0, h: 0, stroke: colorR.current, sw: strokeWR.current }
      : { id, type: t, x: ox, y: oy, w: 0, h: 0, stroke: colorR.current, sw: strokeWR.current, fill: fillR.current ? colorR.current : "none" };
    scene.current.push(s); sel.current = id; drag.current = { mode: "create", id, start: { x: ox, y: oy } };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const { x: sx, y: sy } = localXY(e), w = s2w(sx, sy);
    if (d.mode === "pan") { view.current = { ...view.current, tx: d.startV.tx + (sx - d.startS.x), ty: d.startV.ty + (sy - d.startS.y) }; schedule(); return; }
    if (d.mode === "pen") { const s = find(d.id) as PenS | undefined; if (s) { s.pts.push(w); schedule(); } return; }
    if (d.mode === "erase") { const hit = hitTop(w); if (hit) { scene.current = scene.current.filter((s) => s.id !== hit.id); schedule(); } return; }
    if (d.mode === "create") { const s = find(d.id) as RectS | ArrowS | undefined; if (s) { s.w = snapV(w.x) - d.start.x; s.h = snapV(w.y) - d.start.y; schedule(); } return; }
    if (d.mode === "move") {
      const dx = snapV(w.x) - snapV(d.startW.x), dy = snapV(w.y) - snapV(d.startW.y);
      const i = scene.current.findIndex((s) => s.id === d.id); if (i >= 0) scene.current[i] = translate(clone(d.orig), dx, dy);
      schedule(); return;
    }
    if (d.mode === "resize") {
      const nb = computeResize(d.start, d.handle, snapV(w.x), snapV(w.y));
      const i = scene.current.findIndex((s) => s.id === d.id); if (i >= 0) scene.current[i] = setBBox(clone(d.orig), nb);
      schedule(); return;
    }
  };

  const onUpPtr = () => {
    const d = drag.current; drag.current = null;
    if (d?.mode === "create") {
      const s = find(d.id); if (s) {
        const bb = getBBox(s);
        if (bb.w < 3 && bb.h < 3) { scene.current = scene.current.filter((x) => x.id !== d.id); undoS.current.pop(); }
        else if (s.type === "rect" || s.type === "ellipse") { if (s.w < 0) { s.x += s.w; s.w = -s.w; } if (s.h < 0) { s.y += s.h; s.h = -s.h; } }
      }
      setTool("select");
    }
    if (d?.mode === "pen") { const s = find(d.id) as PenS | undefined; if (s && s.pts.length < 2) { scene.current = scene.current.filter((x) => x.id !== d.id); undoS.current.pop(); } setTool("select"); }
    if (d) { tick(); schedule(); saveLocal(); }
  };

  // ---------- edição de texto (overlay) ----------
  // foca o textarea no PRÓXIMO frame — depois do foco-default do navegador. Focar antes (síncrono)
  // levava um blur imediato e o onBlur apagava o texto vazio -> "não aparecia nada".
  useEffect(() => {
    if (!editing) return;
    const r = requestAnimationFrame(() => { taRef.current?.focus(); taRef.current?.select(); });
    return () => cancelAnimationFrame(r);
  }, [editing]);
  const commitText = () => {
    const s = find(editingR.current) as TextS | undefined;
    if (s && !s.text.trim()) scene.current = scene.current.filter((x) => x.id !== s.id);
    setEditing(null); tick(); schedule(); saveLocal();
  };
  const editShape = editing ? (find(editing) as TextS | undefined) : undefined;
  const editPos = editShape ? w2s(editShape.x, editShape.y) : null;

  // ---------- export ----------
  const exportPng = (): string => {
    const s = 2, c = document.createElement("canvas"); c.width = art.w * s; c.height = art.h * s;
    const g = c.getContext("2d"); if (!g) return "";
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
    g.save(); g.scale(s, s); g.beginPath(); g.rect(0, 0, art.w, art.h); g.clip();
    for (const sh of scene.current) drawShape(g, sh);
    g.restore();
    return c.toDataURL("image/png");
  };
  const usar = () => {
    if (editing) commitText();
    if (scene.current.length === 0) { alert("Desenhe algo no esboço antes de usar."); return; }
    onUse(exportPng(), serialize());
  };

  // ---------- UI ----------
  const TOOLS: [Tool, string, string][] = [
    ["select", "select", "Selecionar / mover  (V)"], ["pen", "pen", "Caneta  (P)"], ["rect", "rect", "Retângulo  (R)"],
    ["ellipse", "ellipse", "Elipse  (O)"], ["arrow", "arrow", "Seta  (A)"], ["text", "text", "Texto  (T)"],
    ["eraser", "eraser", "Borracha  (E)"], ["pan", "pan", "Mover tela  (H / espaço)"],
  ];
  const cursor = tool === "pan" || space.current ? "grab" : tool === "text" ? "text" : tool === "select" ? "default" : "crosshair";

  return createPortal(
    // PORTAL pro document.body: fica fora de qualquer ancestral com overflow/transform.
    // stopPropagation: portal borbulha eventos pela árvore REACT (não o DOM), então o clique
    // no editor ainda subiria pro onClick de fechar do pai. Fechar só pelos botões.
    <div onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, zIndex: 950, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ width: "min(1400px, 97vw)", height: "94vh", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 16, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {/* estilos locais (hover/active dos controles) */}
        <style>{`
          .sk-hd { display:flex; align-items:center; gap:12px; padding:12px 16px; background:var(--panel); border-bottom:1px solid var(--border); }
          .sk-bar { display:flex; align-items:center; gap:8px; padding:8px 12px; background:var(--panel); border-bottom:1px solid var(--border); flex-wrap:wrap; }
          .sk-bar .sk-grp { display:inline-flex; align-items:center; gap:4px; padding:4px; background:var(--panel2); border:1px solid var(--border); border-radius:12px; }
          .sk-bar .sk-ic { width:32px; height:32px; padding:0; display:grid; place-items:center; border-radius:8px; cursor:pointer; border:1px solid transparent; background:transparent; color:var(--muted); box-shadow:none; transition:background .15s ease, color .15s ease; }
          .sk-bar .sk-ic:hover { background:var(--panel3); color:var(--text); }
          .sk-bar .sk-ic.on { background:var(--active-grad); color:var(--text); border-color:var(--border-active); box-shadow:var(--shadow-active); }
          .sk-bar .sk-sw { width:20px; height:20px; padding:0; border:none; border-radius:999px; cursor:pointer; box-shadow:inset 0 0 0 1px rgba(255,255,255,.18); transition:transform .1s ease; }
          .sk-bar .sk-sw:hover { transform:scale(1.12); }
          .sk-bar .sk-sw.on { box-shadow:inset 0 0 0 1px rgba(255,255,255,.18), 0 0 0 2px var(--panel2), 0 0 0 3px var(--accent); }
          .sk-bar .sk-w { width:32px; height:32px; padding:0; display:inline-flex; align-items:center; justify-content:center; border-radius:8px; cursor:pointer; border:1px solid transparent; background:transparent; color:var(--muted); box-shadow:none; }
          .sk-bar .sk-w:hover { background:var(--panel3); color:var(--text); }
          .sk-bar .sk-w.on { background:var(--active-grad); color:var(--text); border-color:var(--border-active); box-shadow:var(--shadow-active); }
          .sk-bar .sk-fill { display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 8px; border-radius:8px; font-size:12px; color:var(--muted); cursor:pointer; }
          .sk-bar .sk-fill:hover { background:var(--panel3); color:var(--text); }
          .sk-bar .sk-img { display:inline-flex; align-items:center; gap:8px; height:40px; padding:0 16px; border-radius:12px; cursor:pointer; border:1px dashed var(--purple); background:transparent; color:var(--text); font-size:12.5px; font-weight:600; box-shadow:none; transition:background .15s ease; }
          .sk-bar .sk-img:hover { background:var(--accent-soft); }
          .sk-zoom { font-size:12px; color:var(--muted); min-width:44px; text-align:center; font-variant-numeric:tabular-nums; }
          .sk-hd .sk-use { background:var(--accent); color:#141414; font-weight:600; font-size:13px; padding:8px 20px; border-radius:12px; border:none; cursor:pointer; box-shadow:none; }
          .sk-hd .sk-use:hover { background:#ffffff; }
          .sk-hd .sk-close { font-size:13px; padding:8px 16px; border-radius:12px; }
        `}</style>
        {/* cabeçalho */}
        <div className="sk-hd">
          <strong style={{ fontSize: 14 }}>Esboço — blueprint da tela</strong>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>desenhe ONDE cada coisa fica · arraste, cole ou suba imagens · grid + snap · Ctrl+D duplica</span>
          <span style={{ flex: 1 }} />
          <button className="sk-use" onClick={usar}>Usar esboço</button>
          <button className="sk-close" onClick={onClose}>Fechar</button>
        </div>
        {/* barra de ferramentas */}
        <div className="sk-bar">
          <div className="sk-grp">
            {TOOLS.map(([id, ic, tip]) => (
              <button key={id} title={tip} className={"sk-ic" + (tool === id ? " on" : "")} onClick={() => setTool(id)}><Icon name={ic} /></button>
            ))}
          </div>
          <button className="sk-img" title="Subir imagem (ou arraste/cole no canvas)" onClick={() => fileInput.current?.click()}>
            <Icon name="image" w={18} /> Imagem
          </button>
          <input ref={fileInput} type="file" accept="image/*" multiple style={{ display: "none" }}
            onChange={(e) => { readFiles(e.target.files); e.currentTarget.value = ""; }} />
          <div className="sk-grp">
            {PALETTE.map((c) => (
              <button key={c} title={c} className={"sk-sw" + (color === c ? " on" : "")} style={{ background: c }} onClick={() => applyColor(c)} />
            ))}
          </div>
          <div className="sk-grp">
            {([["S", 2], ["M", 4], ["G", 7]] as const).map(([lbl, n]) => (
              <button key={lbl} title={`Espessura ${lbl}`} className={"sk-w" + (strokeW === n ? " on" : "")} onClick={() => applyStroke(n)}>
                <span style={{ width: n + 3, height: n + 3, borderRadius: "50%", background: "currentColor" }} />
              </button>
            ))}
            <label title="Preencher formas" className="sk-fill">
              <input type="checkbox" checked={fill} onChange={(e) => setFill(e.target.checked)} style={{ margin: 0 }} /> fill
            </label>
          </div>
          <div className="sk-grp">
            <button title="Grade + snap" className={"sk-ic" + (snap ? " on" : "")} onClick={() => setSnap((v) => !v)}><Icon name="grid" /></button>
            <button title="Desfazer (Ctrl+Z)" className="sk-ic" onClick={undo}><Icon name="undo" /></button>
            <button title="Refazer (Ctrl+Shift+Z)" className="sk-ic" onClick={redo}><Icon name="redo" /></button>
            <button title="Duplicar (Ctrl+D)" className="sk-ic" onClick={duplicate}><Icon name="dup" /></button>
            <button title="Apagar seleção (Del)" className="sk-ic" onClick={del}><Icon name="trash" /></button>
          </div>
          <span style={{ flex: 1 }} />
          <div className="sk-grp">
            <button title="Ajustar à tela" className="sk-ic" onClick={fit}><Icon name="fit" /></button>
            <span className="sk-zoom">{zoom}%</span>
          </div>
        </div>
        {/* área do canvas */}
        <div ref={wrapRef} style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", cursor }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); const r = canvasRef.current!.getBoundingClientRect(); readFiles(e.dataTransfer.files, s2w(e.clientX - r.left, e.clientY - r.top)); }}>
          <canvas ref={canvasRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUpPtr} onPointerCancel={onUpPtr}
            onDoubleClick={(e) => {
              const r = canvasRef.current!.getBoundingClientRect(), w = s2w(e.clientX - r.left, e.clientY - r.top);
              const hit = hitTop(w); if (hit?.type === "text") { sel.current = hit.id; setEditing(hit.id); tick(); }
            }}
            style={{ display: "block", touchAction: "none" }} />
          {editShape && editPos && (
            <textarea ref={taRef} value={editShape.text} placeholder="digite…"
              onChange={(e) => { editShape.text = e.target.value; tick(); schedule(); }}
              onBlur={commitText}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); commitText(); } }}
              style={{
                position: "absolute", left: editPos.x, top: editPos.y, transformOrigin: "top left",
                font: fontOf(editShape.size * view.current.scale), color: editShape.color, lineHeight: 1.25,
                caretColor: "var(--accent)", background: "#ffffff",
                border: "2px solid var(--accent)", borderRadius: 4, boxShadow: "0 6px 22px rgba(0,0,0,0.35)",
                padding: "1px 4px", margin: 0, resize: "none", outline: "none", overflow: "hidden",
                minWidth: 60, minHeight: editShape.size * view.current.scale * 1.3, whiteSpace: "pre",
              }} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
