import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { comBase } from "../../os-session";
import type { Assembly, MainClip, BrollClip } from "../../../../shared/assembly";
import { BROLL_TRACKS, clipDuration, mainClipOffsets, assemblyDuration } from "../../../../shared/assembly";

/**
 * MONTADOR DE ORIGEM — timeline multipista (MVP): 1 pista PRINCIPAL (clipes em sequência) +
 * 2 pistas de B-ROLL (overlay). Você une várias filmagens e sobrepõe brolls; ao "Concluir",
 * o backend achata tudo num MP4 único que vira o source do projeto e re-transcreve.
 *
 * Preview é POR CLIPE (toca o trecho aparado do clipe selecionado) — o resultado montado só
 * existe depois de "Concluir". Refs de asset são URLs relativas (comBase resolve; o backend
 * resolve pelo basename).
 */

type PoolItem = { asset: string; fileName: string; durationSec: number; width: number; height: number };
type FlattenResult = { videoFile: string; durationSec: number; width: number; height: number; transcript: unknown; language?: string };

const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const fmt = (s: number) => {
  const m = Math.floor(s / 60), r = Math.floor(s % 60), f = Math.floor((s % 1) * 30);
  return `${m}:${String(r).padStart(2, "0")}.${String(f).padStart(2, "0")}`;
};
const tc = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
/** passo de rótulo da régua (~90px entre marcas) — evita poluir em zoom baixo. */
const rulerStep = (pps: number) => { const t = 90 / pps; for (const s of [1, 2, 5, 10, 15, 30, 60, 120, 300]) if (s >= t) return s; return 600; };

const TRACK_H = 62, RULER_H = 30, GUTTER = 116, SNAP_PX = 8;

