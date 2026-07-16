import type { Word } from "../../../../shared/timeline.js";
import { simNorm, normTextRange } from "./verificaRetake.js";
import { normalizeWord } from "../../../../shared/text.js";

/**
 * ZONAS DE RETAKE — roda ANTES do alinhamento Gotoh, sobre a fala crua (independe da copy).
 *
 * Um retake é ESTRUTURA (um span repetido), não palavra solta. O Gotoh fragmenta o span
 * antes da IA vê-lo, e um filtro por índice (restrictTo) não pode restringir uma decisão
 * sobre estrutura — foi o erro da Fase 3. A zona resolve isso: marca o intervalo onde o
 * texto se repete periodicamente e, dentro dela, o copyLayer se cala (sem del, sem
 * candidato, sem restrictTo) — a zona inteira vai para a IA sem restrição, como no caminho
 * sem copy. Fora das zonas, nada muda: a copy mantém precedência sobre conteúdo.
 *
 * Detecção: para cada início i, acha o período L≥5 cujas repetições consecutivas batem
 * (simNorm ≥ 0.8 — a MESMA função e o MESMO limiar de família do verificaRetake). Funde as
 * ocorrências numa família; a zona vai do início da 1ª ao fim da última. Escolhe o L que
 * cobre mais. `simNorm`/limiar reaproveitados de verificaRetake.ts.
 */

export const ZONE_MIN_LEN = 5;   // span candidato mínimo (palavras) — periodicidade
export const ZONE_SIM = 0.8;     // limiar de família — periodicidade
export const ZONE_HEAD_SIM = 0.7; // limiar de cabeça-de-bloco
export const ZONE_BLOCK_SIM = 0.5; // limiar de bloco-inteiro (mais frouxo: compara frases, reformulação diverge mais)
export const ZONE_MAX_MS = 20000; // circuit breaker: cadeia > 20s é patologia, não regra

export type ZoneVia = "periodicidade" | "cabeca" | "bloco" | "ambos";
export interface RetakeZone {
  from: number; to: number; via?: ZoneVia;
  /** Corte ACÚSTICO da zona-cabeça: remove tudo até o começo do ÚLTIMO bloco (o recomeço).
   *  Falso começo colapsado não tem palavras canônicas próprias → o corte é por bloco, não
   *  por índice de palavra. Só em zona `via='cabeca'` pura (retake textual quem corta é a IA). */
  cut?: { startMs: number; endMs: number };
}

/** MIN simNorm entre TODAS as ocorrências de uma família (início `start`, período L, `reps`). */
function familyMinSim(words: Word[], start: number, L: number, reps: number): number {
  const parts: string[] = [];
  for (let k = 0; k < reps; k++) parts.push(normTextRange(words, start + k * L, start + (k + 1) * L - 1));
  let m = 1;
  for (let a = 0; a < reps; a++) for (let b = a + 1; b < reps; b++) m = Math.min(m, simNorm(parts[a], parts[b]));
  return m;
}

/**
 * Refina a FASE da família: desloca o início em -1/0/+1 (a família inteira desloca; o fim
 * segue) e escolhe o que maximiza o MIN simNorm entre as ocorrências → fronteira EXATA.
 */
function refineBoundary(words: Word[], from: number, L: number, reps: number, n: number): RetakeZone {
  let bestStart = from, bestScore = familyMinSim(words, from, L, reps);
  for (const s of [from - 1, from + 1]) {
    if (s < 0 || s + reps * L > n) continue;
    const sc = familyMinSim(words, s, L, reps);
    if (sc > bestScore) { bestScore = sc; bestStart = s; }
  }
  return { from: bestStart, to: bestStart + reps * L - 1 };
}

