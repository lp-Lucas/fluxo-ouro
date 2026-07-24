import { useEffect, useMemo, useRef, useState } from "react";
import type { Cut, Word, Caption, TranscriptSegment } from "../../../../shared/timeline";
import {
  resolveCaptionLines, materializeCaptions, retimeLine, splitLineAt, mergeLines,
  lineText, captionFromText, distributeWords, needsTimingRepair, type CaptionLine,
} from "../../../../shared/captions";
import { capBar, capChip, capBtnMuted, capGroup, capGroupBtn, capGroupSep, capGroupLabel } from "../legenda/CaptionToolbar";
import { comBase } from "../../os-session";

/**
 * Timeline visual de cortes com forma de onda do áudio + ZOOM.
 * - Fundo: waveform (decodificada do vídeo) → mostra fala x silêncio.
 * - Blocos vermelhos = cortes. Arraste as BORDAS p/ ajustar (ímã nas palavras),
 *   arraste o MEIO p/ mover, clique no vazio p/ buscar o frame, arraste no vazio
 *   p/ criar um corte novo.
 * - CAMADA DE LEGENDAS (faixa de baixo, azul): mesma gramática — arraste bordas p/
 *   ajustar, meio p/ mover, vazio p/ criar. Só aparece com `onCaptionsChange`.
 * - Zoom (botões/slider) amplia a faixa → rola na horizontal (barra ou shift+scroll).
 *   O playhead é mantido à vista durante o play.
 * Edita `cuts`/`captions` direto — undo/redo de graça.
 *
 * As duas faixas vivem no MESMO canvas/scroll de propósito: é o que mantém legenda e
 * corte alinhados no mesmo tempo sob o mesmo playhead (senão desencontram no zoom).
 */