export function AssemblyEditor({ projectId, width, height, sourceVideoUrl, sourceDurationSec, initial, onConclude, onClose }: {
  projectId: string;
  width: number; height: number;
  /** URL (comBase-relativa) do source atual — vira o clipe 0 da principal na 1ª abertura. */
  sourceVideoUrl: string;
  sourceDurationSec: number;
  /** montagem salva (reabrir) — se ausente, começa com o source na principal. */
  initial?: Assembly;
  onConclude: (result: FlattenResult, assembly: Assembly) => void;
  onClose: () => void;
}) {
  const [main, setMain] = useState<MainClip[]>(() =>
    initial?.main?.length ? initial.main
      : [{ id: uid(), asset: sourceVideoUrl, inPoint: 0, outPoint: sourceDurationSec || 1, sourceDurationSec: sourceDurationSec || 1 }]);
  const [brolls, setBrolls] = useState<BrollClip[]>(() => initial?.brolls ?? []);
  const [pool, setPool] = useState<PoolItem[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [pxPerSec, setPxPerSec] = useState(40);
  const [playhead, setPlayhead] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  const fileInput = useRef<HTMLInputElement | null>(null);
  const laneRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const drag = useRef<null | { kind: "playhead" | "main-move" | "main-in" | "main-out" | "broll-move" | "broll-in" | "broll-out"; id?: string; lastT?: number; grab?: number }>(null);

  const total = useMemo(() => Math.max(assemblyDuration({ version: 1, main, brolls }), 1), [main, brolls]);
  const offsets = useMemo(() => mainClipOffsets({ version: 1, main, brolls }), [main, brolls]);
  const asm = (): Assembly => ({ version: 1, main, brolls });

  const t2x = (t: number) => t * pxPerSec;
  const x2t = (x: number) => x / pxPerSec;
  const snap = (t: number) => {
    const snapT = SNAP_PX / pxPerSec;
    const cands = [0, total, ...offsets, ...offsets.map((o, i) => o + clipDuration(main[i])), ...brolls.map((b) => b.timelineStart), ...brolls.map((b) => b.timelineStart + clipDuration(b))];
    for (const c of cands) if (Math.abs(t - c) < snapT) return c;
    return t;
  };
  const fitZoom = useCallback(() => {
    const el = laneRef.current; if (!el) return;
    setPxPerSec(clamp((el.clientWidth - 40) / Math.max(total, 1), 5, 400));
  }, [total]);
  useEffect(() => { fitZoom(); /* ajusta o zoom ao abrir */ /* eslint-disable-next-line */ }, []);

  // ---------- preview (dirigido pelo playhead): principal em sequência + overlay de b-roll ----------
  const brollVideoRef = useRef<HTMLVideoElement | null>(null);
  const loadedMain = useRef(""), loadedBroll = useRef("");
  const [playing, setPlaying] = useState(false);
  const [brollActive, setBrollActive] = useState(false);

  /** Qual clipe da principal está no tempo t (+ o tempo dentro do clipe fonte). */
  const mainAt = (t: number) => {
    for (let i = 0; i < main.length; i++) {
      const o = offsets[i], d = clipDuration(main[i]);
      if (t >= o - 1e-3 && t < o + d - 1e-3) return { idx: i, clip: main[i], srcTime: main[i].inPoint + (t - o) };
    }
    if (main.length) { const i = main.length - 1; return { idx: i, clip: main[i], srcTime: main[i].outPoint }; }
    return null;
  };
  /** B-roll ativo no tempo t (o último do array = o que fica por cima, igual ao flatten). */
  const brollAt = (t: number) => {
    let f: BrollClip | null = null;
    for (const b of brolls) if (t >= b.timelineStart - 1e-3 && t < b.timelineStart + clipDuration(b) - 1e-3) f = b;
    return f ? { clip: f, srcTime: f.inPoint + (t - f.timelineStart) } : null;
  };
  const syncMain = (t: number, play: boolean) => {
    const v = videoRef.current; if (!v) return;
    const m = mainAt(t); if (!m) { v.pause(); return; }
    if (loadedMain.current !== m.clip.asset) {
      loadedMain.current = m.clip.asset; v.src = comBase(m.clip.asset);
      v.onloadedmetadata = () => { v.currentTime = m.srcTime; if (play) v.play().catch(() => {}); };
    } else {
      if (Math.abs(v.currentTime - m.srcTime) > 0.3) v.currentTime = m.srcTime;
      if (play) v.play().catch(() => {}); else v.pause();
    }
  };
  const syncBroll = (t: number) => {
    const bv = brollVideoRef.current; if (!bv) return;
    const b = brollAt(t);
    if (!b) { if (loadedBroll.current) { loadedBroll.current = ""; bv.pause(); } setBrollActive(false); return; }
    setBrollActive(true);
    if (loadedBroll.current !== b.clip.asset) {
      loadedBroll.current = b.clip.asset; bv.src = comBase(b.clip.asset);
      bv.onloadedmetadata = () => { bv.currentTime = b.srcTime; if (playing) bv.play().catch(() => {}); };
    } else {
      if (Math.abs(bv.currentTime - b.srcTime) > 0.3) bv.currentTime = b.srcTime;
      if (playing) bv.play().catch(() => {}); else bv.pause();
    }
  };
  /** timeupdate da principal: avança o playhead e troca de clipe nas junções. */
  const onMainTime = () => {
    if (!playing) return;
    const v = videoRef.current!; const m = mainAt(playhead); if (!m) return;
    if (v.currentTime >= m.clip.outPoint - 0.04) {
      if (m.idx + 1 < main.length) { const nt = offsets[m.idx] + clipDuration(m.clip) + 0.001; setPlayhead(nt); syncMain(nt, true); syncBroll(nt); }
      else { setPlaying(false); v.pause(); setPlayhead(total); }
      return;
    }
    const ph = offsets[m.idx] + (v.currentTime - m.clip.inPoint);
    setPlayhead(ph); syncBroll(ph);
  };
  const togglePlay = () => {
    if (playing) { setPlaying(false); videoRef.current?.pause(); brollVideoRef.current?.pause(); }
    else { const start = playhead >= total - 0.05 ? 0 : playhead; setPlayhead(start); setPlaying(true); syncMain(start, true); syncBroll(start); }
  };
  // mostra/scrub o frame ao mover o playhead (quando pausado) e ao mudar os clipes.
  useEffect(() => {
    if (!playing) { syncMain(playhead, false); syncBroll(playhead); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead, playing, main, brolls]);

  // ---------- pool / ingest ----------
  const addMedia = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy("Enviando mídia…");
    try {
      for (const f of Array.from(files)) {
        const form = new FormData(); form.append("video", f);
        const r = await fetch(comBase("/api/assembly/media"), { method: "POST", body: form });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Falha ao enviar mídia");
        setPool((p) => [...p, { asset: `/uploads/${d.asset}`, fileName: d.fileName ?? f.name, durationSec: d.durationSec || 1, width: d.width, height: d.height }]);
      }
    } catch (e) { alert("Erro: " + (e as Error).message); } finally { setBusy(null); }
  };
  const addToMain = (it: PoolItem) => {
    setMain((m) => [...m, { id: uid(), asset: it.asset, inPoint: 0, outPoint: it.durationSec, sourceDurationSec: it.durationSec }]);
  };
  const addToBroll = (it: PoolItem, trackIndex: number) => {
    setBrolls((b) => [...b, { id: uid(), asset: it.asset, inPoint: 0, outPoint: Math.min(it.durationSec, 4), sourceDurationSec: it.durationSec, trackIndex, timelineStart: snap(playhead), muted: true }]);
  };

  // ---------- edição de clipes ----------
  const del = () => { if (!sel) return; setMain((m) => m.filter((c) => c.id !== sel)); setBrolls((b) => b.filter((c) => c.id !== sel)); setSel(null); };
  const splitAtPlayhead = () => {
    // principal: divide o clipe sob o playhead
    const idx = offsets.findIndex((o, i) => playhead > o + 0.05 && playhead < o + clipDuration(main[i]) - 0.05);
    if (idx >= 0) {
      const c = main[idx], cutSrc = c.inPoint + (playhead - offsets[idx]);
      const a: MainClip = { ...c, id: uid(), outPoint: cutSrc };
      const b: MainClip = { ...c, id: uid(), inPoint: cutSrc };
      setMain((m) => [...m.slice(0, idx), a, b, ...m.slice(idx + 1)]);
      return;
    }
    // b-roll: divide o que estiver sob o playhead
    const bi = brolls.findIndex((b) => playhead > b.timelineStart + 0.05 && playhead < b.timelineStart + clipDuration(b) - 0.05);
    if (bi >= 0) {
      const c = brolls[bi], off = playhead - c.timelineStart, cutSrc = c.inPoint + off;
      const a: BrollClip = { ...c, id: uid(), outPoint: cutSrc };
      const b: BrollClip = { ...c, id: uid(), inPoint: cutSrc, timelineStart: playhead };
      setBrolls((arr) => [...arr.slice(0, bi), a, b, ...arr.slice(bi + 1)]);
    }
  };

  // ---------- ponteiro (arrastar / aparar) ----------
  const laneX = (e: React.PointerEvent | PointerEvent) => {
    const el = laneRef.current!; const r = el.getBoundingClientRect();
    return el.scrollLeft + (e.clientX - r.left);
  };
  const startDrag = (e: React.PointerEvent, d: NonNullable<typeof drag.current>) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    d.lastT = x2t(Math.max(0, laneX(e)));
    drag.current = d; e.stopPropagation();
  };
  const onLanePointerDown = (e: React.PointerEvent) => { // clicar na régua/vazio = seek (pausa)
    setSel(null); setPlaying(false); videoRef.current?.pause(); brollVideoRef.current?.pause();
    setPlayhead(clamp(snap(x2t(Math.max(0, laneX(e)))), 0, total));
    startDrag(e, { kind: "playhead" });
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current; if (!d) return;
    const t = clamp(x2t(Math.max(0, laneX(e))), 0, Math.max(total, sourceDurationSec * 4));
    const dt = t - (d.lastT ?? t); d.lastT = t;
    if (d.kind === "playhead") { setPlayhead(clamp(snap(t), 0, total)); return; }
    if (d.kind === "main-move" && d.id) {
      // reordena: acha o índice-alvo pela posição do ponteiro
      setMain((m) => {
        const from = m.findIndex((c) => c.id === d.id); if (from < 0) return m;
        const offs = mainClipOffsets({ version: 1, main: m, brolls: [] });
        let to = m.length - 1;
        for (let i = 0; i < m.length; i++) { if (t < offs[i] + clipDuration(m[i]) / 2) { to = i; break; } }
        if (to === from) return m;
        const cp = [...m]; const [it] = cp.splice(from, 1); cp.splice(to, 0, it); return cp;
      });
      return;
    }
    if (d.kind === "main-in" && d.id) setMain((m) => m.map((c) => c.id === d.id ? { ...c, inPoint: clamp(c.inPoint + dt, 0, c.outPoint - 0.1) } : c));
    if (d.kind === "main-out" && d.id) setMain((m) => m.map((c) => c.id === d.id ? { ...c, outPoint: clamp(c.outPoint + dt, c.inPoint + 0.1, c.sourceDurationSec) } : c));
    if (d.kind === "broll-move" && d.id) setBrolls((b) => b.map((c) => c.id === d.id ? { ...c, timelineStart: clamp(snap(t - (d.grab ?? 0)), 0, total) } : c));
    if (d.kind === "broll-in" && d.id) setBrolls((b) => b.map((c) => c.id === d.id ? { ...c, inPoint: clamp(c.inPoint + dt, 0, c.outPoint - 0.1), timelineStart: clamp(c.timelineStart + dt, 0, total) } : c));
    if (d.kind === "broll-out" && d.id) setBrolls((b) => b.map((c) => c.id === d.id ? { ...c, outPoint: clamp(c.outPoint + dt, c.inPoint + 0.1, c.sourceDurationSec) } : c));
    tick();
  };
  const onUp = () => { drag.current = null; };
  useEffect(() => {
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pxPerSec, total]);

  // atalhos
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); del(); }
      if (e.key === "s" || e.key === "S") splitAtPlayhead();
      if (e.key === " ") { e.preventDefault(); togglePlay(); }
      if (e.key === "Escape") setSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, playhead, main, brolls, offsets, playing]);

  // ---------- concluir ----------
  const concluir = async () => {
    if (!main.length) { alert("A pista principal precisa de ao menos um clipe."); return; }
    if (!confirm("Concluir vai REFAZER o vídeo de origem (unir tudo) e RE-TRANSCREVER.\n\nOs cortes, legendas e FLOW atuais do projeto serão RESETADOS (estão cronometrados no vídeo antigo).\n\nContinuar?")) return;
    setBusy("Unindo e re-transcrevendo… (pode demorar)");
    try {
      const r = await fetch(comBase("/api/assembly/flatten"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, width, height, assembly: asm() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Falha ao unir");
      onConclude(d as FlattenResult, asm());
    } catch (e) { setBusy(null); alert("Erro ao concluir: " + (e as Error).message); }
  };

  // ---------- render de um clipe ----------
  const clipView = (c: MainClip | BrollClip, left: number, kindPrefix: "main" | "broll") => {
    const w = t2x(clipDuration(c)), on = sel === c.id, narrow = w < 54;
    const handle = (side: "in" | "out"): React.CSSProperties => ({
      position: "absolute", [side === "in" ? "left" : "right"]: 0, top: 0, bottom: 0, width: 9,
      cursor: "ew-resize", background: on ? "var(--accent)" : "rgba(255,255,255,.28)", zIndex: 2,
    });
    return (
      <div key={c.id} title={c.asset.replace(/.*\//, "")} onPointerDown={(e) => { setSel(c.id); startDrag(e, { kind: `${kindPrefix}-move` as never, id: c.id, grab: kindPrefix === "broll" ? x2t(Math.max(0, laneX(e))) - (c as BrollClip).timelineStart : 0 }); }}
        style={{ position: "absolute", left, top: 5, height: TRACK_H - 10, width: Math.max(10, w), borderRadius: 7, cursor: "grab", overflow: "hidden",
          background: kindPrefix === "main" ? "linear-gradient(180deg,#42557d,#313f5c)" : "linear-gradient(180deg,#6a4585,#4c3568)",
          border: on ? "2px solid var(--accent)" : "1px solid rgba(255,255,255,.16)", boxShadow: on ? "0 4px 14px rgba(0,0,0,.4)" : "0 1px 3px rgba(0,0,0,.3)" }}>
        <div onPointerDown={(e) => { e.stopPropagation(); setSel(c.id); startDrag(e, { kind: `${kindPrefix}-in` as never, id: c.id }); }} style={handle("in")} />
        <div onPointerDown={(e) => { e.stopPropagation(); setSel(c.id); startDrag(e, { kind: `${kindPrefix}-out` as never, id: c.id }); }} style={handle("out")} />
        {!narrow && (
          <div style={{ padding: "6px 12px", fontSize: 11, color: "#fff", pointerEvents: "none", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            <div style={{ fontWeight: 600, textOverflow: "ellipsis", overflow: "hidden" }}>{c.asset.replace(/.*\//, "")}</div>
            <div style={{ opacity: .65, fontVariantNumeric: "tabular-nums" }}>{fmt(clipDuration(c))}</div>
          </div>
        )}
      </div>
    );
  };

  const laneWidth = t2x(Math.max(total, sourceDurationSec)) + 200;
  const btn = (extra?: React.CSSProperties): React.CSSProperties => ({ background: "var(--panel3)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 12px", fontSize: 12.5, cursor: "pointer", ...extra });

  return createPortal(
    <div onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, zIndex: 960, background: "rgba(0,0,0,.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 12 }}>
      <div style={{ width: "min(1600px,98vw)", height: "95vh", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 16, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {/* cabeçalho */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "var(--panel)", borderBottom: "1px solid var(--border)" }}>
          <strong style={{ fontSize: 14 }}>Montador de origem</strong>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>una filmagens na principal · brolls por cima · S divide · Del apaga</span>
          <span style={{ flex: 1 }} />
          {busy && <span style={{ fontSize: 12, color: "var(--accent)" }}>{busy}</span>}
          <button onClick={concluir} disabled={!!busy} style={{ background: "var(--accent)", color: "#141414", fontWeight: 600, fontSize: 13, padding: "8px 20px", borderRadius: 12, border: "none", cursor: busy ? "default" : "pointer", opacity: busy ? .5 : 1 }}>Concluir</button>
          <button onClick={onClose} disabled={!!busy} style={{ fontSize: 13, padding: "8px 16px", borderRadius: 12 }}>Fechar</button>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {/* CENTRO: mídia (horizontal) + controles + timeline */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
            {/* MÍDIA — barra horizontal no topo */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--panel)", borderBottom: "1px solid var(--border)", overflowX: "auto", flexShrink: 0 }}>
              <button onClick={() => fileInput.current?.click()} style={btn({ fontWeight: 600, flexShrink: 0 })}>+ Mídia</button>
              <input ref={fileInput} type="file" accept="video/*" multiple style={{ display: "none" }} onChange={(e) => { addMedia(e.target.files); e.currentTarget.value = ""; }} />
              <span style={{ width: 1, height: 38, background: "var(--border)", flexShrink: 0 }} />
              {pool.length === 0 && <span style={{ fontSize: 12, color: "var(--faint)", whiteSpace: "nowrap" }}>Suba clipes pra unir na principal ou usar de b-roll.</span>}
              {pool.map((it, i) => (
                <div key={i} style={{ flexShrink: 0, width: 194, background: "var(--panel2)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 8px", display: "flex", flexDirection: "column", gap: 3 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={it.fileName}>{it.fileName}</div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                    <span style={{ fontSize: 10.5, color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>{fmt(it.durationSec)}</span>
                    <span style={{ display: "flex", gap: 4 }}>
                      <button onClick={() => addToMain(it)} style={btn({ fontSize: 10.5, padding: "3px 7px" })}>+ princ.</button>
                      <button onClick={() => addToBroll(it, 0)} style={btn({ fontSize: 10.5, padding: "3px 7px" })}>+ b-roll</button>
                    </span>
                  </div>
                </div>
              ))}
            </div>
            {/* controles da timeline */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--panel)", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
              <button onClick={togglePlay} style={btn({ fontWeight: 600, minWidth: 96 })}>{playing ? "❚❚ Pausar" : "▶ Tocar"}</button>
              <span style={{ fontSize: 13, color: "var(--text)", fontVariantNumeric: "tabular-nums", minWidth: 116 }}>{fmt(playhead)} <span style={{ color: "var(--faint)" }}>/ {fmt(total)}</span></span>
              <span style={{ flex: 1 }} />
              <button onClick={splitAtPlayhead} style={btn()} title="Dividir no playhead (S)">✂ Dividir</button>
              <button onClick={del} disabled={!sel} style={btn({ opacity: sel ? 1 : .4 })} title="Apagar selecionado (Del)">🗑 Apagar</button>
              <span style={{ width: 1, height: 22, background: "var(--border)", margin: "0 4px" }} />
              <span style={{ fontSize: 11, color: "var(--muted)" }}>Zoom</span>
              <input type="range" min={5} max={400} step={1} value={pxPerSec} onChange={(e) => setPxPerSec(Number(e.target.value))} style={{ width: 120, accentColor: "var(--accent)" }} />
              <button onClick={fitZoom} style={btn()} title="Ajustar à janela">Ajustar</button>
            </div>

            {/* TIMELINE: gutter fixo (cabeçalhos) + lane rolável */}
            <div style={{ flex: 1, minHeight: 0, display: "flex", background: "var(--panel2)" }}>
              {/* GUTTER fixo — canto da régua + cabeçalhos das pistas */}
              <div style={{ width: GUTTER, flexShrink: 0, borderRight: "1px solid var(--border)", background: "var(--panel)", zIndex: 4 }}>
                <div style={{ height: RULER_H, borderBottom: "1px solid var(--border)" }} />
                {([["Principal", "#5a78c8"], ["B-roll 1", "#9a5ac8"], ["B-roll 2", "#9a5ac8"]] as const).map(([lbl, col]) => (
                  <div key={lbl} style={{ height: TRACK_H, display: "flex", alignItems: "center", gap: 8, padding: "0 12px", borderBottom: "1px solid var(--border)" }}>
                    <span style={{ width: 4, height: 24, borderRadius: 2, background: col }} />
                    <span style={{ fontSize: 11.5, color: "var(--text)", fontWeight: 500 }}>{lbl}</span>
                  </div>
                ))}
              </div>
              {/* LANE rolável */}
              <div ref={laneRef} style={{ flex: 1, minWidth: 0, overflowX: "auto", overflowY: "hidden", position: "relative" }} onPointerDown={onLanePointerDown}>
                <div style={{ position: "relative", width: laneWidth, height: RULER_H + TRACK_H * (1 + BROLL_TRACKS) }}>
                  {/* fundos de pista */}
                  {[0, 1, 2].map((i) => (
                    <div key={i} style={{ position: "absolute", left: 0, right: 0, top: RULER_H + i * TRACK_H, height: TRACK_H, background: i === 0 ? "rgba(90,120,200,.06)" : "rgba(154,90,200,.055)", borderBottom: "1px solid var(--border)" }} />
                  ))}
                  {/* régua com timecodes */}
                  <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: RULER_H, borderBottom: "1px solid var(--border)", background: "var(--panel)" }}>
                    {(() => { const step = rulerStep(pxPerSec); const marks: number[] = []; for (let s = 0; s <= total + step; s += step) marks.push(s); return marks.map((s) => (
                      <div key={s} style={{ position: "absolute", left: t2x(s), top: 0, bottom: 0, borderLeft: "1px solid rgba(255,255,255,.14)" }}>
                        <span style={{ position: "absolute", left: 5, top: 7, fontSize: 10, color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>{tc(s)}</span>
                      </div>
                    )); })()}
                  </div>
                  {/* clipes: principal */}
                  <div style={{ position: "absolute", left: 0, right: 0, top: RULER_H, height: TRACK_H }}>
                    {main.map((c, i) => clipView(c, t2x(offsets[i]), "main"))}
                  </div>
                  {/* clipes: b-roll */}
                  {Array.from({ length: BROLL_TRACKS }).map((_, tr) => (
                    <div key={tr} style={{ position: "absolute", left: 0, right: 0, top: RULER_H + (1 + tr) * TRACK_H, height: TRACK_H }}>
                      {brolls.filter((b) => b.trackIndex === tr).map((c) => clipView(c, t2x(c.timelineStart), "broll"))}
                    </div>
                  ))}
                  {/* playhead + alça */}
                  <div style={{ position: "absolute", left: t2x(playhead), top: 0, bottom: 0, width: 2, background: "var(--accent)", pointerEvents: "none", zIndex: 6 }}>
                    <div style={{ position: "absolute", left: -6, top: 0, width: 14, height: 11, background: "var(--accent)", clipPath: "polygon(0 0,100% 0,50% 100%)" }} />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* PREVIEW — painel vertical à direita, no formato do projeto (igual o studio) */}
          <div style={{ flex: "0 0 auto", width: "clamp(360px, 38vw, 620px)", borderLeft: "1px solid var(--border)", background: "#0a0a0a", display: "grid", placeItems: "center", padding: 16, overflow: "hidden" }}>
            <div style={{ position: "relative", height: "100%", aspectRatio: `${width > 0 ? width : 9} / ${height > 0 ? height : 16}`, maxWidth: "100%", background: "#000", borderRadius: 10, overflow: "hidden", boxShadow: "0 10px 34px rgba(0,0,0,.5)" }}>
              {/* principal: contido no frame do projeto (letterbox), igual ao que o Concluir gera */}
              <video ref={videoRef} onTimeUpdate={onMainTime} onEnded={onMainTime} playsInline style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", background: "#000" }} />
              {/* overlay do b-roll: cobre o frame (como no flatten), mudo */}
              <video ref={brollVideoRef} muted playsInline style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", display: brollActive ? "block" : "none" }} />
              {brollActive && <span style={{ position: "absolute", right: 8, top: 8, fontSize: 10, fontWeight: 700, letterSpacing: .5, color: "#fff", background: "rgba(154,90,200,.9)", padding: "2px 8px", borderRadius: 999, zIndex: 2 }}>B-ROLL</span>}
              <button onClick={togglePlay} title="Tocar/Pausar (espaço)" style={{ position: "absolute", left: 10, bottom: 10, width: 40, height: 40, borderRadius: 999, border: "none", background: "rgba(0,0,0,.6)", color: "#fff", fontSize: 15, cursor: "pointer", zIndex: 2 }}>{playing ? "❚❚" : "▶"}</button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