export function detectaZonas(words: Word[], opts: { minLen?: number; sim?: number } = {}): RetakeZone[] {
  const minLen = opts.minLen ?? ZONE_MIN_LEN;
  const thresh = opts.sim ?? ZONE_SIM;
  const n = words.length;
  const zones: RetakeZone[] = [];

  let i = 0;
  while (i <= n - 2 * minLen) {
    let best: { from: number; L: number; reps: number } | null = null;
    for (let L = minLen; L <= Math.floor((n - i) / 2); L++) {
      const base = normTextRange(words, i, i + L - 1);
      if (!base) continue;
      // conta repetições consecutivas de período L que batem com a base
      let reps = 1;
      while (i + (reps + 1) * L <= n) {
        const nxt = normTextRange(words, i + reps * L, i + (reps + 1) * L - 1);
        if (simNorm(base, nxt) >= thresh) reps++;
        else break;
      }
      if (reps >= 2 && (!best || reps * L > best.reps * best.L)) best = { from: i, L, reps };
    }
    if (best) {
      const zone = refineBoundary(words, best.from, best.L, best.reps, n); // fronteira exata
      zones.push({ ...zone, via: "periodicidade" });
      i = zone.to + 1;
    } else i++;
  }
  return zones;
}

// ─────────────── CABEÇA-DE-BLOCO (método 2, complementar) ───────────────
// Um retake não precisa de repetição textual (o Whisper achata o falso começo). Precisa de
// dois COMEÇOS de bloco que se pareçam. Robusto a garble (o garble ataca o miolo, não a 1ª
// palavra) e a fragmentação (mais fragmentos = mais cabeças = cadeia mais longa). Roda sobre
// um VAD de ZONA próprio (minSilence fino, separado do VAD de tempo).

export const ZONE_MIN_BLOCK_MS = 400; // bloco menor que isto é garble/caco → funde no vizinho
export interface SpeechBlock { startMs: number; endMs: number }
const normHead = (t: string) => t.split(/\s+/).map(normalizeWord).filter(Boolean).join(" ");

/**
 * Funde blocos MICRO (< minMs) no vizinho de menor gap ANTES de transcrever a cabeça.
 * Sobre-fragmentar (minSilence fino) parte uma tentativa curta abandonada em cacos garblados
 * ("Agora muito" + "Fica!") — o caco vira intruso falso e quebra a cadeia. Fundir o desfaz,
 * sem tocar o minSilence. NÃO afeta frases repetidas (seus fragmentos são ≥ minMs).
 */
export function coalesceMicroBlocks(blocks: SpeechBlock[], minMs = ZONE_MIN_BLOCK_MS): SpeechBlock[] {
  const out = blocks.map((b) => ({ ...b }));
  let changed = true;
  while (changed && out.length > 1) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      if (out[i].endMs - out[i].startMs >= minMs) continue;
      const prev = i > 0 ? out[i - 1] : null;
      const next = i < out.length - 1 ? out[i + 1] : null;
      const gapPrev = prev ? out[i].startMs - prev.endMs : Infinity;
      const gapNext = next ? next.startMs - out[i].endMs : Infinity;
      if (prev && gapPrev <= gapNext) { prev.endMs = out[i].endMs; out.splice(i, 1); changed = true; break; }
      if (next) { next.startMs = out[i].startMs; out.splice(i, 1); changed = true; break; }
    }
  }
  return out;
}

/** Índices de palavra (canônico) cujo tempo cai no intervalo [startMs,endMs]. */
function wordsInMs(words: Word[], startMs: number, endMs: number): RetakeZone | null {
  let from = -1, to = -1;
  for (let k = 0; k < words.length; k++) {
    const ws = (words[k].start ?? 0) * 1000, we = (words[k].end ?? 0) * 1000;
    if (we > startMs && ws < endMs) { if (from < 0) from = k; to = k; }
  }
  return from >= 0 ? { from, to } : null;
}

/**
 * Zonas por CABEÇA-DE-BLOCO. Encadeia blocos CONSECUTIVOS cujas cabeças batem (simNorm ≥
 * 0.7). SEM teto de pausa — a similaridade já responde "é a mesma tentativa?"; silêncio puro
 * não quebra. GUARDA de intruso: cabeça dissimilar no meio quebra a cadeia ali (outra coisa
 * foi dita). CIRCUIT BREAKER: cadeia > 20s é patologia — aborta e loga.
 */
