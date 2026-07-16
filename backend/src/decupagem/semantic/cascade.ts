import type { Word } from "../../../../shared/timeline.js";
import { runCopyLayer } from "./copyLayer.js";
import { aiRetakeCuts } from "./aiRetake.js";
import { buildRestrictTo } from "../index.js";
import type { CutInterval, SemanticResult } from "./types.js";

/**
 * CASCATA SEMÂNTICA UNIFICADA (substitui detectCutsFromCopy + aiCut como camada, não
 * como escolha do usuário). Precedência copy > IA, com ESPECULAÇÃO para o clique parecer
 * instantâneo:
 *
 *  1) DETERMINÍSTICO (retorna já, aplicado): `runCopyLayer` — alinhamento Gotoh (copy
 *     manda no conteúdo) + guarda de mishear (freio) + alucinação (vadSegmentIdx -1).
 *  2) IA em BACKGROUND (chega como patch): `runAiPatch` — só o que o determinístico não
 *     resolve (takes repetidos ambíguos, ou tudo se não há copy). Chunking paralelo 800/50.
 *
 * ESPECULAÇÃO — escolha: POLLING (não SSE). Motivo: o backend já tem um sistema de jobs
 * com progresso por polling (`/api/flow/progress/:id`, render, transcribe); reusar o mesmo
 * padrão evita infra de streaming (SSE/keep-alive) por um ganho marginal — a IA é 1 evento
 * (não um fluxo contínuo). A UI aplica os cortes determinísticos na hora e faz poll do job
 * da IA; quando pronto, aplica o patch { additionalCuts, reason: 'ai_retake_detection' }.
 */

export interface AiPatch {
  additionalCuts: CutInterval[];
  reason: "ai_retake_detection";
}

/** Camada 1 — determinística, imediata. */
export function runDeterministic(words: Word[], copy: string): SemanticResult {
  return runCopyLayer(words, copy);
}

/**
 * Camada 2 — IA em background. DENTRO de zona de retake a IA decide sem restrição (o
 * Gotoh não tem informação para decidir qual tomada fica); FORA, restrita aos candidatos
 * (a copy mantém precedência sobre conteúdo). Sem copy, a IA julga tudo.
 */
export async function runAiPatch(
  words: Word[], copy: string, det: SemanticResult, signal?: AbortSignal,
): Promise<AiPatch> {
  const restrictTo = buildRestrictTo(det.retakeCandidates, det.retakeZones, copy.trim().length > 0);
  const additionalCuts = await aiRetakeCuts(words, copy, { restrictTo, signal });
  return { additionalCuts, reason: "ai_retake_detection" };
}
