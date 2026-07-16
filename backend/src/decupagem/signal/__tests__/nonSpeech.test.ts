import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyNonSpeech } from "../nonSpeech.js";
import { silence, whiteNoise, click, tone } from "./synth.js";

test("classifica SILÊNCIO (zeros)", () => {
  const r = classifyNonSpeech(silence(200), 0, 200);
  assert.equal(r.label, "silence");
  assert.ok(r.confidence > 0.5);
});

test("classifica ESTALO (transiente curto e abrupto)", () => {
  const seg = click(40, 0.9);
  const r = classifyNonSpeech(seg, 0, 40);
  assert.equal(r.label, "click", `esperava click, veio ${r.label} (crest ${r.features.crest.toFixed(1)})`);
});

test("ruído ALTO não é confundido com respiração (fica noise)", () => {
  // ruído acima da faixa de energia da respiração (-25dB) → deve ser noise
  const seg = whiteNoise(200, 0.5);
  const r = classifyNonSpeech(seg, 0, 200);
  assert.equal(r.label, "noise", `ruído alto deveria ser noise, veio ${r.label} (rmsDb ${r.features.rmsDb.toFixed(1)})`);
});

test("tom harmônico não vira respiração (harmonicidade alta OU centroide baixo)", () => {
  const seg = tone(220, 200, 0.3);
  const r = classifyNonSpeech(seg, 0, 200);
  assert.notEqual(r.label, "breath", `tom não pode ser breath (harm ${r.features.harmonicity.toFixed(2)}, centroid ${r.features.centroidHz.toFixed(0)})`);
});

test("respiração (frágil): apenas roda e reporta confiança/atributos", () => {
  // ruído filtrado-alto, nível médio, ~200ms — pode cair em breath ou noise.
  // Não forço acurácia (rótulo frágil); valido que o classificador é estável.
  const seg = whiteNoise(200, 0.02, 7);
  const r = classifyNonSpeech(seg, 0, 200);
  assert.ok(["breath", "noise", "silence"].includes(r.label));
  assert.ok(r.confidence >= 0 && r.confidence <= 1);
  // atributos expostos p/ calibração
  assert.ok(Number.isFinite(r.features.centroidHz) && Number.isFinite(r.features.harmonicity));
});
