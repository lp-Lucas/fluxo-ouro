import { useEffect, useMemo, useRef, useState } from "react";
import type { Cut, Word } from "../../../../shared/timeline";

/**
 * Timeline visual de cortes com forma de onda do áudio + ZOOM.
 * - Fundo: waveform (decodificada do vídeo) → mostra fala x silêncio.
 * - Blocos vermelhos = cortes. Arraste as BORDAS p/ ajustar (ímã nas palavras),
 *   arraste o MEIO p/ mover, clique no vazio p/ buscar o frame, arraste no vazio
 *   p/ criar um corte novo.
 * - Zoom (botões/slider) amplia a faixa → rola na horizontal (barra ou shift+scroll).
 *   O playhead é mantido à vista durante o play.
 * Edita `cuts` direto (onCutsChange) — undo/redo de graça.
 */

const RULER = 20;              // régua de tempo (topo)
const WAVE = 64;               // faixa da onda
const H = RULER + WAVE;
const EDGE_PX = 7;
const HANDLE_MS = 4;
const ZMIN = 1, ZMAX = 60;

/** Paleta do canvas (o canvas não lê CSS vars) — casa com o tema dark + azul. */
const COL = {
  bg: "#1f1f1f",
  ruler: "#8f8f8f",
  tick: "#3a3a3a",
  waveCut: "#3a3a3a",                 // onda nas áreas CORTADAS (apagada)
  clipFill: "rgba(255, 255, 255, 0.08)",  // bloco do trecho MANTIDO
  clipStroke: "rgba(255, 255, 255, 0.18)",
  wave: "#d6d6d6",                    // onda dentro do trecho mantido
  sel: "#f2f2f2",
  temp: "rgba(255, 255, 255, 0.12)",
};

/** Passo "bonito" da régua conforme o zoom (px por segundo). */
function rulerStep(pxPerSec: number): number {
  for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]) if (s * pxPerSec >= 70) return s;
  return 600;
}
const fmtRuler = (t: number) => {
  const m = Math.floor(t / 60), s = t % 60;
  return s === Math.floor(s) ? `${m}:${String(Math.floor(s)).padStart(2, "0")}` : `${m}:${s.toFixed(1).padStart(4, "0")}`;
};

