import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEnergyTrack } from "../energy.js";
import { SAMPLE_RATE } from "../audio.js";
import { tone, silence, concat } from "./synth.js";

test("findNearestValley: pousa no vale de energia (silêncio entre dois tons)", () => {
  // tom 200ms | silêncio 100ms | tom 200ms → vale no centro do silêncio (~250ms)
  const sig = concat(tone(220, 200, 0.6), silence(100), tone(220, 200, 0.6));
  const track = buildEnergyTrack(sig);

  // consulta perto da borda (240ms); deve descer pro vale dentro de ±60ms
  const valley = track.findNearestValley(240, 60);
  assert.ok(valley >= 200 && valley <= 300, `vale ${valley}ms deve cair no silêncio [200,300]`);
  // a energia no vale é muito menor que dentro do tom
  assert.ok(track.rmsAt(valley) < track.rmsAt(100) * 0.2, "energia no vale << energia no tom");
});

test("findNearestValley: respeita o raio de busca", () => {
  const sig = concat(tone(220, 300, 0.6), silence(200));
  const track = buildEnergyTrack(sig);
  // consulta no meio do tom (150ms), raio pequeno (30ms) → NÃO alcança o silêncio (>300ms)
  const v = track.findNearestValley(150, 30);
  assert.ok(v >= 120 && v <= 180, `com raio 30ms o vale ${v} fica perto de 150ms, não pula pro silêncio`);
});

test("findNearestZeroCrossing: acha uma troca de sinal próxima", () => {
  const sig = tone(100, 100, 0.8); // 100Hz → cruza zero a cada ~80 amostras
  const track = buildEnergyTrack(sig);
  const idx = Math.round(0.02 * SAMPLE_RATE); // ~320
  const zc = track.findNearestZeroCrossing(idx);
  // é realmente um cruzamento por zero (troca de sinal entre zc-1 e zc)
  assert.ok((sig[zc - 1] <= 0) !== (sig[zc] <= 0), "zc deve ser troca de sinal");
  assert.ok(Math.abs(zc - idx) <= 80, "zc próximo do índice consultado");
});
