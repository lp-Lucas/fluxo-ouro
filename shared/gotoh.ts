import type { Word } from "./timeline.js";
import { levenshtein, normalizeWord } from "./text.js";

/**
 * Alinhamento global palavra↔roteiro com GAPS AFINS (Gotoh) + match fuzzy.
 * Extraído para shared/ para ser reaproveitado pela correção (frontend) e pela camada
 * semântica da decupagem (backend) — a mesma verdade de "o que bate com a copy".
 *
 * Gaps afins: abrir um corte é caro, ESTENDER é barato → um take repetido inteiro vira
 * UM corte contíguo. Match fuzzy: mishear de palavra do roteiro conta como correção (sub),
 * não como fora-do-roteiro (del).
 */

const norm = normalizeWord;

export function tokenizeCopy(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.trim().length > 0);
}

/** Similaridade 0..1 entre dois tokens normalizados (1 = igual). */
function tokenSim(a: string, b: string): number {
  if (a === b) return 1;
  const L = Math.max(a.length, b.length);
  if (L === 0) return 1;
  return 1 - levenshtein(a, b) / L;
}

// ── Parâmetros do alinhamento ──
const MATCH_SIM = 0.82; // ≥ isto = MESMA palavra (match, custo 0)
const SUB_COST = 0.6;   // trocar palavra parecida/mishear — mantém e corrige
const GAP_OPEN = 1.0;   // abrir um corte — caro (evita fatiar)
const GAP_EXT = 0.25;   // estender o corte — barato (take inteiro num corte só)
const INF = 1e9;

type Op = "match" | "sub" | "del" | "ins";

/** Um passo do alinhamento: liga (ou não) uma palavra do whisper a uma do roteiro. */
export interface AlignStep {
  op: Op;
  aIndex: number; // índice na transcrição (whisper); -1 se ins
  bIndex: number; // índice no roteiro; -1 se del
  /** Pareamento 2→1: DUAS palavras do whisper = UM token da copy ("Scale"+"4"="Scale4"). */
  aIndex2?: number;
}

function matchCost(sim: number): number {
  return sim >= MATCH_SIM ? 0 : SUB_COST;
}

/** Alinhamento global com gaps afins (Gotoh). M=casou, X=del (corte), Y=ins (falta na fala). */
export function computeAlignment(a: Word[], b: string[]): AlignStep[] {
  const n = a.length, m = b.length;
  if (n === 0 || m === 0) {
    const steps: AlignStep[] = [];
    for (let i = 0; i < n; i++) steps.push({ op: "del", aIndex: i, bIndex: -1 });
    for (let j = 0; j < m; j++) steps.push({ op: "ins", aIndex: -1, bIndex: j });
    return steps;
  }
  const an = a.map((w) => norm(w.text));
  const bn = b.map(norm);
  const W = m + 1;
  const idx = (i: number, j: number) => i * W + j;

  const M = new Float64Array((n + 1) * (m + 1)).fill(INF);
  const X = new Float64Array((n + 1) * (m + 1)).fill(INF);
  const Y = new Float64Array((n + 1) * (m + 1)).fill(INF);
  const bM = new Uint8Array((n + 1) * (m + 1));
  const bX = new Uint8Array((n + 1) * (m + 1));
  const bY = new Uint8Array((n + 1) * (m + 1));

  M[idx(0, 0)] = 0;
  for (let i = 1; i <= n; i++) { X[idx(i, 0)] = GAP_OPEN + (i - 1) * GAP_EXT; bX[idx(i, 0)] = i === 1 ? 0 : 1; }
  for (let j = 1; j <= m; j++) { Y[idx(0, j)] = GAP_OPEN + (j - 1) * GAP_EXT; bY[idx(0, j)] = j === 1 ? 0 : 2; }

  const min3 = (a0: number, a1: number, a2: number): [number, number] => {
    let best = a0, dir = 0;
    if (a1 < best) { best = a1; dir = 1; }
    if (a2 < best) { best = a2; dir = 2; }
    return [best, dir];
  };

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const c = matchCost(tokenSim(an[i - 1], bn[j - 1]));
      { const p = idx(i - 1, j - 1); const [best, dir] = min3(M[p], X[p], Y[p]); M[idx(i, j)] = best + c; bM[idx(i, j)] = dir; }
      // 2→1: duas palavras do whisper = um token da copy
      if (i >= 2 && tokenSim(an[i - 2] + an[i - 1], bn[j - 1]) >= MATCH_SIM) {
        const p2 = idx(i - 2, j - 1); const [best2, dir2] = min3(M[p2], X[p2], Y[p2]);
        if (best2 < M[idx(i, j)]) { M[idx(i, j)] = best2; bM[idx(i, j)] = dir2 + 3; }
      }
      { const p = idx(i - 1, j); const [best, dir] = min3(M[p] + GAP_OPEN, X[p] + GAP_EXT, Y[p] + GAP_OPEN); X[idx(i, j)] = best; bX[idx(i, j)] = dir; }
      // Y: ORDEM dos args = 0=M,1=X,2=Y (bug histórico: estava (M,Y,X) e cortava tudo).
      { const p = idx(i, j - 1); const [best, dir] = min3(M[p] + GAP_OPEN, X[p] + GAP_OPEN, Y[p] + GAP_EXT); Y[idx(i, j)] = best; bY[idx(i, j)] = dir; }
    }
  }

  let [, state] = min3(M[idx(n, m)], X[idx(n, m)], Y[idx(n, m)]);
  let i = n, j = m;
  const steps: AlignStep[] = [];
  while (i > 0 || j > 0) {
    const p = idx(i, j);
    if (state === 0) {
      if (bM[p] >= 3) { steps.push({ op: "match", aIndex: i - 2, aIndex2: i - 1, bIndex: j - 1 }); state = bM[p] - 3; i -= 2; j--; continue; }
      const sim = tokenSim(an[i - 1], bn[j - 1]);
      steps.push({ op: sim >= MATCH_SIM ? "match" : "sub", aIndex: i - 1, bIndex: j - 1 });
      state = bM[p]; i--; j--;
    } else if (state === 1) {
      steps.push({ op: "del", aIndex: i - 1, bIndex: -1 }); state = bX[p]; i--;
    } else {
      steps.push({ op: "ins", aIndex: -1, bIndex: j - 1 }); state = bY[p]; j--;
    }
  }
  steps.reverse();
  return steps;
}
