import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { comBase } from "../../os-session";
import type { Assembly, MainClip, BrollClip, ClipTransform } from "../../../../shared/assembly";
import { BROLL_TRACKS, clipDuration, mainClipOffsets, assemblyDuration, getTransform, DEFAULT_TRANSFORM, mainSpans, newMaterialRegions } from "../../../../shared/assembly";
import type { TranscriptSegment } from "../../../../shared/timeline";

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
type FlattenResult = {
  videoFile: string; durationSec: number; width: number; height: number;
  /** modo "reset": transcrição completa do vídeo novo. */
  transcript?: unknown; language?: string;
  /** modo "remap": só os segmentos do material NOVO, já no tempo da timeline nova. */
  newSegments?: TranscriptSegment[];
};
/** Como o projeto é tratado ao concluir: realocar (padrão) ou recomeçar do zero. */
export type ConcludeMode = "remap" | "reset";

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
  onConclude: (result: FlattenResult, assembly: Assembly, opts: { mode: ConcludeMode; oldAssembly: Assembly }) => void;
  onClose: () => void;
}) {
  const [main, setMain] = useState<MainClip[]>(() =>
    initial?.main?.length ? initial.main
      : [{ id: uid(), asset: sourceVideoUrl, inPoint: 0, outPoint: sourceDurationSec || 1, sourceDurationSec: sourceDurationSec || 1, transform: { ...DEFAULT_TRANSFORM } }]);
  const [brolls, setBrolls] = useState<BrollClip[]>(() => initial?.brolls ?? []);
  const [pool, setPool] = useState<PoolItem[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [pxPerSec, setPxPerSec] = useState(40);
  const [playhead, setPlayhead] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(true); // guia fixa do frame 9:16 no preview
  const [resetTudo, setResetTudo] = useState(false); // "recomeçar do zero" (re-transcrever e limpar)
  const [erro, setErro] = useState<string | null>(null); // banner de erro (não usa alert nativo — some no iframe)
  const [confirmar, setConfirmar] = useState<null | { mode: ConcludeMode; novo: Assembly; regioes: Array<{ start: number; end: number }>; novoSeg: number }>(null);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  /**
   * A montagem de ONDE viemos — é ela que define o mapa "tempo antigo → tempo novo" ao
   * concluir. Sem montagem salva, o vídeo atual É a montagem antiga (um clipe inteiro).
   * Congelada no mount: o estado `main`/`brolls` muda enquanto o usuário edita.
   */
  const oldAssembly = useRef<Assembly>(
    initial?.main?.length ? initial
      : { version: 1, main: [{ id: "src", asset: sourceVideoUrl, inPoint: 0, outPoint: sourceDurationSec || 1, sourceDurationSec: sourceDurationSec || 1, transform: { ...DEFAULT_TRANSFORM } }], brolls: [] },
  ).current;

  const fileInput = useRef<HTMLInputElement | null>(null);
  const laneRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const drag = useRef<null | { kind: "playhead" | "main-move" | "main-in" | "main-out" | "broll-move" | "broll-in" | "broll-out"; id?: string; lastT?: number; grab?: number }>(null);

  const total = useMemo(() => Math.max(assemblyDuration({ version: 1, main, brolls }), 1), [main, brolls]);
  const offsets = useMemo(() => mainClipOffsets({ version: 1, main, brolls }), [main, brolls]);
  const asm = (): Assembly => ({ version: 1, main, brolls });

  // ---------- transformação (escala/opacidade/velocidade/posição) ----------
  const spd = (c: MainClip | BrollClip) => getTransform(c).speed; // velocidade efetiva (>0)
  const selClip = useMemo<MainClip | BrollClip | null>(
    () => main.find((c) => c.id === sel) ?? brolls.find((c) => c.id === sel) ?? null, [sel, main, brolls]);
  /** Atualiza o transform do clipe (principal OU b-roll) por id. */
  const patchTransform = (id: string, patch: Partial<ClipTransform>) => {
    setMain((m) => m.map((c) => (c.id === id ? { ...c, transform: { ...getTransform(c), ...patch } } : c)));
    setBrolls((b) => b.map((c) => (c.id === id ? { ...c, transform: { ...getTransform(c), ...patch } } : c)));
  };
  const resetTransform = (id: string) => patchTransform(id, { ...DEFAULT_TRANSFORM });

  // ---------- manipulação no PREVIEW (arrastar p/ mover · alças p/ escalar) ----------
  const stageRef = useRef<HTMLDivElement | null>(null);
  const pvDrag = useRef<null | {
    mode: "move" | "scale"; id: string; sx: number; sy: number;
    startX: number; startY: number; startScale: number; sw: number; sh: number; cx: number; cy: number; startDist: number;
  }>(null);
  const pvDown = (e: React.PointerEvent, mode: "move" | "scale") => {
    if (!selClip) return;
    e.stopPropagation();
    const st = stageRef.current?.getBoundingClientRect(); if (!st) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const t = getTransform(selClip);
    const cx = st.left + st.width / 2 + t.x * st.width;   // centro do box na tela
    const cy = st.top + st.height / 2 + t.y * st.height;
    pvDrag.current = { mode, id: selClip.id, sx: e.clientX, sy: e.clientY, startX: t.x, startY: t.y, startScale: t.scale, sw: st.width, sh: st.height, cx, cy, startDist: Math.hypot(e.clientX - cx, e.clientY - cy) || 1 };
  };
  const pvMove = (e: React.PointerEvent) => {
    const d = pvDrag.current; if (!d) return;
    if (d.mode === "move") {
      patchTransform(d.id, { x: d.startX + (e.clientX - d.sx) / d.sw, y: d.startY + (e.clientY - d.sy) / d.sh });
    } else {
      const dist = Math.hypot(e.clientX - d.cx, e.clientY - d.cy);
      patchTransform(d.id, { scale: clamp(d.startScale * (dist / d.startDist), 0.1, 5) });
    }
  };
  const pvUp = (e: React.PointerEvent) => { pvDrag.current = null; (e.target as Element).releasePointerCapture?.(e.pointerId); };
  /** CSS transform de um clipe (bate com o overlay do flatten: translate em % do frame + scale). */
  const cssTransform = (t: ClipTransform): React.CSSProperties => ({
    transform: `translate(${t.x * 100}%, ${t.y * 100}%) scale(${t.scale})`, transformOrigin: "center center", opacity: t.opacity,
  });
  /** true se escala/posição/opacidade estão neutras (a velocidade tem badge próprio). */
  const isDefaultXf = (c: MainClip | BrollClip) => { const t = getTransform(c); return t.scale === 1 && t.x === 0 && t.y === 0 && t.opacity === 1; };
  /** Seleciona um clipe e leva o playhead pra dentro dele (pra aparecer no preview). `left` = px do início. */
  const selectClip = (c: MainClip | BrollClip, left: number) => {
    setSel(c.id);
    const startT = x2t(left), endT = startT + clipDuration(c);
    if (playhead < startT || playhead >= endT) {
      setPlaying(false); videoRef.current?.pause(); brollVideoRef.current?.pause();
      setPlayhead(clamp(startT + 0.05, 0, total));
    }
  };

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
      // tempo dentro do clipe FONTE = tempo na timeline × velocidade.
      if (t >= o - 1e-3 && t < o + d - 1e-3) return { idx: i, clip: main[i], srcTime: main[i].inPoint + (t - o) * spd(main[i]) };
    }
    if (main.length) { const i = main.length - 1; return { idx: i, clip: main[i], srcTime: main[i].outPoint }; }
    return null;
  };
  /** B-roll ativo no tempo t (o último do array = o que fica por cima, igual ao flatten). */
  const brollAt = (t: number) => {
    let f: BrollClip | null = null;
    for (const b of brolls) if (t >= b.timelineStart - 1e-3 && t < b.timelineStart + clipDuration(b) - 1e-3) f = b;
    return f ? { clip: f, srcTime: f.inPoint + (t - f.timelineStart) * spd(f) } : null;
  };
  const syncMain = (t: number, play: boolean) => {
    const v = videoRef.current; if (!v) return;
    const m = mainAt(t); if (!m) { v.pause(); return; }
    v.playbackRate = spd(m.clip); // velocidade do clipe no preview
    if (loadedMain.current !== m.clip.asset) {
      loadedMain.current = m.clip.asset; v.src = comBase(m.clip.asset);
      v.onloadedmetadata = () => { v.currentTime = m.srcTime; v.playbackRate = spd(m.clip); if (play) v.play().catch(() => {}); };
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
    bv.playbackRate = spd(b.clip);
    if (loadedBroll.current !== b.clip.asset) {
      loadedBroll.current = b.clip.asset; bv.src = comBase(b.clip.asset);
      bv.onloadedmetadata = () => { bv.currentTime = b.srcTime; bv.playbackRate = spd(b.clip); if (playing) bv.play().catch(() => {}); };
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
    // tempo na timeline = tempo fonte decorrido ÷ velocidade.
    const ph = offsets[m.idx] + (v.currentTime - m.clip.inPoint) / spd(m.clip);
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
    } catch (e) { setErro("Erro ao enviar mídia: " + (e as Error).message); } finally { setBusy(null); }
  };
  const addToMain = (it: PoolItem) => {
    setMain((m) => [...m, { id: uid(), asset: it.asset, inPoint: 0, outPoint: it.durationSec, sourceDurationSec: it.durationSec, transform: { ...DEFAULT_TRANSFORM } }]);
  };
  const addToBroll = (it: PoolItem, trackIndex: number) => {
    setBrolls((b) => [...b, { id: uid(), asset: it.asset, inPoint: 0, outPoint: Math.min(it.durationSec, 4), sourceDurationSec: it.durationSec, trackIndex, timelineStart: snap(playhead), muted: true, transform: { ...DEFAULT_TRANSFORM } }]);
  };

  // ---------- edição de clipes ----------
  const del = () => { if (!sel) return; setMain((m) => m.filter((c) => c.id !== sel)); setBrolls((b) => b.filter((c) => c.id !== sel)); setSel(null); };
  const splitAtPlayhead = () => {
    // principal: divide o clipe sob o playhead
    const idx = offsets.findIndex((o, i) => playhead > o + 0.05 && playhead < o + clipDuration(main[i]) - 0.05);
    if (idx >= 0) {
      const c = main[idx], cutSrc = c.inPoint + (playhead - offsets[idx]) * spd(c);
      const a: MainClip = { ...c, id: uid(), outPoint: cutSrc };
      const b: MainClip = { ...c, id: uid(), inPoint: cutSrc };
      setMain((m) => [...m.slice(0, idx), a, b, ...m.slice(idx + 1)]);
      return;
    }
    // b-roll: divide o que estiver sob o playhead
    const bi = brolls.findIndex((b) => playhead > b.timelineStart + 0.05 && playhead < b.timelineStart + clipDuration(b) - 0.05);
    if (bi >= 0) {
      const c = brolls[bi], off = playhead - c.timelineStart, cutSrc = c.inPoint + off * spd(c);
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
    // aparo é em tempo FONTE; o arraste é em tempo de TIMELINE → multiplica pela velocidade.
    if (d.kind === "main-in" && d.id) setMain((m) => m.map((c) => c.id === d.id ? { ...c, inPoint: clamp(c.inPoint + dt * spd(c), 0, c.outPoint - 0.1) } : c));
    if (d.kind === "main-out" && d.id) setMain((m) => m.map((c) => c.id === d.id ? { ...c, outPoint: clamp(c.outPoint + dt * spd(c), c.inPoint + 0.1, c.sourceDurationSec) } : c));
    if (d.kind === "broll-move" && d.id) setBrolls((b) => b.map((c) => c.id === d.id ? { ...c, timelineStart: clamp(snap(t - (d.grab ?? 0)), 0, total) } : c));
    if (d.kind === "broll-in" && d.id) setBrolls((b) => b.map((c) => c.id === d.id ? { ...c, inPoint: clamp(c.inPoint + dt * spd(c), 0, c.outPoint - 0.1), timelineStart: clamp(c.timelineStart + dt, 0, total) } : c));
    if (d.kind === "broll-out" && d.id) setBrolls((b) => b.map((c) => c.id === d.id ? { ...c, outPoint: clamp(c.outPoint + dt * spd(c), c.inPoint + 0.1, c.sourceDurationSec) } : c));
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
  // IMPORTANTE: nada de confirm()/alert() nativos aqui. Dentro do iframe do OS o navegador
  // pode SUPRIMIR diálogos (o checkbox "impedir mais diálogos") — o confirm volta false
  // silencioso e o Concluir "nao fazia nada". A confirmação é um modal in-app; o erro vira
  // um banner visível. Assim funciona igual no OS e no standalone.
  const pedirConcluir = () => {
    setErro(null);
    if (!main.length) { setErro("A pista principal precisa de ao menos um clipe."); return; }
    try {
      const novo = asm();
      const regioes = newMaterialRegions(mainSpans(oldAssembly), mainSpans(novo));
      const mode: "remap" | "reset" = resetTudo ? "reset" : "remap";
      const novoSeg = regioes.reduce((a, r) => a + (r.end - r.start), 0);
      setConfirmar({ mode, novo, regioes, novoSeg });
    } catch (e) { setErro("Não consegui preparar o Concluir: " + (e as Error).message); }
  };
  const executarConcluir = async () => {
    const cfg = confirmar; if (!cfg) return;
    setConfirmar(null);
    const { mode, novo, regioes } = cfg;
    setBusy(mode === "reset" ? "Unindo e re-transcrevendo tudo… (pode demorar)"
      : regioes.length ? "Unindo e transcrevendo o material novo…" : "Unindo o vídeo…");
    try {
      const r = await fetch(comBase("/api/assembly/flatten"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, width, height, assembly: novo, mode, newRegions: regioes }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Falha ao unir");
      onConclude(d as FlattenResult, novo, { mode, oldAssembly });
    } catch (e) { setBusy(null); setErro("Erro ao concluir: " + (e as Error).message); }
  };

  // ---------- render de um clipe ----------
  const clipView = (c: MainClip | BrollClip, left: number, kindPrefix: "main" | "broll") => {
    const w = t2x(clipDuration(c)), on = sel === c.id, narrow = w < 54;
    const handle = (side: "in" | "out"): React.CSSProperties => ({
      position: "absolute", [side === "in" ? "left" : "right"]: 0, top: 0, bottom: 0, width: 9,
      cursor: "ew-resize", background: on ? "var(--accent)" : "rgba(255,255,255,.28)", zIndex: 2,
    });
    return (
      <div key={c.id} title={c.asset.replace(/.*\//, "")} onPointerDown={(e) => { selectClip(c, left); startDrag(e, { kind: `${kindPrefix}-move` as never, id: c.id, grab: kindPrefix === "broll" ? x2t(Math.max(0, laneX(e))) - (c as BrollClip).timelineStart : 0 }); }}
        style={{ position: "absolute", left, top: 5, height: TRACK_H - 10, width: Math.max(10, w), borderRadius: 7, cursor: "grab", overflow: "hidden",
          background: kindPrefix === "main" ? "linear-gradient(180deg,#42557d,#313f5c)" : "linear-gradient(180deg,#6a4585,#4c3568)",
          border: on ? "2px solid var(--accent)" : "1px solid rgba(255,255,255,.16)", boxShadow: on ? "0 4px 14px rgba(0,0,0,.4)" : "0 1px 3px rgba(0,0,0,.3)" }}>
        <div onPointerDown={(e) => { e.stopPropagation(); selectClip(c, left); startDrag(e, { kind: `${kindPrefix}-in` as never, id: c.id }); }} style={handle("in")} />
        <div onPointerDown={(e) => { e.stopPropagation(); selectClip(c, left); startDrag(e, { kind: `${kindPrefix}-out` as never, id: c.id }); }} style={handle("out")} />
        {!narrow && (
          <div style={{ padding: "6px 12px", fontSize: 11, color: "#fff", pointerEvents: "none", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            <div style={{ fontWeight: 600, textOverflow: "ellipsis", overflow: "hidden" }}>{c.asset.replace(/.*\//, "")}</div>
            <div style={{ opacity: .65, fontVariantNumeric: "tabular-nums", display: "flex", gap: 6 }}>
              <span>{fmt(clipDuration(c))}</span>
              {spd(c) !== 1 && <span title="velocidade">· {spd(c).toFixed(2).replace(/\.?0+$/, "")}×</span>}
              {!isDefaultXf(c) && <span title="transformação aplicada">· ◲</span>}
            </div>
          </div>
        )}
      </div>
    );
  };

  const laneWidth = t2x(Math.max(total, sourceDurationSec)) + 200;
  const btn = (extra?: React.CSSProperties): React.CSSProperties => ({ background: "var(--panel3)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 12px", fontSize: 12.5, cursor: "pointer", ...extra });

  // transforms ATIVOS no playhead (aplicados no preview) + box do clipe selecionado (se visível).
  const am = mainAt(playhead), ab = brollAt(playhead);
  const mainXf = am ? getTransform(am.clip) : DEFAULT_TRANSFORM;
  const brollXf = ab ? getTransform(ab.clip) : DEFAULT_TRANSFORM;
  const boxXf = selClip && ab && ab.clip.id === selClip.id ? getTransform(ab.clip)
    : selClip && am && am.clip.id === selClip.id ? getTransform(am.clip) : null;

  // GUIA 9:16 — retângulo do frame de reels encaixado (contain) e centralizado no stage.
  // Se o projeto já é 9:16, o retângulo cobre o stage inteiro (a guia vira o próprio contorno).
  const stageAR = (width > 0 ? width : 9) / (height > 0 ? height : 16);
  const targetAR = 9 / 16;
  const guideW = stageAR > targetAR ? (targetAR / stageAR) * 100 : 100;
  const guideH = stageAR > targetAR ? 100 : (stageAR / targetAR) * 100;
  const guideL = (100 - guideW) / 2, guideT = (100 - guideH) / 2;

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
          <label title="Por padrão o projeto é REALOCADO (cortes, legendas e FLUXO são reposicionados no tempo novo). Marque para APAGAR tudo e re-transcrever do zero."
            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: resetTudo ? "var(--red)" : "var(--muted)", cursor: "pointer", whiteSpace: "nowrap" }}>
            <input type="checkbox" checked={resetTudo} onChange={(e) => setResetTudo(e.target.checked)} />
            recomeçar do zero
          </label>
          <button onClick={pedirConcluir} disabled={!!busy} style={{ background: "var(--accent)", color: "#141414", fontWeight: 600, fontSize: 13, padding: "8px 20px", borderRadius: 12, border: "none", cursor: busy ? "default" : "pointer", opacity: busy ? .5 : 1 }}>Concluir</button>
          <button onClick={onClose} disabled={!!busy} style={{ fontSize: 13, padding: "8px 16px", borderRadius: 12 }}>Fechar</button>
        </div>

        {/* banner de erro (substitui o alert nativo, que some dentro do iframe do OS) */}
        {erro && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", background: "rgba(230,70,70,.12)", borderBottom: "1px solid var(--red)", color: "var(--red)", fontSize: 12.5 }}>
            <span style={{ flex: 1 }}>{erro}</span>
            <button onClick={() => setErro(null)} style={{ background: "transparent", border: "1px solid var(--red)", color: "var(--red)", borderRadius: 8, padding: "2px 10px", fontSize: 12, cursor: "pointer" }}>OK</button>
          </div>
        )}

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

          {/* PREVIEW + PROPRIEDADES — painel vertical à direita, no formato do projeto */}
          <div style={{ flex: "0 0 auto", width: "clamp(380px, 40vw, 640px)", borderLeft: "1px solid var(--border)", background: "#0a0a0a", display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ flex: 1, minHeight: 0, display: "grid", placeItems: "center", padding: 16, overflow: "hidden" }}>
              <div ref={stageRef} style={{ position: "relative", height: "100%", aspectRatio: `${width > 0 ? width : 9} / ${height > 0 ? height : 16}`, maxWidth: "100%", background: "#000", borderRadius: 10, overflow: "hidden", boxShadow: "0 10px 34px rgba(0,0,0,.5)" }}>
                {/* principal: contido no frame do projeto (letterbox) + transform do clipe ativo */}
                <video ref={videoRef} onTimeUpdate={onMainTime} onEnded={onMainTime} playsInline style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", background: "#000", ...cssTransform(mainXf) }} />
                {/* overlay do b-roll: cobre o frame (como no flatten), mudo, + transform */}
                <video ref={brollVideoRef} muted playsInline style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", display: brollActive ? "block" : "none", ...cssTransform(brollXf) }} />
                {brollActive && <span style={{ position: "absolute", right: 8, top: 8, fontSize: 10, fontWeight: 700, letterSpacing: .5, color: "#fff", background: "rgba(154,90,200,.9)", padding: "2px 8px", borderRadius: 999, zIndex: 2 }}>B-ROLL</span>}
                {/* box de transformação do clipe SELECIONADO (arrastar = mover · cantos = escalar) */}
                {boxXf && (
                  <div onPointerDown={(e) => pvDown(e, "move")} onPointerMove={pvMove} onPointerUp={pvUp}
                    style={{ position: "absolute", boxSizing: "border-box",
                      left: `${((1 - boxXf.scale) / 2 + boxXf.x) * 100}%`, top: `${((1 - boxXf.scale) / 2 + boxXf.y) * 100}%`,
                      width: `${boxXf.scale * 100}%`, height: `${boxXf.scale * 100}%`,
                      border: "1.5px dashed var(--accent)", cursor: "move", zIndex: 3, touchAction: "none" }}>
                    {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                      <div key={corner} onPointerDown={(e) => { e.stopPropagation(); pvDown(e, "scale"); }} onPointerMove={pvMove} onPointerUp={pvUp}
                        style={{ position: "absolute", width: 12, height: 12, background: "var(--accent)", borderRadius: 2, touchAction: "none",
                          left: corner.includes("w") ? -6 : undefined, right: corner.includes("e") ? -6 : undefined,
                          top: corner.includes("n") ? -6 : undefined, bottom: corner.includes("s") ? -6 : undefined,
                          cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize" }} />
                    ))}
                  </div>
                )}
                {/* GUIA 9:16 fixa — contorno do frame + centro + terços. Não captura cliques. */}
                {showGuide && (
                  <div style={{ position: "absolute", left: `${guideL}%`, top: `${guideT}%`, width: `${guideW}%`, height: `${guideH}%`, pointerEvents: "none", zIndex: 5, boxSizing: "border-box", border: "2px solid rgba(255,214,10,.9)", boxShadow: "0 0 0 100vmax rgba(0,0,0,.28)" }}>
                    {/* linhas de terços (leves) */}
                    {[33.333, 66.666].map((p) => <div key={"v" + p} style={{ position: "absolute", left: `${p}%`, top: 0, bottom: 0, width: 1, background: "rgba(255,214,10,.28)" }} />)}
                    {[33.333, 66.666].map((p) => <div key={"h" + p} style={{ position: "absolute", top: `${p}%`, left: 0, right: 0, height: 1, background: "rgba(255,214,10,.28)" }} />)}
                    {/* cruz de centro (referência fixa) */}
                    <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "rgba(255,214,10,.55)" }} />
                    <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 1, background: "rgba(255,214,10,.55)" }} />
                    <span style={{ position: "absolute", left: 4, top: 3, fontSize: 9.5, fontWeight: 700, letterSpacing: .5, color: "rgba(255,214,10,.95)", textShadow: "0 1px 2px rgba(0,0,0,.8)" }}>9:16</span>
                  </div>
                )}
                <button onClick={() => setShowGuide((g) => !g)} title="Mostrar/ocultar a guia 9:16" style={{ position: "absolute", right: 10, bottom: 10, height: 28, padding: "0 10px", borderRadius: 8, border: "none", background: showGuide ? "rgba(255,214,10,.9)" : "rgba(0,0,0,.6)", color: showGuide ? "#141414" : "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", zIndex: 6 }}>⊞ 9:16</button>
                <button onClick={togglePlay} title="Tocar/Pausar (espaço)" style={{ position: "absolute", left: 10, bottom: 10, width: 40, height: 40, borderRadius: 999, border: "none", background: "rgba(0,0,0,.6)", color: "#fff", fontSize: 15, cursor: "pointer", zIndex: 6 }}>{playing ? "❚❚" : "▶"}</button>
              </div>
            </div>

            {/* PAINEL DE PROPRIEDADES do clipe selecionado (Effect Controls) */}
            {selClip && (() => {
              const t = getTransform(selClip);
              const isMain = main.some((c) => c.id === selClip.id);
              const set = (p: Partial<ClipTransform>) => patchTransform(selClip.id, p);
              const field = (label: string, value: number, unit: string, min: number, max: number, step: number, toT: (v: number) => Partial<ClipTransform>) => (
                <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "7px 0" }}>
                  <span style={{ width: 76, fontSize: 11.5, color: "var(--muted)" }}>{label}</span>
                  <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(toT(Number(e.target.value)))} style={{ flex: 1, accentColor: "var(--accent)" }} />
                  <input type="number" min={min} max={max} step={step} value={value} onChange={(e) => set(toT(Number(e.target.value)))} style={{ width: 62, fontSize: 12, textAlign: "right" }} />
                  <span style={{ width: 14, fontSize: 11, color: "var(--faint)" }}>{unit}</span>
                </div>
              );
              return (
                <div style={{ flex: "0 0 auto", borderTop: "1px solid var(--border)", background: "var(--panel)", padding: "10px 14px", maxHeight: "44%", overflowY: "auto" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <strong style={{ fontSize: 12.5 }}>Transformação</strong>
                    <span style={{ fontSize: 11, color: "var(--muted)" }}>{isMain ? "clipe principal" : "b-roll"}</span>
                    <span style={{ flex: 1 }} />
                    <button onClick={() => resetTransform(selClip.id)} style={btn({ fontSize: 11, padding: "3px 10px" })}>Resetar</button>
                  </div>
                  {field("Escala", Math.round(t.scale * 100), "%", 10, 500, 1, (v) => ({ scale: clamp(v, 10, 500) / 100 }))}
                  {field("Opacidade", Math.round(t.opacity * 100), "%", 0, 100, 1, (v) => ({ opacity: clamp(v, 0, 100) / 100 }))}
                  {field("Velocidade", +t.speed.toFixed(2), "×", 0.25, 4, 0.05, (v) => ({ speed: clamp(v, 0.25, 4) }))}
                  {field("Posição X", Math.round(t.x * 100), "%", -100, 100, 1, (v) => ({ x: clamp(v, -100, 100) / 100 }))}
                  {field("Posição Y", Math.round(t.y * 100), "%", -100, 100, 1, (v) => ({ y: clamp(v, -100, 100) / 100 }))}
                  <div style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 4 }}>Arraste no preview pra mover · alças dos cantos pra escalar · a velocidade muda a duração na timeline.</div>
                </div>
              );
            })()}
          </div>
        </div>

        {/* CONFIRMAÇÃO in-app do Concluir (substitui o confirm() nativo, que é suprimido no iframe) */}
        {confirmar && (
          <div onPointerDown={(e) => e.stopPropagation()}
            style={{ position: "absolute", inset: 0, zIndex: 20, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
            <div style={{ width: "min(520px, 92%)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 14, padding: "20px 22px", boxShadow: "0 20px 60px rgba(0,0,0,.5)" }}>
              <strong style={{ fontSize: 15, display: "block", marginBottom: 12, color: confirmar.mode === "reset" ? "var(--red)" : "var(--text)" }}>
                {confirmar.mode === "reset" ? "Recomeçar do zero?" : "Concluir e aplicar?"}
              </strong>
              <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.55 }}>
                {confirmar.mode === "reset" ? (
                  <>Vai refazer o vídeo de origem e <strong style={{ color: "var(--text)" }}>RE-TRANSCREVER tudo</strong>. Os cortes, legendas e FLOW atuais serão <strong style={{ color: "var(--red)" }}>APAGADOS</strong>.</>
                ) : (
                  <>
                    O vídeo de origem é refeito e o projeto é <strong style={{ color: "var(--text)" }}>realocado</strong> — cortes, legendas, zooms, popups e FLOW são reposicionados no tempo novo, nada é resetado.<br />
                    {confirmar.novoSeg > 0.15
                      ? <>Material novo (<strong style={{ color: "var(--text)" }}>{confirmar.novoSeg.toFixed(1)}s</strong>) será transcrito e encaixado.</>
                      : <>Nenhum material novo — nada precisa ser transcrito.</>}<br />
                    Só o que estava em trechos removidos é descartado.
                  </>
                )}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
                <button onClick={() => setConfirmar(null)} style={btn({ padding: "8px 16px" })}>Cancelar</button>
                <button onClick={executarConcluir} style={{ background: confirmar.mode === "reset" ? "var(--red)" : "var(--accent)", color: confirmar.mode === "reset" ? "#fff" : "#141414", fontWeight: 600, fontSize: 13, padding: "8px 20px", borderRadius: 10, border: "none", cursor: "pointer" }}>
                  {confirmar.mode === "reset" ? "Apagar e recomeçar" : "Concluir"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
