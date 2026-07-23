import type { TranscriptSegment, Word, Cut, Zoom, Popup, Caption } from "../../../../shared/timeline";
import type { FlowState } from "../../../../shared/flow";
import { remapTimeBetween, type TimelineSpan } from "../../../../shared/assembly";

/**
 * REALOCAÇÃO DO PROJETO após o Montador refazer o vídeo de origem.
 *
 * Nada é resetado: cada dado cronometrado (palavra, corte, zoom, popup, legenda) é
 * levado do tempo ANTIGO pro tempo NOVO pelo mapa de material (ver shared/assembly.ts).
 * O que caía num trecho REMOVIDO não tem destino e é o único descartado.
 *
 * O FLOW é o caso especial: ele aponta pra palavras por ÍNDICE (wordStart/wordEnd), não
 * por tempo. Então remapeamos os índices pelo mapa antigo→novo da lista de palavras.
 */

const uid = () => Math.random().toString(36).slice(2, 9);
/** Junta palavras numa segmentação nova quando o silêncio passa deste limite (s). */
const SEG_GAP = 0.7;

export interface RemapInput {
  transcript: TranscriptSegment[];
  cuts: Cut[];
  zooms: Zoom[];
  popups: Popup[];
  captions: Caption[];
  flow?: FlowState;
}
export interface RemapOutput extends RemapInput {
  /** quantos itens não tinham destino (caíram em trecho removido) — pro aviso na UI. */
  dropped: { words: number; cuts: number; zooms: number; popups: number; captions: number; phrases: number };
}

export function remapDoc(
  doc: RemapInput,
  oldSpans: TimelineSpan[],
  newSpans: TimelineSpan[],
  /** segmentos transcritos do MATERIAL NOVO — já em tempo da timeline nova. */
  newSegments: TranscriptSegment[] = [],
): RemapOutput {
  const R = (t: number) => remapTimeBetween(oldSpans, newSpans, t);
  const dropped = { words: 0, cuts: 0, zooms: 0, popups: 0, captions: 0, phrases: 0 };

  // ---------- PALAVRAS: remapeia, descarta as que sumiram, funde o material novo ----------
  // `oldIdx` acompanha a palavra pra reconstruir os índices que o FLOW usa.
  type Carried = { w: Word; oldIdx: number | null };
  const carried: Carried[] = [];
  let idx = 0;
  for (const seg of doc.transcript) {
    for (const w of seg.words) {
      const myIdx = idx++;
      const s = R(w.start), e = R(w.end);
      if (s == null || e == null || e <= s) { dropped.words++; continue; }
      carried.push({ w: { ...w, start: s, end: e }, oldIdx: myIdx });
    }
  }
  // material novo entra como palavras sem índice antigo (o FLOW não aponta pra elas)
  for (const seg of newSegments) for (const w of seg.words) carried.push({ w: { ...w }, oldIdx: null });

  // a ordem pode ter mudado (reordenar clipes) → ordena pelo tempo NOVO
  carried.sort((a, b) => a.w.start - b.w.start || a.w.end - b.w.end);

  // mapa índice ANTIGO → índice NOVO (posição na lista final de palavras)
  const idxMap = new Map<number, number>();
  carried.forEach((c, i) => { if (c.oldIdx != null) idxMap.set(c.oldIdx, i); });

  // reagrupa em segmentos por silêncio
  const transcript: TranscriptSegment[] = [];
  for (const { w } of carried) {
    const last = transcript[transcript.length - 1];
    if (last && w.start - last.end <= SEG_GAP) {
      last.words.push(w); last.end = Math.max(last.end, w.end);
      last.text = `${last.text} ${w.text}`.trim();
    } else {
      transcript.push({ id: uid(), start: w.start, end: w.end, text: w.text, words: [w], source: "corrected" });
    }
  }

  // ---------- CORTES ----------
  const cuts: Cut[] = [];
  for (const c of doc.cuts) {
    const s = R(c.start), e = R(c.end);
    if (s == null || e == null || e <= s) { dropped.cuts++; continue; }
    cuts.push({ ...c, start: s, end: e });
  }

  // ---------- ZOOMS e POPUPS (at + duration) ----------
  /** Remapeia um par (at, duration); mantém a duração se o fim caiu em trecho removido. */
  const remapAtDur = (at: number, duration: number): { at: number; duration: number } | null => {
    const s = R(at);
    if (s == null) return null;
    const e = R(at + duration);
    return { at: s, duration: e != null && e > s ? e - s : duration };
  };
  const zooms: Zoom[] = [];
  for (const z of doc.zooms) {
    const r = remapAtDur(z.at, z.duration);
    if (!r) { dropped.zooms++; continue; }
    zooms.push({ ...z, ...r });
  }
  const popups: Popup[] = [];
  for (const p of doc.popups) {
    const r = remapAtDur(p.at, p.duration);
    if (!r) { dropped.popups++; continue; }
    popups.push({ ...p, ...r } as Popup);
  }

  // ---------- LEGENDAS MATERIALIZADAS ----------
  const captions: Caption[] = [];
  for (const cap of doc.captions) {
    const s = R(cap.start), e = R(cap.end);
    const words = cap.words
      .map((w) => { const ws = R(w.start), we = R(w.end); return ws != null && we != null && we > ws ? { ...w, start: ws, end: we } : null; })
      .filter((w): w is Word => !!w);
    if (s == null || e == null || e <= s || words.length === 0) { dropped.captions++; continue; }
    captions.push({ ...cap, start: s, end: e, words });
  }

  // ---------- FLOW (aponta por ÍNDICE de palavra) ----------
  let flow: FlowState | undefined = doc.flow;
  if (doc.flow) {
    /** Índice novo mais próximo do antigo (a palavra exata pode ter sumido). */
    const maxOld = idx; // total de palavras da transcrição antiga
    const nearest = (old: number, dir: 1 | -1): number | null => {
      for (let k = old; k >= 0 && k <= maxOld; k += dir) { const n = idxMap.get(k); if (n != null) return n; }
      return null;
    };
    const moments = doc.flow.moments.map((m) => {
      const phrases = m.phrases.map((ph) => {
        const a = idxMap.get(ph.wordStart) ?? nearest(ph.wordStart, 1);
        const b = idxMap.get(ph.wordEnd) ?? nearest(ph.wordEnd, -1);
        if (a == null || b == null || b < a) { dropped.phrases++; return null; }
        return { ...ph, wordStart: a, wordEnd: b };
      }).filter((p): p is NonNullable<typeof p> => !!p);
      if (!phrases.length) return null;
      return { ...m, phrases, wordStart: phrases[0].wordStart, wordEnd: phrases[phrases.length - 1].wordEnd };
    }).filter((m): m is NonNullable<typeof m> => !!m);
    // popups do FLOW que sobraram na timeline (já remapeados acima) continuam válidos
    const keptIds = new Set(popups.map((p) => p.id));
    flow = { ...doc.flow, moments, placedPopupIds: doc.flow.placedPopupIds.filter((id) => keptIds.has(id)) };
  }

  return { transcript, cuts, zooms, popups, captions, flow, dropped };
}
