import type { TranscriptSegment, Word } from "../../../shared/timeline.js";
import { computeAlignment } from "../../../shared/gotoh.js";

/**
 * CORREÇÃO DE TEMPO das legendas (caso real: vid/1.mp4 — legendas ~2s atrasadas de
 * ~46s a ~55.7s, ressincronizando depois; o whisper do projeto derrapou numa janela).
 *
 * Verdade do TEMPO = uma transcrição FRESCA do áudio. Alinhamos as palavras ATUAIS
 * (texto possivelmente já corrigido pelo usuário/copy — que fica intacto) contra as
 * frescas por TEXTO (Gotoh, fuzzy) e comparamos os timestamps par a par:
 *  - desvio pontual (< RUN_MIN palavras) é jitter normal do whisper → ignora;
 *  - um RUN de palavras consecutivas com desvio ≥ SHIFT_MIN é região FORA DE SINCRONIA
 *    → as palavras adotam os tempos frescos (o texto não muda);
 *  - palavras sem par (ex.: inseridas por gap-fill) são reancoradas por monotonicidade.
 * Se quase nada alinhar (vídeo trocado/transcrição de outro áudio), RECUSA — nunca
 * "conserta" destruindo.
 */

export interface TimingRegion { from: number; to: number; shift: number; words: number }
export interface TimingFixResult {
  transcript: TranscriptSegment[];
  fixedWords: number;
  regions: TimingRegion[];
  matchedRatio: number;
  refused?: string;
}

export const SHIFT_MIN = 0.45;      // s — desvio mínimo p/ contar como fora de sincronia
export const RUN_MIN = 3;           // palavras consecutivas desviadas (jitter não forma run)
const MIN_MATCH_RATIO = 0.5;        // abaixo disso o áudio não é desta transcrição → recusa

export function fixCaptionTiming(current: TranscriptSegment[], freshWords: Word[]): TimingFixResult {
  const flat: { seg: number; idx: number }[] = [];
  current.forEach((s, si) => (s.words ?? []).forEach((_, wi) => flat.push({ seg: si, idx: wi })));
  const curWord = (k: number) => current[flat[k].seg].words[flat[k].idx];
  if (flat.length === 0 || freshWords.length === 0) {
    return { transcript: current, fixedWords: 0, regions: [], matchedRatio: 0, refused: "transcrição vazia" };
  }

  // 1) alinhamento por TEXTO: palavra atual ↔ palavra fresca (2→1 vira o mesmo par)
  const steps = computeAlignment(flat.map((_, k) => curWord(k)), freshWords.map((w) => w.text));
  const pair = new Array<number>(flat.length).fill(-1);
  const pairHalf = new Array<0 | 1 | 2>(flat.length).fill(0); // 1/2 = metade de um par 2→1
  for (const s of steps) {
    if ((s.op === "match" || s.op === "sub") && s.aIndex >= 0 && s.bIndex >= 0) {
      pair[s.aIndex] = s.bIndex;
      if (s.aIndex2 != null) { pairHalf[s.aIndex] = 1; pair[s.aIndex2] = s.bIndex; pairHalf[s.aIndex2] = 2; }
    }
  }
  const matched = pair.filter((p) => p >= 0).length;
  const matchedRatio = matched / flat.length;
  if (matchedRatio < MIN_MATCH_RATIO) {
    return {
      transcript: current, fixedWords: 0, regions: [], matchedRatio,
      refused: `só ${matched}/${flat.length} palavras alinharam com a transcrição de verificação`,
    };
  }

  // 2) runs de desvio: consecutivas pareadas com |delta| ≥ SHIFT_MIN (não pareada não quebra o run)
  const delta = (k: number) => freshWords[pair[k]].start - curWord(k).start;
  const marked = new Array<boolean>(flat.length).fill(false);
  let i = 0;
  while (i < flat.length) {
    if (pair[i] < 0 || Math.abs(delta(i)) < SHIFT_MIN) { i++; continue; }
    // estende o run: desviadas contam; não-pareadas no meio não quebram
    const runIdx: number[] = [];
    let j = i;
    while (j < flat.length && (pair[j] < 0 || Math.abs(delta(j)) >= SHIFT_MIN)) {
      if (pair[j] >= 0) runIdx.push(j);
      j++;
    }
    if (runIdx.length >= RUN_MIN) for (const k of runIdx) marked[k] = true;
    i = j;
  }
  const fixedWords = marked.filter(Boolean).length;
  if (fixedWords === 0) return { transcript: current, fixedWords: 0, regions: [], matchedRatio };

  // 3) relatório de regiões (na linha do tempo CORRETA), antes de mexer
  const regions: TimingRegion[] = [];
  for (let k = 0; k < flat.length; k++) {
    if (!marked[k]) continue;
    let e = k;
    while (e + 1 < flat.length && (marked[e + 1] || pair[e + 1] < 0)) e++;
    while (e > k && !marked[e]) e--;
    const ks = [] as number[];
    for (let m = k; m <= e; m++) if (marked[m]) ks.push(m);
    const shift = ks.reduce((n, m) => n + (curWord(m).start - freshWords[pair[m]].start), 0) / ks.length;
    regions.push({
      from: +freshWords[pair[ks[0]]].start.toFixed(2),
      to: +freshWords[pair[ks[ks.length - 1]]].end.toFixed(2),
      shift: +shift.toFixed(2),
      words: ks.length,
    });
    k = e;
  }

  // 4) aplica os tempos frescos nas marcadas (TEXTO fica); 2→1 divide o intervalo no meio
  const out = current.map((s) => ({ ...s, words: (s.words ?? []).map((w) => ({ ...w })) }));
  const outWord = (k: number) => out[flat[k].seg].words[flat[k].idx];
  for (let k = 0; k < flat.length; k++) {
    if (!marked[k]) continue;
    const f = freshWords[pair[k]];
    const w = outWord(k);
    if (pairHalf[k] === 0) { w.start = f.start; w.end = Math.max(f.end, f.start + 0.02); }
    else {
      const mid = +((f.start + f.end) / 2).toFixed(3);
      if (pairHalf[k] === 1) { w.start = f.start; w.end = mid; }
      else { w.start = mid; w.end = Math.max(f.end, mid + 0.02); }
    }
  }
  // 5) monotonicidade: não-pareadas presas na linha do tempo velha dentro de região
  //    corrigida são reancoradas logo após a vizinha (nunca ficam 2s à frente)
  for (let k = 1; k < flat.length; k++) {
    const prev = outWord(k - 1), w = outWord(k);
    if (!marked[k] && w.start < prev.end - 0.001 && (marked[k - 1] || (k + 1 < flat.length && marked[k + 1]))) {
      const dur = Math.max(0.05, w.end - w.start);
      w.start = prev.end;
      w.end = w.start + dur;
    } else if (w.start < prev.end - 0.001 && marked[k]) {
      // par corrigido colidindo por arredondamento — encosta sem sobrepor
      w.start = Math.max(w.start, prev.end);
      if (w.end < w.start + 0.02) w.end = w.start + 0.02;
    }
  }
  // 6) bordas dos segmentos acompanham as palavras; marca como corrigido
  for (let si = 0; si < out.length; si++) {
    const s = out[si];
    if (!s.words.length) continue;
    const touched = flat.some((f, k) => f.seg === si && marked[k]);
    s.start = s.words[0].start;
    s.end = s.words[s.words.length - 1].end;
    if (touched) s.source = "corrected";
  }

  return { transcript: out, fixedWords, regions, matchedRatio };
}
