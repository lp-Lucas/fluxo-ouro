import { test, before } from "node:test";
import assert from "node:assert/strict";
import { runCopyLayer } from "../copyLayer.js";
import { loadDicionario } from "../misheardGuard.js";
import type { Word } from "../../../../../shared/timeline.js";

// a guarda de mishear (usada por runCopyLayer) precisa do Hunspell carregado.
before(async () => { await loadDicionario(); });

// helper: palavra ancorada (fala) ou alucinação (vadSegmentIdx -1)
function w(text: string, i: number, opts: { hall?: boolean } = {}): Word {
  const startMs = i * 1000, endMs = i * 1000 + 500;
  return {
    text, start: startMs / 1000, end: endMs / 1000,
    vadStartMs: startMs, vadEndMs: endMs, vadSegmentIdx: opts.hall ? -1 : 0,
  };
}

test("copyLayer: del fora-do-roteiro corta; garble de palavra do roteiro FREIA; alucinação corta", () => {
  const copy = "o gato preto";
  // falado: o gato gatoo preto banana [alucinação: xyz]
  const words: Word[] = [
    w("o", 0), w("gato", 1), w("gatoo", 2), w("preto", 3), w("banana", 4), w("xyz", 5, { hall: true }),
  ];
  const r = runCopyLayer(words, copy);

  // "gatoo" (garble de "gato", lev 1) → FREADO, nunca cortado
  assert.ok(r.braked.includes(2), "gatoo deveria ser freado pela guarda");
  // "banana" (palavra real, fora do roteiro) → cortado por copy
  assert.ok(r.cuts.some((c) => c.source === "copy" && c.startMs === 4000), "banana deveria ser corte de copy");
  // "gatoo" NÃO pode estar em nenhum corte
  assert.ok(!r.cuts.some((c) => c.startMs <= 2000 && c.endMs >= 2500 && c.startMs === 2000), "gatoo não pode ser cortado");
  // alucinação "xyz" → corte source hallucination
  assert.ok(r.cuts.some((c) => c.source === "hallucination" && c.startMs === 5000), "xyz deveria ser corte de alucinação");
});

test("copyLayer: sem copy → não corta por conteúdo, needsAi = true", () => {
  const words: Word[] = [w("qualquer", 0), w("coisa", 1)];
  const r = runCopyLayer(words, "");
  assert.equal(r.needsAi, true);
  assert.equal(r.cuts.filter((c) => c.source === "copy").length, 0);
});

test("copyLayer: retake curto (del que bate com copy) fica INTOCADO — copyLayer não tem autoridade sobre repetição", () => {
  // copy pede "vamos começar"; fala tem um retake curto: "vamos vamos começar"
  const copy = "vamos começar agora";
  const words: Word[] = [w("vamos", 0), w("vamos", 1), w("começar", 2), w("agora", 3)];
  const r = runCopyLayer(words, copy);
  // a 'vamos' extra bate com a copy mas foi del → NÃO vira candidato, NÃO é cortada.
  // Fica intocada; a IA decide no contexto (H2 fechado por construção).
  assert.deepEqual(r.retakeCandidates, [], "repetição não vira candidato");
  assert.equal(r.cuts.filter((c) => c.source === "copy").length, 0, "nada de del direto na repetição");
});
// H2 ANTES era um `todo` aqui: com copy, o Gotoh fragmentava o retake e a IA era clipada
// pelo restrictTo. Fechado por construção — o copyLayer não emite candidato sobre span que
// se repete (nem zona nem del), então não há restrictTo fragmentado. O todo foi DELETADO
// (não pode mais se manifestar), não deixado verde por acaso.
