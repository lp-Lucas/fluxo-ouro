import type { Cut, Zoom, TranscriptSegment, Word, Seconds } from "../../../../shared/timeline";
import { computeAlignment, tokenizeCopy } from "../correcao/align";

/**
 * Etapa 5: AUTOCUT (decupagem automática) a partir da transcrição.
 * Detecta silêncios (gaps entre palavras) e vícios de linguagem, gerando
 * cortes editáveis. Nada é removido de fato aqui — só marca os cortes na
 * timeline; o usuário liga/desliga cada um e o render (Etapa 6) aplica.
 */

/** Vícios de linguagem comuns em PT-BR (candidatos a corte). */
const FILLERS = new Set([
  "né", "tipo", "então", "aham", "hum", "hmm", "ééé", "éé", "aaa", "aa",
  "ahn", "ah", "eh", "uh", "tá", "assim",
]);

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export interface AutocutOptions {
  minSilence: Seconds; // gap mínimo p/ considerar silêncio
  removeFillers: boolean;
}

export function detectCuts(
  transcript: TranscriptSegment[],
  opts: AutocutOptions,
): Cut[] {
  const words: Word[] = transcript.flatMap((s) => s.words);
  const cuts: Cut[] = [];
  let n = 0;

  // Silêncios: gaps entre palavras consecutivas.
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1].start - words[i].end;
    if (gap >= opts.minSilence) {
      cuts.push({
        id: `cut-sil-${n++}`,
        start: +words[i].end.toFixed(3),
        end: +words[i + 1].start.toFixed(3),
        reason: "silence",
        enabled: true,
      });
    }
  }

  // Vícios de linguagem.
  if (opts.removeFillers) {
    for (const w of words) {
      if (FILLERS.has(norm(w.text))) {
        cuts.push({
          id: `cut-fill-${n++}`,
          start: +w.start.toFixed(3),
          end: +w.end.toFixed(3),
          reason: "error",
          enabled: true,
        });
      }
    }
  }

  return cuts.sort((a, b) => a.start - b.start);
}

/**
 * Cortes derivados da COPY/roteiro: alinha a fala com o roteiro e marca para
 * corte tudo que foi falado mas NÃO está no roteiro (erros, repetições, takes
 * refeitos). Palavras consecutivas fora do roteiro viram um único corte.
 */
export interface CopyCutResult {
  cuts: Cut[];
  matchedWords: number; // palavras do whisper reconhecidas na copy
  totalWords: number;
  /** true = a copy praticamente não bate com a fala → NÃO cortamos (seria o vídeo todo). */
  refused: boolean;
}

/** Fração mínima da fala que precisa casar com a copy pra confiarmos no corte. */
const MIN_MATCH_RATE = 0.25;
/**
 * Corte mínimo (s): slivers menores que isto no MEIO de fala casada são quase
 * sempre mishear do whisper (a pessoa FALOU a frase da copy, o whisper ouviu
 * outra coisa) — cortar removeria fala real. Takes ruins de verdade duram mais.
 */
const MIN_COPY_CUT = 0.8;

export function detectCutsFromCopy(transcript: TranscriptSegment[], copy: string): CopyCutResult {
  const ref = tokenizeCopy(copy);
  const words: Word[] = transcript.flatMap((s) => s.words);
  if (ref.length === 0 || words.length === 0) return { cuts: [], matchedWords: 0, totalWords: words.length, refused: false };

  const steps = computeAlignment(words, ref);

  // "mantida" por índice de palavra do whisper: match/sub = fica; del = corta.
  const kept = new Array<boolean>(words.length).fill(false);
  for (const s of steps) if (s.aIndex >= 0 && s.op !== "del") {
    kept[s.aIndex] = true;
    if (s.aIndex2 != null) kept[s.aIndex2] = true; // pareamento 2→1: as duas ficam
  }

  // TRAVA DE SANIDADE: se quase nada da fala casa com a copy, o "corte" seria o
  // vídeo INTEIRO — copy errada/de outro vídeo. Recusa e explica, nunca corta tudo.
  const matchedWords = kept.filter(Boolean).length;
  if (matchedWords / words.length < MIN_MATCH_RATE) {
    console.warn(`[autocut-copy] só ${matchedWords}/${words.length} palavras casaram com a copy — corte recusado.`);
    return { cuts: [], matchedWords, totalWords: words.length, refused: true };
  }

  // Cortes = runs contíguos de palavras NÃO mantidas. As bordas são cronometradas:
  // do FIM da última palavra mantida até o INÍCIO da próxima mantida — assim não
  // sobra sliver do take ruim nem corta o começo do take bom.
  const cuts: Cut[] = [];
  let n = 0;
  let i = 0;
  while (i < words.length) {
    if (kept[i]) { i++; continue; }
    let j = i;
    while (j < words.length && !kept[j]) j++; // run [i, j)
    const prevKeptEnd = i > 0 ? words[i - 1].end : undefined;   // última mantida antes
    const nextKeptStart = j < words.length ? words[j].start : undefined; // próxima mantida
    const start = prevKeptEnd ?? words[i].start;
    const end = nextKeptStart ?? words[j - 1].end;
    // corte nas BORDAS (início/fim do vídeo) vale sempre; no MEIO exige duração mínima
    const noMeio = prevKeptEnd != null && nextKeptStart != null;
    if (end > start + 0.001 && (!noMeio || end - start >= MIN_COPY_CUT)) {
      cuts.push({ id: `cut-copy-${n++}`, start: +start.toFixed(3), end: +end.toFixed(3), reason: "error", enabled: true });
    }
    i = j;
  }
  return { cuts, matchedWords, totalWords: words.length, refused: false };
}

/** Soma da duração dos cortes ativos. */
export function removedDuration(cuts: Cut[]): Seconds {
  return cuts.filter((c) => c.enabled).reduce((acc, c) => acc + (c.end - c.start), 0);
}

/**
 * Zooms automáticos intercalados: blocos de `interval` segundos alternando
 * entre aproximar (scaleIn) e afastar (1.0) ao longo de todo o vídeo.
 */
export function generateAlternatingZooms(
  durationSec: Seconds,
  interval: Seconds,
  scaleIn: number,
): Zoom[] {
  const zooms: Zoom[] = [];
  let i = 0;
  for (let at = 0; at < durationSec; at += interval, i++) {
    const duration = Math.min(interval, durationSec - at);
    zooms.push({
      id: `zoom-auto-${i}`,
      at: +at.toFixed(3),
      duration: +duration.toFixed(3),
      scale: i % 2 === 0 ? scaleIn : 1.0, // par = zoom in, ímpar = zoom out
    });
  }
  return zooms;
}