export function zonasCabeca(blocks: SpeechBlock[], heads: string[], words: Word[], opts: { sim?: number } = {}): RetakeZone[] {
  const sim = opts.sim ?? ZONE_HEAD_SIM;
  const H = heads.map(normHead);
  const zones: RetakeZone[] = [];
  let i = 0;
  while (i < blocks.length - 1) {
    let j = i;
    while (j < blocks.length - 1 && simNorm(H[j], H[j + 1]) >= sim) j++; // estende; quebra no dissimilar
    if (j > i) {
      const startMs = blocks[i].startMs, endMs = blocks[j].endMs;
      if (endMs - startMs > ZONE_MAX_MS) {
        console.warn(`[zonasCabeca] cadeia > 20s (${((endMs - startMs) / 1000).toFixed(1)}s) em ${(startMs / 1000).toFixed(1)}s — patologia, abortada`);
      } else {
        const z = wordsInMs(words, startMs, endMs);
        // corte acústico: do início da cadeia até o começo do ÚLTIMO bloco (mantém o recomeço)
        if (z) zones.push({ ...z, via: "cabeca", cut: { startMs, endMs: blocks[j].startMs } });
      }
      i = j + 1;
    } else i++;
  }
  return zones;
}

/** Texto canônico normalizado das palavras cujo INÍCIO cai no bloco (sem garble — usa a canônica). */
function blockText(words: Word[], b: SpeechBlock): string {
  const out: string[] = [];
  for (const w of words) { const ws = (w.start ?? 0) * 1000; if (ws >= b.startMs - 20 && ws < b.endMs + 20) { const n = normalizeWord(w.text); if (n) out.push(n); } }
  return out.join(" ");
}

/**
 * Zonas por BLOCO INTEIRO (método 3, para REFORMULAÇÃO). Encadeia blocos consecutivos cujos
 * TEXTOS CANÔNICOS (não cabeça, não per-bloco — sem garble) batem com simNorm ≥ 0.5 (frouxo:
 * frases inteiras, reformulação diverge mais que retake). Pega "Não há crux você sabe" vs
 * "Com a crux vocês sabem" (compartilham crux/você). A zona só decide QUEM julga; verificaRetake
 * é o guarda final do span que a IA devolver.
 */
export function zonasBloco(blocks: SpeechBlock[], words: Word[], opts: { sim?: number } = {}): RetakeZone[] {
  const sim = opts.sim ?? ZONE_BLOCK_SIM;
  const T = blocks.map((b) => blockText(words, b));
  const zones: RetakeZone[] = [];
  let i = 0;
  while (i < blocks.length - 1) {
    let j = i;
    while (j < blocks.length - 1 && T[j] && T[j + 1] && simNorm(T[j], T[j + 1]) >= sim) j++;
    if (j > i) {
      if (blocks[j].endMs - blocks[i].startMs <= ZONE_MAX_MS) {
        const z = wordsInMs(words, blocks[i].startMs, blocks[j].endMs);
        if (z) zones.push({ ...z, via: "bloco" });
      }
      i = j + 1;
    } else i++;
  }
  return zones;
}

/** União de zonas de vários métodos (índices de palavra). `via='ambos'` quando ≥2 métodos. */
export function unirZonas(...grupos: RetakeZone[][]): RetakeZone[] {
  const all = grupos.flat().filter(Boolean).sort((a, b) => a.from - b.from || a.to - b.to);
  const acc: { from: number; to: number; vias: Set<ZoneVia>; cut?: RetakeZone["cut"] }[] = [];
  for (const z of all) {
    const last = acc[acc.length - 1];
    if (last && z.from <= last.to + 1) { last.to = Math.max(last.to, z.to); last.vias.add(z.via ?? "periodicidade"); last.cut = last.cut ?? z.cut; }
    else acc.push({ from: z.from, to: z.to, vias: new Set([z.via ?? "periodicidade"]), cut: z.cut });
  }
  return acc.map((z) => {
    const via = (z.vias.size > 1 ? "ambos" : [...z.vias][0]) as ZoneVia;
    // corte acústico só sobrevive em zona-cabeça PURA (retake textual/ambos → a IA corta)
    return { from: z.from, to: z.to, via, cut: via === "cabeca" ? z.cut : undefined };
  });
}

/** Conjunto de índices cobertos por alguma zona. */
export function zoneIndexSet(zones: RetakeZone[]): Set<number> {
  const s = new Set<number>();
  for (const z of zones) for (let i = z.from; i <= z.to; i++) s.add(i);
  return s;
}
