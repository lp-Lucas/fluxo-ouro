import { levenshtein, normalizeWord } from "../../../../shared/text.js";
import type { Word } from "../../../../shared/timeline.js";

/**
 * VERIFICAÇÃO LEXICAL DE RETAKE (não é heurística — é a definição virando teste).
 *
 * Um retake é um trecho onde o texto se REPETE PERIODICAMENTE. Não importa quantas
 * tomadas há nem como a IA agrupou o span:
 *  - se o span tem 1 tomada, a repetição está FORA dele (as N palavras seguintes);
 *  - se tem k tomadas, a repetição está DENTRO (o span dividido em k partes iguais bate).
 * É o MESMO fenômeno — periodicidade —, então uma verificação só:
 *
 *   N = |span|
 *   simExterna = simNorm(span, N palavras após o span)
 *   simInterna = max sobre k∈{2,3,4} com N%k==0 de MIN(simNorm entre TODOS os pares de partes)
 *   sim = max(simExterna, simInterna)
 *
 * MIN entre pares (não média): três tomadas com uma divergindo no meio NÃO é retake limpo
 * → cai para marcado. k até 4 cobre ×3 com folga; N%k≠0 pula (o critério externo pega o
 * span unitário). Determinístico, microssegundos. Normaliza antes (lowercase, sem acento/
 * pontuação). Span no fim da transcrição (sem janela após) → simExterna 0, sem crash.
 */

export const RETAKE_SIM_THRESHOLD = 0.6;

export interface RetakeCheck {
  sim: number;
  verified: boolean;
  via: string; // "externa" | "interna:k=N" | "nenhuma" — qual evidência venceu
}

function normText(words: Word[], a: number, b: number): string {
  const out: string[] = [];
  for (let i = a; i <= b && i < words.length; i++) {
    const n = normalizeWord(words[i].text);
    if (n) out.push(n);
  }
  return out.join(" ");
}

/** Similaridade normalizada 0..1 entre dois textos (1 = iguais). Vazio → 0. */
export function simNorm(a: string, b: string): number {
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/** Texto normalizado (lowercase/sem acento/pontuação) das palavras [a,b]. */
export function normTextRange(words: Word[], a: number, b: number): string {
  const out: string[] = [];
  for (let i = a; i <= b && i < words.length; i++) {
    const n = normalizeWord(words[i].text);
    if (n) out.push(n);
  }
  return out.join(" ");
}

export function verificaRetake(words: Word[], from: number, to: number): RetakeCheck {
  const n = to - from + 1;

  // (externa) o span se repete no que vem depois
  const spanText = normText(words, from, to);
  const winFrom = to + 1;
  const simExterna = winFrom >= words.length ? 0
    : simNorm(spanText, normText(words, winFrom, Math.min(to + n, words.length - 1)));

  // (interna) o span é periódico em si — divide em k partes iguais, MIN entre todos os pares
  let simInterna = 0, kWin = 0;
  for (let k = 2; k <= 4; k++) {
    if (n % k !== 0) continue;
    const size = n / k;
    const parts: string[] = [];
    for (let p = 0; p < k; p++) parts.push(normText(words, from + p * size, from + (p + 1) * size - 1));
    let minPair = 1;
    for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) minPair = Math.min(minPair, simNorm(parts[i], parts[j]));
    if (minPair > simInterna) { simInterna = minPair; kWin = k; }
  }

  const sim = +Math.max(simExterna, simInterna).toFixed(4);
  const verified = sim >= RETAKE_SIM_THRESHOLD;
  const via = !verified ? "nenhuma" : (simInterna >= simExterna ? `interna:k=${kWin}` : "externa");
  return { sim, verified, via };
}
