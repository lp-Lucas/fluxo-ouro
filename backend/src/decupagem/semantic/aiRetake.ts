import type { Word } from "../../../../shared/timeline.js";
import { runClaude, extractJson } from "../../autocut/aiCut.js";
import { verificaRetake } from "./verificaRetake.js";
import type { CutInterval } from "./types.js";

/**
 * IA da camada semântica — decide RETAKES / falsos começos / erros que o alinhamento
 * não resolve. Reescrita da aiCut:
 *  - CHUNKING PARALELO: janelas de 800 palavras, overlap 50. Falso começo e retake têm
 *    raio ~30 palavras — contexto global não importa; paraleliza (meta < 30s vs 150s).
 *  - Na zona de overlap, índice marcado por QUALQUER chunk conta (UNIÃO).
 *  - MÉTODO FORÇADO mantido (análise em texto ANTES do JSON) + trava de 70%.
 *  - Formato por palavra: "[idx] texto" (SEM logprob). O logprob NÃO discrimina mishear
 *    (o histograma refutou: "axismo" -0.49 vs "tá" -3.9) — dar o número faria o modelo
 *    obedecê-lo no lugar de pensar. O discriminante é LEXICAL, dado em texto ao modelo.
 */

const CHUNK = 800;
const OVERLAP = 50;

interface Span { from: number; to: number; }

/** Monta o prompt do chunk (exportado para teste de paridade). */
export function buildAiPrompt(words: Word[], copy: string, base: number): string {
  const useCopy = copy.trim().length > 0;
  const lista = words.map((w, i) => `#${base + i} "${w.text}"`).join("\n");

  return [
    `Você é um EDITOR DE VÍDEO decupando uma gravação de take único. Recebe a transcrição numerada por palavra.`,
    useCopy
      ? `Há um ROTEIRO (copy). Já removi o que está claramente FORA do roteiro. Seu foco: TAKES REPETIDOS onde a MESMA ideia foi dita 2+ vezes e ambas batem com o roteiro — mantenha o ÚLTIMO take completo, corte os anteriores INTEIROS. E FALSOS COMEÇOS (frase abandonada no meio e recomeçada).`
      : `NÃO há roteiro. Use julgamento editorial: mantenha a versão mais fluente e completa de cada ideia; corte takes repetidos (mantém o último), falsos começos, muletas e erros admitidos.`,
    `\nDISTINÇÃO CRÍTICA (não-palavra vs muleta):`,
    `Você verá palavras que não existem em português ("axismo", "retornação"). São erros do TRANSCRITOR, não do apresentador — ele disse algo real que a máquina ouviu errado. NÃO as corte. Já palavras que existem mas são periféricas ("tá", "ai", "então", "né", "tipo") são muletas faladas de verdade e DEVEM ser cortadas.`,
    `\nMÉTODO (nesta ordem, a análise vem ANTES do JSON):`,
    `1. Leia o trecho e identifique cada ideia.`,
    `2. Para cada take repetido / falso começo, escreva UMA linha de análise: o problema, as palavras e a decisão.`,
    `3. Converta em índices EXATOS (confira o 1º e o último índice na lista).`,
    `\nResponda com a análise e, POR ÚLTIMO, o JSON: {"cuts":[{"from":<idx>,"to":<idx>}]} (índices GLOBAIS, inclusive, a REMOVER). Nada a cortar: {"cuts":[]}.`,
    useCopy ? `\nROTEIRO:\n"""\n${copy.trim()}\n"""` : "",
    `\nTRECHO NUMERADO (${words.length} palavras, índices globais):\n${lista}`,
  ].filter(Boolean).join("\n");
}

/** Roda UM chunk e devolve os spans (índices globais). */
async function runChunk(words: Word[], copy: string, base: number, signal?: AbortSignal): Promise<Span[]> {
  const text = await runClaude(buildAiPrompt(words, copy, base), signal);
  const parsed = extractJson(text) as { cuts?: Span[] };
  return Array.isArray(parsed.cuts) ? parsed.cuts : [];
}

/**
 * Decide os cortes de retake/falso-começo via IA em PARALELO. Devolve CutIntervals
 * (bordas em ms pela ancoragem VAD). `restrictTo` (opcional) limita a marcação aos
 * índices candidatos vindos da camada de copy (retakes ambíguos).
 */
export async function aiRetakeCuts(
  allWords: Word[], copy: string, opts: { restrictTo?: Set<number>; signal?: AbortSignal } = {},
): Promise<CutInterval[]> {
  const n = allWords.length;
  if (n === 0) return [];

  // janelas 800/50 (passo 750)
  const step = CHUNK - OVERLAP;
  const chunks: { start: number; end: number }[] = [];
  for (let s = 0; s < n; s += step) { chunks.push({ start: s, end: Math.min(n, s + CHUNK) }); if (s + CHUNK >= n) break; }

  // paraleliza; cada chunk usa índices GLOBAIS no prompt
  const results = await Promise.all(chunks.map((c) =>
    runChunk(allWords.slice(c.start, c.end), copy, c.start, opts.signal).catch(() => [] as Span[])));

  // UNIÃO: índice marcado por qualquer chunk conta
  const marked = new Array(n).fill(false);
  for (const spans of results) {
    for (const s of spans) {
      const from = Math.max(0, Math.min(n - 1, Math.round(s.from)));
      const to = Math.max(0, Math.min(n - 1, Math.round(s.to)));
      for (let i = from; i <= to; i++) if (!opts.restrictTo || opts.restrictTo.has(i)) marked[i] = true;
    }
  }

  // TRAVA DE 70%: IA marcou quase tudo → recusa (alucinação/copy errada)
  const count = marked.filter(Boolean).length;
  if (n >= 20 && count / n > 0.7) {
    throw new Error(`IA marcou ${count}/${n} palavras (>70%) — decisão recusada por segurança.`);
  }

  // funde índices contíguos (invariante a como a IA agrupou) e VERIFICA cada run:
  // só é retake se o texto se repete (periodicidade). Verificado → 0.95 aplica;
  // não verificado → 0.70 marca (ai_retake_nao_verificado), não corta.
  const cuts: CutInterval[] = [];
  let i = 0;
  while (i < n) {
    if (!marked[i]) { i++; continue; }
    let j = i;
    while (j < n && marked[j]) j++;
    const from = i, to = j - 1;
    const check = verificaRetake(allWords, from, to);
    const startMs = allWords[from].vadStartMs ?? Math.round(allWords[from].start * 1000);
    const endMs = allWords[to].vadEndMs ?? Math.round(allWords[to].end * 1000);
    const txt = allWords.slice(from, to + 1).map((w) => w.text.trim()).join(" ").slice(0, 48);
    console.log(`[aiRetake] span [${from}..${to}] sim=${check.sim} via=${check.via} → ${check.verified ? "APLICA" : "marca"} "${txt}"`);
    if (endMs > startMs) {
      cuts.push(check.verified
        ? { startMs, endMs, source: "ai_retake", reason: ["ai_retake_detection"], confidence: 0.95 }
        : { startMs, endMs, source: "ai_retake", reason: ["ai_retake_nao_verificado"], confidence: 0.70 });
    }
    i = j;
  }
  return cuts;
}
