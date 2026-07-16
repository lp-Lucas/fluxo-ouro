import type { TranscriptSegment, Word } from "../../../../shared/timeline";
import { computeAlignment, tokenizeCopy, type AlignStep } from "../../../../shared/gotoh";
export { computeAlignment, tokenizeCopy, type AlignStep };

/**
 * Auto-correção da transcrição usando a copy/roteiro como fonte da verdade.
 *
 * Alinha as palavras do whisper (com timestamp) contra as palavras do roteiro
 * (texto correto) via alinhamento global com GAPS AFINS (Gotoh) e MATCH FUZZY.
 * Determinístico, sem IA.
 *
 * Por que gaps afins + fuzzy (e não NW simples):
 *  - Gaps afins: abrir um corte custa caro, ESTENDER é barato → um take repetido
 *    inteiro vira UM corte contíguo, em vez de o alinhador "fatiar" e deixar
 *    pedaços dos dois takes. Corrige as "falas repetidas que sobram".
 *  - Match fuzzy (similaridade de caracteres): quando o whisper ouve errado uma
 *    palavra DA copy, ela conta como correção (sub), não como "fora do roteiro"
 *    (del). Corrige as "falas da copy que eram cortadas".
 */

/** Monta a lista de palavras corrigida a partir do alinhamento. */
function alignWords(a: Word[], b: string[]): Word[] {
  const steps = computeAlignment(a, b);
  const out: Word[] = [];
  for (let k = 0; k < steps.length; k++) {
    const s = steps[k];
    if (s.op === "match" || s.op === "sub") {
      // usa timestamp do whisper, texto do roteiro (2→1 abrange as duas palavras)
      out.push({ text: b[s.bIndex], start: a[s.aIndex].start, end: a[s.aIndex2 ?? s.aIndex].end });
    } else if (s.op === "ins") {
      // roteiro tem palavra a mais -> cria com tempo do vizinho (0 de duração)
      const nextA = steps.slice(k + 1).find((x) => x.aIndex >= 0);
      const t = nextA ? a[nextA.aIndex].start : a[a.length - 1]?.end ?? 0;
      out.push({ text: b[s.bIndex], start: t, end: t });
    }
    // del: whisper falou algo fora do roteiro -> descartado da correção
  }
  return out;
}

/**
 * Aplica a correção por roteiro a toda a transcrição.
 * Faz alinhamento global e redistribui as palavras corrigidas de volta nos
 * segmentos originais (pelo timestamp), preservando a estrutura.
 */
export function correctWithCopy(
  transcript: TranscriptSegment[],
  copy: string,
): TranscriptSegment[] {
  const refTokens = tokenizeCopy(copy);
  if (refTokens.length === 0) return transcript;

  const allWords = transcript.flatMap((s) => s.words);
  if (allWords.length === 0) return transcript;

  // TRAVA DE SANIDADE: se quase nada casa, a "correção" empilharia toda a copy num
  // timestamp só (destruindo as legendas). Copy errada → devolve a transcrição intacta.
  const steps = computeAlignment(allWords, refTokens);
  const matched = steps.filter((s) => s.op === "match" || s.op === "sub").length;
  if (matched / allWords.length < 0.25) {
    console.warn(`[correção-copy] só ${matched}/${allWords.length} palavras casaram — correção recusada.`);
    return transcript;
  }

  const corrected = alignWords(allWords, refTokens);

  // Reatribui cada palavra corrigida ao segmento cujo intervalo a contém.
  return transcript.map((seg) => {
    const words = corrected.filter((w) => w.start >= seg.start - 0.001 && w.start <= seg.end + 0.001);
    if (words.length === 0) return seg;
    return {
      ...seg,
      words,
      text: words.map((w) => w.text).join(" ").replace(/\s+/g, " ").trim(),
      source: "corrected" as const,
    };
  });
}
