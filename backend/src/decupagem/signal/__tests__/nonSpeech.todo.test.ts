import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMono16k } from "../audio.js";
import { classifyNonSpeech } from "../nonSpeech.js";

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/**
 * TODO(nonSpeech) — BUG conhecido, NÃO consertar agora (decisão do produto):
 * a vogal tônica "e" (prob Whisper 0.92) foi classificada como `breath`. Vogal tem
 * CENTROIDE BAIXO e HARMÔNICOS CLAROS; respiração (sopro) não. O classificador atual
 * confunde os dois. Rever ANTES da Fase 4 — lá `breath` vira CORTE AUTOMÁTICO, então
 * classificar uma vogal como breath cortaria fala real com confiança 0.92.
 * Caso preservado em fixtures/vogal_vs_breath.wav (região da vogal = início do WAV).
 * Marcado { todo: true }: roda e reporta, mas não derruba a suíte.
 */
test("vogal 'e' NÃO deve ser classificada como breath", { todo: true }, async () => {
  const meta = JSON.parse(fs.readFileSync(path.join(FIX, "vogal_vs_breath.json"), "utf8"));
  const samples = await loadMono16k(path.join(FIX, "vogal_vs_breath.wav"));
  const r = classifyNonSpeech(samples, meta.regioes.vogal.startMs, meta.regioes.vogal.endMs);
  assert.notEqual(r.label, "breath",
    `vogal classificada como ${r.label} (centroid ${r.features.centroidHz.toFixed(0)}Hz, harmonicity ${r.features.harmonicity.toFixed(2)})`);
});
