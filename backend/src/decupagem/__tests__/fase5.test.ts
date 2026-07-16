import { test, before } from "node:test";
import assert from "node:assert/strict";
import { runDecupagem, planWithAi } from "../index.js";
import { reasonLabel, reasonSummary } from "../reasons.js";
import { scoreCuts } from "../plan/score.js";
import { runCopyLayer } from "../semantic/copyLayer.js";
import { loadDicionario } from "../semantic/misheardGuard.js";
import type { Word } from "../../../../shared/timeline.js";
import type { CutInterval } from "../semantic/types.js";

before(async () => { await loadDicionario(); });

function w(text: string, i: number, opts: { hall?: boolean; prob?: number } = {}): Word {
  const startMs = i * 1000, endMs = i * 1000 + 500;
  return {
    text, start: startMs / 1000, end: endMs / 1000,
    vadStartMs: startMs, vadEndMs: endMs, vadSegmentIdx: opts.hall ? -1 : 0,
    ...(opts.prob != null ? { probability: opts.prob } : {}),
  };
}

// ---------- reasons PT-BR ----------
test("reasonLabel: códigos conhecidos e fallback", () => {
  assert.equal(reasonLabel("fora_do_roteiro"), "Fora do roteiro");
  assert.equal(reasonLabel("vad_breath"), "Respiração");
  assert.equal(reasonLabel("codigo_novo_qualquer"), "Corte automático");
});

test("reasonSummary: razão principal + modificador entre parênteses", () => {
  assert.equal(reasonSummary({ reason: ["fora_do_roteiro"] }), "Fora do roteiro");
  assert.equal(reasonSummary({ reason: ["fora_do_roteiro", "fala_periferica"] }), "Fora do roteiro (fala periférica)");
  assert.equal(reasonSummary({ reason: [] }), "Corte automático");
});

// ---------- probability: fala periférica → +0.05 ----------
test("score: fala_periferica soma +0.05 (clamp ≤ 1)", () => {
  const c = (conf: number, reason: string[]): CutInterval => ({ startMs: 0, endMs: 100, source: "copy", reason, confidence: conf });
  const [plain, periph, high] = scoreCuts([
    c(0.9, ["fora_do_roteiro"]),
    c(0.9, ["fora_do_roteiro", "fala_periferica"]),
    c(0.99, ["fora_do_roteiro", "fala_periferica"]),
  ]);
  assert.equal(plain.confidence, 0.9);
  assert.equal(periph.confidence, 0.95, "0.9 + 0.05");
  assert.equal(high.confidence, 1, "clamp em 1.0");
});

test("copyLayer: palavra fora do roteiro com prob<0.15 recebe 'fala_periferica'", () => {
  // copy = "o gato preto"; falado inclui "aaammm" (fora do roteiro, longe dos tokens, prob 0.05)
  const words: Word[] = [w("o", 0), w("gato", 1), w("aaammm", 2, { prob: 0.05 }), w("preto", 3)];
  const r = runCopyLayer(words, "o gato preto");
  const periph = r.cuts.find((c) => c.reason.includes("fala_periferica"));
  assert.ok(periph, "o corte de 'éé' deveria ter fala_periferica");
});

// ---------- orquestrador: um botão, never-throw ----------
test("runDecupagem: aplica cortes com label PT-BR", () => {
  const words: Word[] = [w("o", 0), w("gato", 1), w("banana", 2), w("preto", 3)];
  const r = runDecupagem(words, "o gato preto");
  assert.equal(r.error, undefined);
  const banana = r.cuts.find((c) => c.startMs === 2000);
  assert.ok(banana, "banana (fora do roteiro) deveria ser aplicada");
  assert.equal(banana!.label, "Fora do roteiro");
  assert.ok(banana!.applied);
});

test("runDecupagem: sem palavras → vazio, sem erro (não falha em silêncio à toa)", () => {
  const r = runDecupagem([], "qualquer copy");
  assert.deepEqual(r.cuts, []);
  assert.deepEqual(r.all, []);
  assert.equal(r.needsAi, false);
  assert.equal(r.error, undefined);
});

// INTEGRAÇÃO #1: o patch de IA (retake) sobrevive ao merge e VIRA CORTE APLICADO.
// Se aiRetakeCuts não aparecer nos reasons de nenhum corte aplicado, falha (a IA estaria desconectada).
test("INTEGRAÇÃO: sem copy, o retake da IA vira corte aplicado (reason ai_retake_detection)", () => {
  const rawDet: CutInterval[] = []; // sem copy → determinístico não tem cortes de conteúdo
  const aiCuts: CutInterval[] = [
    { startMs: 41500, endMs: 48100, source: "ai_retake", reason: ["ai_retake_detection"] }, // sem confidence → base 0.9
  ];
  const full = planWithAi(rawDet, aiCuts);
  const retake = full.find((c) => c.reason.includes("ai_retake_detection"));
  assert.ok(retake, "o corte de retake da IA DEVE aparecer no conjunto final");
  assert.equal(retake!.applied, true, "ai_retake (0.9 ≥ 0.85) deve ser APLICADO");
  assert.equal(retake!.label, "Tomada repetida");
});

test("runDecupagem: NUNCA lança — erro vira campo `error`", () => {
  // Word malformada (sem campos) força um caminho de erro dentro do passo determinístico.
  const bad = [{ get text(): string { throw new Error("boom"); } }] as unknown as Word[];
  const r = runDecupagem(bad, "copy");
  assert.ok(r.error && r.error.includes("Falha ao decupar"), "erro deve subir rotulado");
  assert.deepEqual(r.cuts, []);
});
