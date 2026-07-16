import type { Word } from "../../../shared/timeline.js";
import type { VadSegment } from "./signal/vad.js";

/**
 * ANCORAGEM: amarra cada palavra do Whisper a um segmento de FALA do VAD, escrevendo
 * a borda REAL (vadStartMs/vadEndMs) e o índice do trecho (vadSegmentIdx). O tempo
 * deixa de ser o do Whisper e passa a ser o do VAD.
 *
 * Regras (definição de órfã do item 3 — "sem fala a MENOS de 100ms", não "sem overlap"):
 *  - Palavra DENTRO de um trecho de fala → clampa as bordas ao trecho.
 *  - Palavra CRUZANDO fronteira → estende para cobrir os trechos de fala tocados.
 *  - Palavra a ≤100ms de um trecho (encostada) → clampa/ABSORVE ao mais próximo
 *    (o conectivo de fronteira é absorvido, não vira alucinação — sem mexer no pad).
 *  - Palavra a >100ms de qualquer fala (isolada em silêncio longo) → vadSegmentIdx = -1
 *    e `vadHallGapMs` = duração do segmento NÃO-fala que a contém. O consumidor só corta
 *    de fato (whisper_hallucination) se esse gap for longo (≥400ms, item 3); gap curto =
 *    palavra órfã dentro de fala densa = 'fronteira_vad_incerta' (marca, não corta).
 *
 * vadSegmentIdx indexa a LISTA DE TRECHOS DE FALA (só isSpeech), não o array VAD cheio.
 */

export const ANCHOR_MAX_GAP_MS = 100;
export const HALLUCINATION = -1;

/** Distância (ms) do intervalo [a,b] a um trecho de fala; 0 se sobrepõe. */
function gapTo(a: number, b: number, s: VadSegment): number {
  if (b < s.startMs) return s.startMs - b;
  if (a > s.endMs) return a - s.endMs;
  return 0;
}

export function anchorWords(words: Word[], vad: VadSegment[]): Word[] {
  const speech = vad.filter((s) => s.isSpeech);

  return words.map((w) => {
    const a = Math.round(w.start * 1000), b = Math.round(w.end * 1000);

    // trechos de fala que a palavra SOBREPÕE (toca)
    const touched: number[] = [];
    for (let i = 0; i < speech.length; i++) {
      if (speech[i].endMs > a && speech[i].startMs < b) touched.push(i);
    }

    if (touched.length > 0) {
      // dentro (1 trecho) OU cruzando (vários): clampa/estende ao span dos trechos tocados
      const first = speech[touched[0]], last = speech[touched[touched.length - 1]];
      const lo = first.startMs, hi = last.endMs;
      return {
        ...w,
        vadStartMs: Math.min(Math.max(a, lo), hi),
        vadEndMs: Math.max(Math.min(b, hi), lo),
        vadSegmentIdx: touched[0],
      };
    }

    // sem overlap: acha o trecho de fala mais próximo
    let nearest = -1, nearestGap = Infinity;
    for (let i = 0; i < speech.length; i++) {
      const g = gapTo(a, b, speech[i]);
      if (g < nearestGap) { nearestGap = g; nearest = i; }
    }

    if (nearest >= 0 && nearestGap <= ANCHOR_MAX_GAP_MS) {
      // ≤100ms: ABSORVE — estende a borda da palavra até encostar no trecho (fecha o micro-gap)
      const s = speech[nearest];
      const before = b <= s.startMs;
      return {
        ...w,
        vadStartMs: before ? a : Math.min(a, s.endMs),
        vadEndMs: before ? Math.max(b, s.startMs) : b,
        vadSegmentIdx: nearest,
      };
    }

    // >100ms de qualquer fala (ou não há fala): órfã. Mede o segmento NÃO-fala que a
    // contém (pelo ponto médio) — o consumidor decide corte vs fronteira incerta (item 3).
    const mid = (a + b) / 2;
    const container = vad.find((s) => !s.isSpeech && s.startMs <= mid && mid < s.endMs);
    const vadHallGapMs = container ? container.endMs - container.startMs : (nearest >= 0 ? nearestGap : Infinity);
    return { ...w, vadStartMs: a, vadEndMs: b, vadSegmentIdx: HALLUCINATION, vadHallGapMs };
  });
}
