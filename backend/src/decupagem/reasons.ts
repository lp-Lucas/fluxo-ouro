import type { CutInterval } from "./semantic/types.js";

/**
 * FASE 5 — razões LEGÍVEIS em PT-BR. O usuário vê UM botão e, por corte, um motivo em
 * português — nunca o código interno. Cada corte carrega um `reason[]` de códigos; aqui
 * eles viram texto. Códigos desconhecidos caem num rótulo genérico (nunca quebra a UI).
 */

const LABELS: Record<string, string> = {
  fora_do_roteiro: "Fora do roteiro",
  whisper_hallucination: "Alucinação da transcrição",
  ai_retake_detection: "Tomada repetida",
  ai_retake_nao_verificado: "Possível retake (não confirmado)",
  falso_comeco: "Falso começo",
  disfluencia_provavel: "Possível repetição — ouça",
  needs_caption_repair: "reparo de legenda",
  dead_air: "Silêncio",
  vad_silence: "Silêncio",
  vad_breath: "Respiração",
  fronteira_vad_incerta: "Fronteira de fala incerta",
  filler: "Muleta",
  fala_periferica: "Fala periférica",
  mishear_provavel: "Provável erro de transcrição",
};

/** Rótulo PT-BR de um código de razão (fallback genérico para códigos novos). */
export function reasonLabel(code: string): string {
  return LABELS[code] ?? "Corte automático";
}

/**
 * Frase única PT-BR para o corte. A razão PRINCIPAL vem primeiro (a que justifica o
 * corte); "fala periférica" é modificador e entra entre parênteses. Ex.:
 *   ["fora_do_roteiro", "fala_periferica"] → "Fora do roteiro (fala periférica)"
 */
const MODIFIERS = new Set(["fala_periferica", "needs_caption_repair"]);
export function reasonSummary(cut: Pick<CutInterval, "reason">): string {
  const mods = cut.reason.filter((r) => MODIFIERS.has(r));
  const main = cut.reason.filter((r) => !MODIFIERS.has(r));
  const head = main.length ? main.map(reasonLabel).join(" + ") : "Corte automático";
  return mods.length ? `${head} (${mods.map(reasonLabel).map((s) => s.toLowerCase()).join(", ")})` : head;
}