const RULER = 20;              // régua de tempo (topo)
const WAVE = 64;               // faixa da onda
const CAPS = 38;               // faixa das legendas (0 quando a camada está desligada)
const MOT = 52;                // faixa dos MOTIONS do FLOW (0 quando não há motion)
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
  // camada de legendas
  capBg: "#191919",                       // fundo da faixa (separa da onda)
  capFill: "rgba(96, 150, 255, 0.22)",
  capStroke: "rgba(140, 180, 255, 0.45)",
  capFillLocked: "rgba(96, 150, 255, 0.38)", // ajustada à mão = mais sólida
  capSel: "#8ab4ff",
  capText: "#e9efff",
  // camada de MOTIONS (roxo do FLOW)
  motBg: "#171717",
  motFill: "rgba(179, 163, 207, 0.22)",
  motStroke: "rgba(179, 163, 207, 0.5)",
  motSel: "#cbbdea",
  motText: "#efeaf7",
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
function useWaveform(file: File | null, buckets: number): Float32Array | null {
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  useEffect(() => {
    let cancel = false;
    setPeaks(null);
    if (!file) return; // sem blob ainda (abrindo projeto, streamando): a timeline já aparece, a onda entra depois
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
  | { kind: "scrub" }
  | { kind: "capEdge"; id: string; side: "start" | "end" }
  | { kind: "capMove"; id: string; grabT: number }
  | { kind: "capCreate"; t0: number }
  | { kind: "capSeekMaybe"; downX: number; t: number }
  | null;

export function CutTimeline({
  videoFile, duration, cuts, onCutsChange, words, currentTime = 0, clock, onSeek, onPlayKept, playing,
  captions, onCaptionsChange, transcript, maxWords = 7, motionGroups, onMotionMove, onClipResize,
}: {
  videoFile: File | null;
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
  /** CAMADA DE LEGENDAS — só renderiza com `onCaptionsChange` + `transcript`. */
  captions?: Caption[];
  onCaptionsChange?: (c: Caption[]) => void;
  transcript?: TranscriptSegment[];
  maxWords?: number;
  /** MOTIONS do FLOW — cada motion é um GRUPO com seus clipes (frases) em sequência. */
  motionGroups?: { id: string; at: number; clips: { phraseId: string; duration: number; label?: string; raw?: number; video?: string }[] }[];
  /** move o grupo inteiro (novo `at`). Sem isto, a camada não aparece. */
  onMotionMove?: (id: string, at: number) => void;
  /** redimensiona um clipe do grupo (nova duração de tela → re-fit no FLOW). */
  onClipResize?: (phraseId: string, duration: number) => void;
}) {
  const capsOn = !!onCaptionsChange && !!transcript;
  const capH = capsOn ? CAPS : 0;
  const CAP_TOP = RULER + WAVE;
  const motOn = !!onMotionMove && !!motionGroups && motionGroups.length > 0;
  const motH = motOn ? MOT : 0;
  const MOT_TOP = RULER + WAVE + capH;   // faixa dos motions logo abaixo das legendas
  const H = RULER + WAVE + capH + motH;
  const buckets = Math.min(6000, Math.max(800, Math.round(duration * 50)));
  const peaks = useWaveform(videoFile, buckets);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null); // container rolável (largura visível)
  const wrapRef = useRef<HTMLDivElement>(null);   // conteúdo (largura = visível × zoom)
  const [vw, setVw] = useState(800);              // largura VISÍVEL
  const [zoom, setZoom] = useState(1);
  const [sel, setSel] = useState<string | null>(null);
  const [capSel, setCapSel] = useState<string | null>(null);
  // FERRAMENTA DE RECORTE: ligada = arrastar no vazio cria/edita cortes (comportamento antigo).
  // Desligada (padrão) = arrastar move a AGULHA (scrub), como no Montador — timeline p/ navegar.
  const [recorte, setRecorte] = useState(false);
  const [motSel, setMotSel] = useState<string | null>(null);
  const [liveDur, setLiveDur] = useState<Record<string, number>>({}); // duração viva por clipe durante o resize
  useEffect(() => { setLiveDur({}); }, [motionGroups]); // reset quando os grupos mudam (re-fit aplicado)
  const drag = useRef<Drag>(null);
  const [tempCut, setTempCut] = useState<{ start: number; end: number } | null>(null);
  const [tempCap, setTempCap] = useState<{ start: number; end: number } | null>(null);

  const cw = Math.round(vw * zoom); // largura do CONTEÚDO (desenho)

  // ── camada de legendas ──
  // O que a faixa DESENHA são as linhas resolvidas (cortes já aplicados) — o mesmo que
  // o preview e o render mostram. O que ela EDITA é `captions` (tempo de fonte, sem
  // cortes), casado por id.
  const lines = useMemo(
    () => (capsOn ? resolveCaptionLines(transcript!, cuts, captions, maxWords) : []),
    [capsOn, transcript, cuts, captions, maxWords],
  );

  /**
   * Copy-on-write: enquanto ninguém mexeu, as linhas seguem derivadas da transcrição
   * (e acompanham correções de texto). O 1º ajuste congela — daí em diante a timeline
   * manda. Evita o custo de materializar quem nunca vai ajustar nada.
   */
  const baseCaptions = () => (captions?.length ? captions : materializeCaptions(transcript!, maxWords));
  const editCap = (id: string, f: (c: Caption) => Caption | null) => {
    const next = baseCaptions().flatMap((c) => (c.id === id ? ((r) => (r ? [r] : []))(f(c)) : [c]));
    onCaptionsChange!(next.sort((a, b) => a.start - b.start));
  };

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

  // MOTIONS: duração viva (durante o resize) + segmentos absolutos de cada clipe do grupo.
  const clipDur = (c: { phraseId: string; duration: number }) => liveDur[c.phraseId] ?? c.duration;
  const groupSegs = (grp: { at: number; clips: { phraseId: string; duration: number; label?: string; raw?: number; video?: string }[] }) => {
    let off = grp.at;
    return grp.clips.map((c) => { const d = clipDur(c); const seg = { ...c, start: off, end: off + d, dur: d }; off += d; return seg; });
  };
  const groupEnd = (grp: { at: number; clips: { phraseId: string; duration: number }[] }) => grp.at + grp.clips.reduce((a, c) => a + clipDur(c), 0);

  // DRAG dos clipes de motion (DOM): corpo = mover o grupo (at); borda direita = velocidade do clipe.
  const motPtr = useRef<
    | { kind: "move"; groupId: string; at0: number; total: number; startX: number }
    | { kind: "resize"; phraseId: string; startX: number; startDur: number }
    | null
  >(null);
  const startMotionMove = (e: React.PointerEvent, groupId: string, at: number, total: number) => {
    e.preventDefault(); e.stopPropagation(); setMotSel(groupId);
    motPtr.current = { kind: "move", groupId, at0: at, total, startX: e.clientX };
  };
  const startMotionResize = (e: React.PointerEvent, phraseId: string, startDur: number) => {
    e.preventDefault(); e.stopPropagation();
    motPtr.current = { kind: "resize", phraseId, startX: e.clientX, startDur };
  };
  useEffect(() => {
    const pps = cw / Math.max(0.001, duration);
    const mv = (e: PointerEvent) => {
      const d = motPtr.current; if (!d) return;
      const dt = (e.clientX - d.startX) / pps;
      if (d.kind === "move") {
        let ns = snap(d.at0 + dt);
        if (ns < 0) ns = 0; if (ns + d.total > duration) ns = Math.max(0, duration - d.total);
        onMotionMove?.(d.groupId, +ns.toFixed(3));
      } else {
        setLiveDur((prev) => ({ ...prev, [d.phraseId]: Math.max(0.5, Math.min(30, +(d.startDur + dt).toFixed(1))) }));
      }
    };
    const up = () => {
      const d = motPtr.current; motPtr.current = null;
      if (d?.kind === "resize") { const nd = liveDur[d.phraseId] ?? d.startDur; if (onClipResize && Math.abs(nd - d.startDur) > 0.05) onClipResize(d.phraseId, nd); }
    };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cw, duration, onMotionMove, onClipResize, liveDur]);

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

    // ── faixa das legendas ──
    if (capsOn) {
      g.fillStyle = COL.capBg; g.fillRect(0, CAP_TOP, cw, capH);
      g.fillStyle = COL.tick; g.fillRect(0, CAP_TOP, cw, 1);
      g.font = "11px Inter, system-ui, sans-serif";
      g.textBaseline = "middle";

      for (const l of lines) {
        const x0 = tToX(l.start), x1 = tToX(l.end);
        const w = Math.max(2, x1 - x0 - 2);
        if (x1 < -50 || x0 > cw + 50) continue; // fora da vista
        const isSel = l.id === capSel;
        g.beginPath();
        g.roundRect(x0 + 1, CAP_TOP + 5, w, capH - 11, Math.min(6, w / 2));
        g.fillStyle = l.locked ? COL.capFillLocked : COL.capFill; g.fill();
        g.strokeStyle = isSel ? COL.capSel : COL.capStroke;
        g.lineWidth = isSel ? 2 : 1; g.stroke();

        // texto recortado no bloco (só quando cabe — senão vira sujeira ilegível)
        if (w > 22) {
          g.save();
          g.beginPath(); g.roundRect(x0 + 1, CAP_TOP + 5, w, capH - 11, 6); g.clip();
          g.fillStyle = COL.capText;
          g.fillText(lineText(l), x0 + 6, CAP_TOP + capH / 2, w - 10);
          g.restore();
        }
        // alças da linha selecionada
        if (isSel) {
          g.fillStyle = COL.capSel;
          for (const x of [x0 + 1, x0 + 1 + w]) {
            g.beginPath(); g.roundRect(x - 2, CAP_TOP + 7, 4, capH - 15, 2); g.fill();
          }
        }
      }

      if (tempCap) {
        g.fillStyle = COL.temp;
        g.beginPath();
        g.roundRect(tToX(tempCap.start), CAP_TOP + 5, Math.max(2, tToX(tempCap.end) - tToX(tempCap.start)), capH - 11, 6);
        g.fill();
      }
    }

    // ── faixa dos MOTIONS (só o fundo): os clipes são <div> DOM por cima (preview + duração + ×velocidade) ──
    if (motOn) {
      g.fillStyle = COL.motBg; g.fillRect(0, MOT_TOP, cw, motH);
      g.fillStyle = COL.tick; g.fillRect(0, MOT_TOP, cw, 1);
    }
    // O playhead NÃO é desenhado aqui: ele é um <div> leve (senão a onda inteira
    // seria redesenhada a cada frame → travava o preview a ~10fps).
  }, [peaks, cuts, sel, cw, duration, tempCut, capsOn, capH, CAP_TOP, H, lines, capSel, tempCap, motOn, motH, MOT_TOP]);

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
  function hitCapEdge(x: number) {
    for (const l of lines) {
      if (Math.abs(x - tToX(l.start)) <= EDGE_PX) return { id: l.id, side: "start" as const };
      if (Math.abs(x - tToX(l.end)) <= EDGE_PX) return { id: l.id, side: "end" as const };
    }
    return null;
  }
  function hitCapBody(x: number) {
    const t = xToT(x);
    return lines.find((l) => t >= l.start && t <= l.end)?.id ?? null;
  }
  const localX = (e: React.PointerEvent) => e.clientX - wrapRef.current!.getBoundingClientRect().left;
  const localY = (e: React.PointerEvent) => e.clientY - wrapRef.current!.getBoundingClientRect().top;

  function onDown(e: React.PointerEvent) {
    wrapRef.current!.setPointerCapture(e.pointerId);
    const x = localX(e);
    const y = localY(e);

    // Faixa de MOTIONS: os clipes são <div> DOM (tratam move/resize). Aqui só o VAZIO = busca.
    if (motOn && y >= MOT_TOP) { setMotSel(null); drag.current = { kind: "scrub" }; onSeek(snap(xToT(x))); return; }

    // Faixa das legendas (entre a onda e os motions). A régua e a onda seguem sendo dos cortes.
    if (capsOn && y >= CAP_TOP && y < MOT_TOP) {
      const ce = hitCapEdge(x);
      if (ce) { setCapSel(ce.id); drag.current = { kind: "capEdge", ...ce }; return; }
      const cb = hitCapBody(x);
      if (cb) { setCapSel(cb); drag.current = { kind: "capMove", id: cb, grabT: xToT(x) }; return; }
      drag.current = { kind: "capSeekMaybe", downX: x, t: xToT(x) };
      return;
    }

    // RECORTE desligado: arrastar = mover a agulha (scrub), como no Montador. Não cria/edita cortes.
    if (!recorte) { drag.current = { kind: "scrub" }; onSeek(snap(xToT(x))); return; }
    const edge = hitEdge(x);
    if (edge) { setSel(edge.id); drag.current = { kind: "edge", ...edge }; return; }
    const body = hitBody(x);
    if (body) { setSel(body); drag.current = { kind: "move", id: body, grabT: xToT(x) }; return; }
    drag.current = { kind: "seekMaybe", downX: x, t: xToT(x) };
  }

  function onMove(e: React.PointerEvent) {
    const d = drag.current; if (!d) return;
    const x = localX(e);
    if (d.kind === "scrub") { onSeek(snap(xToT(x))); return; }
    const t = snap(xToT(x));
    if (d.kind === "seekMaybe") {
      if (Math.abs(x - d.downX) > HANDLE_MS) { drag.current = { kind: "create", t0: d.t }; setTempCut({ start: d.t, end: d.t }); }
      else return;
    }
    if (d.kind === "capSeekMaybe") {
      if (Math.abs(x - d.downX) > HANDLE_MS) { drag.current = { kind: "capCreate", t0: d.t }; setTempCap({ start: d.t, end: d.t }); }
      else return;
    }

    // ── legendas ──
    const c = drag.current!;
    if (c.kind === "capCreate") {
      setTempCap({ start: Math.min(c.t0, t), end: Math.max(c.t0, t) });
      return;
    }
    if (c.kind === "capEdge") {
      const l = lines.find((l) => l.id === c.id); if (!l) return;
      // retimeLine estica as palavras junto → o karaokê preenche a linha inteira.
      editCap(c.id, (cap) => (c.side === "start"
        ? retimeLine(cap, Math.min(t, l.end - 0.05), l.end)
        : retimeLine(cap, l.start, Math.max(t, l.start + 0.05))));
      return;
    }
    if (c.kind === "capMove") {
      const l = lines.find((l) => l.id === c.id); if (!l) return;
      const dt = xToT(x) - c.grabT;
      let ns = snap(l.start + dt);
      const span = l.end - l.start;
      if (ns < 0) ns = 0;
      if (ns + span > duration) ns = Math.max(0, duration - span);
      editCap(c.id, (cap) => retimeLine(cap, ns, ns + span));
      drag.current = { kind: "capMove", id: c.id, grabT: xToT(x) };
      return;
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
    if (d.kind === "scrub") return; // já buscou durante o arrasto
    if (d.kind === "seekMaybe") { onSeek(snap(d.t)); return; }
    if (d.kind === "capSeekMaybe") { setCapSel(null); onSeek(snap(d.t)); return; }
    if (d.kind === "capCreate" && tempCap) {
      const a = snap(tempCap.start), b = snap(tempCap.end);
      setTempCap(null);
      if (b - a >= 0.05) {
        const nova = captionFromText("nova legenda", a, b, `cap-man-${Date.now()}`);
        if (nova) { onCaptionsChange!([...baseCaptions(), nova].sort((p, q) => p.start - q.start)); setCapSel(nova.id); }
      }
      return;
    }
    if (d.kind === "capEdge" || d.kind === "capMove") return;
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

  // Setas ◀ ▶ navegam a agulha (frame a frame; Shift = 1s) e mantêm à vista. Só quando a
  // timeline está focada (após clicar nela) — não sequestra as setas do resto do app.
  function onKeyNav(e: React.KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.shiftKey ? 1 : 1 / 30;
    const cur = clock ? clock.time : currentTime;
    const nt = Math.max(0, Math.min(duration, +(cur + (e.key === "ArrowRight" ? step : -step)).toFixed(3)));
    onSeek(nt);
    const sc = scrollRef.current; if (sc) { const px = tToX(nt); if (px < sc.scrollLeft + 30 || px > sc.scrollLeft + vw - 30) sc.scrollLeft = Math.max(0, px - vw * 0.3); }
  }

  const selCut = cuts.find((c) => c.id === sel) ?? null;
  const patch = (p: Partial<Cut>) => onCutsChange(cuts.map((c) => (c.id === sel ? { ...c, ...p } : c)));
  const nudge = (side: "start" | "end", d: number) => {
    if (!selCut) return;
    if (side === "start") patch({ start: +Math.max(0, Math.min(selCut.end - 0.02, selCut.start + d)).toFixed(3) });
    else patch({ end: +Math.min(duration, Math.max(selCut.start + 0.02, selCut.end + d)).toFixed(3) });
  };
  const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, "0")}`;

  // ── ações da legenda selecionada ──
  const selLine: CaptionLine | null = lines.find((l) => l.id === capSel) ?? null;
  const capNudge = (side: "start" | "end", d: number) => {
    if (!selLine) return;
    const s = side === "start" ? Math.max(0, Math.min(selLine.end - 0.05, selLine.start + d)) : selLine.start;
    const e = side === "end" ? Math.min(duration, Math.max(selLine.start + 0.05, selLine.end + d)) : selLine.end;
    editCap(selLine.id, (cap) => retimeLine(cap, s, e));
  };
  const capSplit = () => {
    if (!selLine) return;
    const t = clock ? clock.time : currentTime;
    if (t <= selLine.start + 0.02 || t >= selLine.end - 0.02) return;
    const base = baseCaptions();
    const alvo = base.find((c) => c.id === selLine.id); if (!alvo) return;
    const par = splitLineAt(alvo, t);
    if (!par) return; // divisão deixaria um lado sem palavra
    onCaptionsChange!(base.flatMap((c) => (c.id === alvo.id ? par : [c])).sort((a, b) => a.start - b.start));
    setCapSel(par[0].id);
  };
  const capMergeNext = () => {
    if (!selLine) return;
    const base = baseCaptions().sort((a, b) => a.start - b.start);
    const i = base.findIndex((c) => c.id === selLine.id);
    if (i < 0 || i + 1 >= base.length) return;
    const fundida = mergeLines(base[i], base[i + 1]);
    onCaptionsChange!([...base.slice(0, i), fundida, ...base.slice(i + 2)]);
    setCapSel(fundida.id);
  };
  const capDelete = () => {
    if (!selLine) return;
    onCaptionsChange!(baseCaptions().filter((c) => c.id !== selLine.id));
    setCapSel(null);
  };
  const capDistribute = () => {
    if (!selLine) return;
    editCap(selLine.id, (cap) => ({ ...distributeWords(cap), locked: true }));
  };
  const capRetext = (texto: string) => {
    if (!selLine) return;
    // Sem fala pra ancorar palavra a palavra: redistribui na mesma janela.
    editCap(selLine.id, (cap) => captionFromText(texto, cap.start, cap.end, cap.id) ?? cap);
  };
  return (
    <div style={{ marginTop: 12 }}>
      <div ref={scrollRef} onWheel={onWheel}
        title={capsOn
          ? "onda = cortes · faixa azul = legendas (arraste bordas p/ ajustar, meio p/ mover, vazio p/ criar) · shift+scroll rola"
          : "arraste no vazio p/ criar corte · shift+scroll rola"}
        style={{ width: "100%", overflowX: "auto", overflowY: "hidden", borderRadius: 12, border: "1px solid var(--border)" }}>
        <div ref={wrapRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
          tabIndex={0} onKeyDown={onKeyNav}
          style={{ position: "relative", width: cw, height: H, cursor: recorte ? "crosshair" : "ew-resize", userSelect: "none", touchAction: "none", outline: "none" }}>
          <canvas ref={canvasRef} style={{ width: cw, height: H, display: "block" }} />
          {/* Playhead: div leve movido por transform (não redesenha o canvas). Com clock,
              o movimento é por DOM direto (P1); sem clock, via prop currentTime (legado). */}
          <div ref={playheadRef} style={{ position: "absolute", top: 0, left: 0, height: H, pointerEvents: "none", willChange: "transform",
            transform: `translateX(${tToX(clock ? clock.time : currentTime).toFixed(1)}px)` }}>
            {/* atravessa a onda E a faixa de legendas: é a referência p/ dividir no ponto certo */}
            <div style={{ position: "absolute", top: RULER, left: -0.75, width: 1.5, height: WAVE + capH + motH, background: "#eceef6" }} />
            {/* badge flutuante com o tempo atual (estilo referência) */}
            <div ref={badgeRef} style={{ position: "absolute", top: 1, left: 0, transform: "translateX(-50%)",
              background: "#0a0a0e", border: "1px solid var(--border)", borderRadius: 8,
              padding: "1px 8px", fontSize: 11, color: "#fff", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
              {(clock ? clock.time : currentTime).toFixed(2)}
            </div>
          </div>

          {/* CLIPES de MOTION (DOM) — mesmo visual do editor do FLOW: preview + duração + ×velocidade */}
          {motOn && motionGroups!.flatMap((grp) => {
            const total = groupEnd(grp) - grp.at;
            return groupSegs(grp).map((seg) => {
              const left = tToX(seg.start), w = Math.max(18, tToX(seg.end) - tToX(seg.start));
              const raw = seg.raw ?? seg.dur, speed = raw / Math.max(0.1, seg.dur), fast = speed > 1.5 || speed < 0.7;
              return (
                <div key={seg.phraseId} onPointerDown={(e) => startMotionMove(e, grp.id, grp.at, total)}
                  title={`${seg.label ?? "clipe"} · ${seg.dur.toFixed(1)}s ×${speed.toFixed(2)} — corpo move o motion, borda muda a velocidade`}
                  style={{ position: "absolute", top: MOT_TOP + 6, height: MOT - 12, left, width: w,
                    background: "var(--active-grad)", border: "1px solid var(--border-active)", borderRadius: 7,
                    boxShadow: "var(--shadow-active)", overflow: "hidden", cursor: "grab", zIndex: 4 }}>
                  {seg.video && <video src={comBase(seg.video)} muted preload="metadata"
                    style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.4, pointerEvents: "none" }} />}
                  <span style={{ position: "absolute", left: 6, top: 4, fontSize: 10, color: "var(--text)", fontWeight: 600, whiteSpace: "nowrap", textShadow: "0 1px 3px rgba(0,0,0,0.6)" }}>{seg.dur.toFixed(1)}s</span>
                  <span style={{ position: "absolute", left: 6, bottom: 3, fontSize: 9, color: fast ? "#ffb0b0" : "var(--faint)", textShadow: "0 1px 3px rgba(0,0,0,0.6)" }}>×{speed.toFixed(2)}</span>
                  {onClipResize && (
                    <div onPointerDown={(e) => startMotionResize(e, seg.phraseId, seg.dur)}
                      style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: 12, cursor: "ew-resize", display: "grid", placeItems: "center" }}>
                      <span style={{ width: 3, height: "55%", borderRadius: 2, background: "var(--accent)" }} />
                    </div>
                  )}
                </div>
              );
            });
          })}
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
        <button onClick={() => setRecorte((v) => !v)}
          title="Recorte LIGADO: arraste no vazio p/ criar cortes e edite os blocos. DESLIGADO: arraste p/ mover a agulha (navegar); as setas ◀▶ também navegam (Shift = 1s)."
          style={{ height: 30, padding: "0 12px", borderRadius: 8, fontSize: 13, cursor: "pointer", border: "1px solid var(--border)",
            background: recorte ? "var(--accent)" : "var(--panel3)", color: recorte ? "#141414" : "var(--text)", fontWeight: recorte ? 600 : 400 }}>
          ✂ Recorte
        </button>
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

      {/* As ferramentas GLOBAIS das legendas (alinhar, ±50ms, avisos, re-sincronizar)
          moram no painel "Roteiro & Correção" (CaptionToolbar) — aqui fica só o que
          precisa da timeline: a faixa e o editor da linha selecionada. */}

      {/* linha selecionada: mesmo idioma visual, borda acesa */}
      {selLine ? (
        <div style={{ ...capBar, borderColor: "var(--border-active)" }}>
          <span style={capChip}>
            ✎ {fmt(selLine.start)}–{fmt(selLine.end)}
            <span style={{ color: "var(--muted)", fontWeight: 400 }}>· {(selLine.end - selLine.start).toFixed(2)}s</span>
          </span>
          <input value={lineText(selLine)} onChange={(e) => capRetext(e.target.value)}
            title="editar o texto redistribui as palavras por igual na janela (perde o timing palavra-a-palavra do whisper)"
            style={{ flex: "1 1 200px", minWidth: 140, background: "var(--panel)", color: "var(--text)",
              border: "1px solid var(--border)", borderRadius: 8, padding: "4px 10px", fontSize: 12.5 }} />
          <span style={capGroup} title="empurra o INÍCIO da legenda (±100ms)">
            <span style={capGroupLabel}>início</span>
            <button style={capGroupBtn} onClick={() => capNudge("start", -0.1)}>◀</button>
            <span style={capGroupSep} />
            <button style={capGroupBtn} onClick={() => capNudge("start", +0.1)}>▶</button>
          </span>
          <span style={capGroup} title="empurra o FIM da legenda (±100ms)">
            <span style={capGroupLabel}>fim</span>
            <button style={capGroupBtn} onClick={() => capNudge("end", -0.1)}>◀</button>
            <span style={capGroupSep} />
            <button style={capGroupBtn} onClick={() => capNudge("end", +0.1)}>▶</button>
          </span>
          <span style={capGroup}>
            {/* Sem `disabled` no dividir: este componente não re-renderiza quando o tempo
                anda (playhead por DOM direto) — um estado calculado no render congelaria
                e travaria uma divisão legítima. capSplit lê o clock na hora do clique. */}
            <button style={capGroupBtn} onClick={capSplit} title="divide no playhead (posicione-o dentro da legenda)">✂ dividir</button>
            <span style={capGroupSep} />
            <button style={capGroupBtn} onClick={capMergeNext} title="funde com a próxima legenda">⇥ juntar</button>
            <span style={capGroupSep} />
            <button style={{ ...capGroupBtn, color: needsTimingRepair(selLine) ? "var(--red)" : undefined }}
              onClick={capDistribute}
              title="espalha as palavras por igual na janela — conserta linha travada (palavra de ~0s ou buraco morto)">⇄ distribuir</button>
          </span>
          <button style={{ ...capBtnMuted, color: "var(--red)" }} onClick={capDelete}>apagar</button>
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
