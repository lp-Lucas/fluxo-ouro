import type { CutInterval } from "../semantic/types.js";

/**
 * FASE 4 — SCORING. Decide `applied` a partir da confiança acumulada (merge+snap):
 *
 *  - applied = confidence ≥ 0.85 (o corte entra no plano); abaixo disso fica de fora
 *    (revisão manual / a IA pode ter errado / a borda pousou em fala).
 *  - EXCEÇÃO respiração: enquanto nonSpeech.ts classifica VOGAL como breath (teste todo
 *    aberto), um corte justificado SÓ por respiração NUNCA é aplicado — applied:false,
 *    mesmo com confiança 0.92. Se a respiração se sobrepõe a um corte com OUTRA razão
 *    (copy/alucinação/silêncio), essa outra razão aplica normalmente.
 */

export const APPLY_THRESHOLD = 0.85;
export const BREATH_REASON = "vad_breath";
export const PERIPHERAL_BONUS = 0.05;
/**
 * Razões que MARCAM mas NUNCA aplicam corte automático:
 *  - vad_breath: nonSpeech.ts confunde vogal com respiração (teste todo aberto).
 *  - fronteira_vad_incerta: órfã dentro de fala densa = falha de detecção de fronteira,
 *    não alucinação (item 3). Cortar lascaria fala boa.
 */
export const NEVER_APPLY = new Set([BREATH_REASON, "fronteira_vad_incerta"]);

export function scoreCuts(cuts: CutInterval[]): CutInterval[] {
  return cuts.map((c) => {
    // fala periférica (prob<0.15 fora da copy) → +0.05 (único uso do probability)
    const bonus = c.reason.includes("fala_periferica") ? PERIPHERAL_BONUS : 0;
    const confidence = +Math.min(1, (c.confidence ?? 0) + bonus).toFixed(4);
    // justificado SÓ por razões que nunca aplicam? (fala_periferica/needs_caption_repair são modificadores)
    const justifications = c.reason.filter((r) => r !== "fala_periferica" && r !== "needs_caption_repair");
    const blockedOnly = justifications.length > 0 && justifications.every((r) => NEVER_APPLY.has(r));
    // `blocked_by`: detecção confiável mas incapaz de agir (ex.: falso começo que parte palavra
    // → legenda quebraria). Marca, nunca aplica. confidence intacta (é a métrica de detectados).
    const applied = !blockedOnly && !c.blocked_by && confidence >= APPLY_THRESHOLD;
    return { ...c, confidence, applied };
  });
}