/** Decodifica o áudio do arquivo e devolve picos normalizados por bucket. */
function useWaveform(file: File, buckets: number): Float32Array | null {
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  useEffect(() => {
    let cancel = false;
    setPeaks(null);
    (async () => {
      try {
        const buf = await file.arrayBuffer();
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new Ctx();
        const audio = await ctx.decodeAudioData(buf.slice(0));
        ctx.close();
        const ch = audio.getChannelData(0);
        const per = Math.max(1, Math.floor(ch.length / buckets));
        const out = new Float32Array(buckets);
        let maxv = 1e-6;
        for (let b = 0; b < buckets; b++) {
          let peak = 0;
          const s = b * per, e = Math.min(ch.length, s + per);
          for (let i = s; i < e; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
          out[b] = peak; if (peak > maxv) maxv = peak;
        }
        for (let b = 0; b < buckets; b++) out[b] /= maxv;
        if (!cancel) setPeaks(out);
      } catch { if (!cancel) setPeaks(null); }
    })();
    return () => { cancel = true; };
  }, [file, buckets]);
  return peaks;
}

type Drag =
  | { kind: "edge"; id: string; side: "start" | "end" }
  | { kind: "move"; id: string; grabT: number }
  | { kind: "create"; t0: number }
  | { kind: "seekMaybe"; downX: number; t: number }
  | null;

export function CutTimeline({
  videoFile, duration, cuts, onCutsChange, words, currentTime = 0, clock, onSeek, onPlayKept, playing,
}: {
  videoFile: File;
  duration: number;
  cuts: Cut[];
  onCutsChange: (cuts: Cut[]) => void;
  words: Word[];
  /** modo legado (sem clock): o pai re-renderiza com o tempo. */
  currentTime?: number;
  /** P1 (fluidez): fonte de tempo IMPERATIVA — playhead/labels movem por DOM direto, sem re-render. */
  clock?: { readonly time: number; subscribe(f: (t: number) => void): () => void };
  onSeek: (t: number) => void;
  onPlayKept: () => void;
  playing: boolean;
}) {
  const buckets = Math.min(6000, Math.max(800, Math.round(duration * 50)));
  const peaks = useWaveform(videoFile, buckets);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null); // container rolável (largura visível)
  const wrapRef = useRef<HTMLDivElement>(null);   // conteúdo (largura = visível × zoom)
  const [vw, setVw] = useState(800);              // largura VISÍVEL
  const [zoom, setZoom] = useState(1);
  const [sel, setSel] = useState<string | null>(null);
  const drag = useRef<Drag>(null);
  const [tempCut, setTempCut] = useState<{ start: number; end: number } | null>(null);

  const cw = Math.round(vw * zoom); // largura do CONTEÚDO (desenho)

  const bounds = useMemo(() => {
    const s = new Set<number>([0, duration]);
    for (const wd of words) { s.add(+wd.start.toFixed(3)); s.add(+wd.end.toFixed(3)); }
    return [...s].sort((a, b) => a - b);
  }, [words, duration]);

  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setVw(el.clientWidth));
    ro.observe(el); setVw(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const xToT = (x: number) => (duration > 0 ? (x / cw) * duration : 0);
  const tToX = (t: number) => (duration > 0 ? (t / duration) * cw : 0);
  const snapThresh = duration > 0 ? (9 / cw) * duration : 0;

  function snap(t: number): number {
    let best = t, bd = snapThresh;
    for (const b of bounds) { const d = Math.abs(b - t); if (d < bd) { bd = d; best = b; } }
    return Math.max(0, Math.min(duration, +best.toFixed(3)));
  }

  // Zoom mantendo o tempo sob o cursor (ou o centro) estável.
  function applyZoom(nz: number, anchorClientX?: number) {
    nz = Math.max(ZMIN, Math.min(ZMAX, +nz.toFixed(2)));
    const sc = scrollRef.current;
    const anchorX = sc && anchorClientX != null ? anchorClientX - sc.getBoundingClientRect().left : vw / 2;
    const tAnchor = duration > 0 ? ((sc ? sc.scrollLeft : 0) + anchorX) / cw * duration : 0;
    setZoom(nz);
    requestAnimationFrame(() => {
      const s = scrollRef.current; if (!s) return;
      const newCw = Math.round(vw * nz);
      s.scrollLeft = (tAnchor / duration) * newCw - anchorX;
    });
  }

  // ── desenho (estilo "clipes": trechos MANTIDOS viram blocos arredondados com a
  //    onda dentro; os CORTES viram lacunas com a onda apagada — leitura imediata) ──
  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = cw * dpr; cv.height = H * dpr;
    const g = cv.getContext("2d")!; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = COL.bg; g.fillRect(0, 0, cw, H);

    // régua de tempo
    if (duration > 0) {
      const step = rulerStep(cw / duration);
      g.font = "10px Inter, system-ui, sans-serif";
      g.textBaseline = "middle";
      for (let t = 0; t <= duration + 1e-6; t += step) {
        const x = Math.round(tToX(t));
        g.fillStyle = COL.tick; g.fillRect(x, RULER - 5, 1, 5);
        g.fillStyle = COL.ruler; g.fillText(fmtRuler(t), x + 4, RULER / 2);
      }
      g.fillStyle = COL.tick; g.fillRect(0, RULER - 1, cw, 1);
    }

    const mid = RULER + WAVE / 2;
    const bar = (x: number, color: string) => {
      const p = peaks ? (peaks[Math.floor((x / cw) * peaks.length)] ?? 0) : 0.12;
      const hh = Math.max(1, p * (WAVE / 2 - 8));
      g.fillStyle = color;
      g.fillRect(x, mid - hh, 1, hh * 2);
    };

    // 1) onda inteira apagada (é o que fica visível nas lacunas = cortes)
    for (let x = 0; x < cw; x++) bar(x, COL.waveCut);

    // 2) trechos MANTIDOS = blocos arredondados + onda viva por cima
    const on = cuts.filter((c) => c.enabled).sort((a, b) => a.start - b.start);
    const kept: Array<[number, number]> = [];
    let cur = 0;
    for (const c of on) { if (c.start > cur) kept.push([cur, Math.min(c.start, duration)]); cur = Math.max(cur, c.end); }
    if (cur < duration) kept.push([cur, duration]);

    for (const [a, b] of kept) {
      const x0 = tToX(a), x1 = tToX(b);
      const w = Math.max(2, x1 - x0 - 2);
      const r = Math.min(10, w / 2);
      g.beginPath();
      g.roundRect(x0 + 1, RULER + 4, w, WAVE - 8, r);
      g.fillStyle = COL.clipFill; g.fill();
      g.strokeStyle = COL.clipStroke; g.lineWidth = 1; g.stroke();
      g.save();
      g.beginPath(); g.roundRect(x0 + 1, RULER + 4, w, WAVE - 8, r); g.clip();
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(cw, Math.ceil(x1)); x++) bar(x, COL.wave);
      g.restore();
    }

    // corte selecionado: alças discretas nas bordas
    const selC = cuts.find((c) => c.id === sel);
    if (selC) {
      for (const t of [selC.start, selC.end]) {
        const x = tToX(t);
        g.fillStyle = COL.sel;
        g.beginPath(); g.roundRect(x - 2.5, RULER + 8, 5, WAVE - 16, 3); g.fill();
      }
    }

    if (tempCut) {
      g.fillStyle = COL.temp;
      g.beginPath();
      g.roundRect(tToX(tempCut.start), RULER + 4, Math.max(2, tToX(tempCut.end) - tToX(tempCut.start)), WAVE - 8, 6);
      g.fill();
    }
    // O playhead NÃO é desenhado aqui: ele é um <div> leve (senão a onda inteira
    // seria redesenhada a cada frame → travava o preview a ~10fps).
  }, [peaks, cuts, sel, cw, duration, tempCut]);

  // Mantém o playhead à vista durante o play (modo legado, sem clock).
  useEffect(() => {
    if (!playing || clock) return;
    const sc = scrollRef.current; if (!sc) return;
    const px = tToX(currentTime);
    if (px < sc.scrollLeft + 30 || px > sc.scrollLeft + vw - 30) {
      sc.scrollLeft = Math.max(0, px - vw * 0.3);
    }
  }, [currentTime, playing, clock]);

  // P1: com clock, o playhead + badge + relógio movem por DOM DIRETO a cada frame —
  // zero re-render do React (a onda continua sem redesenhar; ver comentário acima).
  const playheadRef = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLDivElement>(null);
  const clockLabelRef = useRef<HTMLSpanElement>(null);
  const tToXRef = useRef(tToX); tToXRef.current = tToX;
  const playingRef = useRef(playing); playingRef.current = playing;
  const durationRef = useRef(duration); durationRef.current = duration;
  useEffect(() => {
    if (!clock) return;
    const apply = (t: number) => {
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${tToXRef.current(t).toFixed(1)}px)`;
      if (badgeRef.current) badgeRef.current.textContent = t.toFixed(2);
      if (clockLabelRef.current) clockLabelRef.current.textContent = `${fmt(t)} / ${fmt(durationRef.current)}`;
      const sc = scrollRef.current;
      if (sc && playingRef.current) {
        const px = tToXRef.current(t);
        if (px < sc.scrollLeft + 30 || px > sc.scrollLeft + sc.clientWidth - 30) sc.scrollLeft = Math.max(0, px - sc.clientWidth * 0.3);
      }
    };
    apply(clock.time);
    return clock.subscribe(apply);
  }, [clock]);
  // re-posiciona no zoom/resize (o clock só publica quando o tempo anda)
  useEffect(() => {
    if (!clock || !playheadRef.current) return;
    playheadRef.current.style.transform = `translateX(${tToX(clock.time).toFixed(1)}px)`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock, cw, duration]);

  // ── interação ──
  function hitEdge(x: number) {
    for (const c of cuts) {
      if (Math.abs(x - tToX(c.start)) <= EDGE_PX) return { id: c.id, side: "start" as const };
      if (Math.abs(x - tToX(c.end)) <= EDGE_PX) return { id: c.id, side: "end" as const };
    }
    return null;
  }
  function hitBody(x: number) {
    const t = xToT(x);
    for (const c of cuts) if (t >= c.start && t <= c.end) return c.id;
    return null;
  }
  const localX = (e: React.PointerEvent) => e.clientX - wrapRef.current!.getBoundingClientRect().left;

  function onDown(e: React.PointerEvent) {
    wrapRef.current!.setPointerCapture(e.pointerId);
    const x = localX(e);
    const edge = hitEdge(x);
    if (edge) { setSel(edge.id); drag.current = { kind: "edge", ...edge }; return; }
    const body = hitBody(x);
    if (body) { setSel(body); drag.current = { kind: "move", id: body, grabT: xToT(x) }; return; }
    drag.current = { kind: "seekMaybe", downX: x, t: xToT(x) };
  }

  function onMove(e: React.PointerEvent) {
    const d = drag.current; if (!d) return;
    const x = localX(e);
    const t = snap(xToT(x));
    if (d.kind === "seekMaybe") {
      if (Math.abs(x - d.downX) > HANDLE_MS) { drag.current = { kind: "create", t0: d.t }; setTempCut({ start: d.t, end: d.t }); }
      else return;
    }
    const cur = drag.current!;
    if (cur.kind === "create") {
      setTempCut({ start: Math.min(cur.t0, t), end: Math.max(cur.t0, t) });
    } else if (cur.kind === "edge") {
      onCutsChange(cuts.map((c) => {
        if (c.id !== cur.id) return c;
        if (cur.side === "start") return { ...c, start: Math.min(t, c.end - 0.02) };
        return { ...c, end: Math.max(t, c.start + 0.02) };
      }));
    } else if (cur.kind === "move") {
      const dt = xToT(x) - cur.grabT;
      onCutsChange(cuts.map((c) => {
        if (c.id !== cur.id) return c;
        let ns = snap(c.start + dt), ne = +(ns + (c.end - c.start)).toFixed(3);
        if (ns < 0) { ns = 0; ne = c.end - c.start; }
        if (ne > duration) { ne = duration; ns = +(duration - (c.end - c.start)).toFixed(3); }
        return { ...c, start: ns, end: ne };
      }));
      drag.current = { kind: "move", id: cur.id, grabT: xToT(x) };
    }
  }

  function onUp(e: React.PointerEvent) {
    const d = drag.current; drag.current = null;
    try { wrapRef.current!.releasePointerCapture(e.pointerId); } catch { /* já solto */ }
    if (!d) return;
    if (d.kind === "seekMaybe") { onSeek(snap(d.t)); return; }
    if (d.kind === "create" && tempCut) {
      const a = snap(tempCut.start), b = snap(tempCut.end);
      setTempCut(null);
      if (b - a >= 0.05) {
        const id = `cut-man-${Date.now()}`;
        onCutsChange([...cuts, { id, start: a, end: b, reason: "manual" as const, enabled: true }].sort((p, q) => p.start - q.start));
        setSel(id);
      }
    }
  }

  // shift+scroll (ou scroll horizontal do trackpad) rola na horizontal.
  function onWheel(e: React.WheelEvent) {
    const sc = scrollRef.current; if (!sc) return;
    if (e.shiftKey && e.deltaY) sc.scrollLeft += e.deltaY;
  }

  const selCut = cuts.find((c) => c.id === sel) ?? null;
  const patch = (p: Partial<Cut>) => onCutsChange(cuts.map((c) => (c.id === sel ? { ...c, ...p } : c)));
  const nudge = (side: "start" | "end", d: number) => {
    if (!selCut) return;
    if (side === "start") patch({ start: +Math.max(0, Math.min(selCut.end - 0.02, selCut.start + d)).toFixed(3) });
    else patch({ end: +Math.min(duration, Math.max(selCut.start + 0.02, selCut.end + d)).toFixed(3) });
  };
  const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, "0")}`;

  return (
    <div style={{ marginTop: 12 }}>
      <div ref={scrollRef} onWheel={onWheel} title="arraste no vazio p/ criar corte · shift+scroll rola"
        style={{ width: "100%", overflowX: "auto", overflowY: "hidden", borderRadius: 12, border: "1px solid var(--border)" }}>
        <div ref={wrapRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
          style={{ position: "relative", width: cw, height: H, cursor: "pointer", userSelect: "none", touchAction: "none" }}>
          <canvas ref={canvasRef} style={{ width: cw, height: H, display: "block" }} />
          {/* Playhead: div leve movido por transform (não redesenha o canvas). Com clock,
              o movimento é por DOM direto (P1); sem clock, via prop currentTime (legado). */}
          <div ref={playheadRef} style={{ position: "absolute", top: 0, left: 0, height: H, pointerEvents: "none", willChange: "transform",
            transform: `translateX(${tToX(clock ? clock.time : currentTime).toFixed(1)}px)` }}>
            <div style={{ position: "absolute", top: RULER, left: -0.75, width: 1.5, height: WAVE, background: "#eceef6" }} />
            {/* badge flutuante com o tempo atual (estilo referência) */}
            <div ref={badgeRef} style={{ position: "absolute", top: 1, left: 0, transform: "translateX(-50%)",
              background: "#0a0a0e", border: "1px solid var(--border)", borderRadius: 8,
              padding: "1px 8px", fontSize: 11, color: "#fff", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
              {(clock ? clock.time : currentTime).toFixed(2)}
            </div>
          </div>
        </div>
      </div>

      {/* transporte — mínimo: play redondo, tempo, zoom */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
        <button onClick={onPlayKept} title="tocar pulando os cortes"
          style={{ width: 38, height: 38, borderRadius: "50%", background: "#0a0a0e", border: "1px solid var(--border)",
            color: "#fff", fontSize: 13, display: "grid", placeItems: "center", padding: 0 }}>
          {playing ? "❚❚" : "▶"}
        </button>
        <span ref={clockLabelRef} style={{ fontSize: 13, color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
          {fmt(clock ? clock.time : currentTime)} / {fmt(duration)}
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={() => applyZoom(zoom / 1.5)} disabled={zoom <= ZMIN} style={zoomBtn}>−</button>
        <input type="range" min={ZMIN} max={ZMAX} step={0.5} value={zoom}
          onChange={(e) => applyZoom(+e.target.value)} style={{ width: 110 }} />
        <button onClick={() => applyZoom(zoom * 1.5)} disabled={zoom >= ZMAX} style={zoomBtn}>+</button>
        <button onClick={() => applyZoom(1)} disabled={zoom === 1} style={{ ...zoomBtn, width: "auto", padding: "0 12px", fontVariantNumeric: "tabular-nums" }}>
          {zoom.toFixed(1)}×
        </button>
      </div>

      {selCut ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8, fontSize: 13 }}>
          <strong style={{ color: "var(--red)" }}>corte {fmt(selCut.start)}–{fmt(selCut.end)}</strong>
          <span style={{ color: "var(--muted)" }}>({(selCut.end - selCut.start).toFixed(2)}s)</span>
          <span style={{ marginLeft: 8 }}>início:</span>
          <button onClick={() => nudge("start", -0.1)}>◀ -0.1</button>
          <button onClick={() => nudge("start", +0.1)}>+0.1 ▶</button>
          <span style={{ marginLeft: 8 }}>fim:</span>
          <button onClick={() => nudge("end", -0.1)}>◀ -0.1</button>
          <button onClick={() => nudge("end", +0.1)}>+0.1 ▶</button>
          <label style={{ marginLeft: 8, color: selCut.enabled ? "#1a7f37" : "#999" }}>
            <input type="checkbox" checked={selCut.enabled} onChange={(e) => patch({ enabled: e.target.checked })} /> ativo
          </label>
          <label title="não remove a legenda; desloca p/ depois do corte"
            style={{ color: selCut.shiftCaption ? "#7a1aff" : "#999" }}>
            <input type="checkbox" checked={!!selCut.shiftCaption} onChange={(e) => patch({ shiftCaption: e.target.checked })} /> ↪ manter legenda
          </label>
          <button onClick={() => { onCutsChange(cuts.filter((c) => c.id !== sel)); setSel(null); }}
            style={{ color: "var(--red)", marginLeft: 8 }}>apagar</button>
        </div>
      ) : null}
    </div>
  );
}

/** Botão de zoom (pequeno, quadrado suave). */
const zoomBtn: React.CSSProperties = {
  width: 28, height: 28, padding: 0, borderRadius: 8, fontSize: 14,
  display: "grid", placeItems: "center",
};
