import { test } from "node:test";
import assert from "node:assert/strict";
import { silenceLayer } from "../silenceLayer.js";
import { runDecupagem } from "../../index.js";
import type { VadSegment } from "../../signal/vad.js";
import type { Word } from "../../../../../shared/timeline.js";

const seg = (startMs: number, endMs: number, isSpeech: boolean): VadSegment => ({ startMs, endMs, isSpeech });

// ---------- #2 silenceLayer ----------
test("silenceLayer: não-fala ≥700ms → dead_air (conf 0.97) com respiro de 120ms; <700ms ignora", () => {
  const vad = [seg(0, 500, true), seg(500, 1500, false), seg(1500, 2000, true), seg(2000, 2500, false)];
  const cuts = silenceLayer(vad); // 500-1500 = 1000ms (≥700) ; 2000-2500 = 500ms (<700)
  assert.equal(cuts.length, 1, "só o silêncio ≥700ms vira corte");
  assert.equal(cuts[0].startMs, 620, "respiro 120ms no início");
  assert.equal(cuts[0].endMs, 1380, "respiro 120ms no fim");
  assert.deepEqual(cuts[0].reason, ["dead_air"]);
  assert.equal(cuts[0].confidence, 0.97);
});

test("silenceLayer: minSilenceMs e breathMs configuráveis", () => {
  const cuts = silenceLayer([seg(0, 800, false)], [], { minSilenceMs: 500, breathMs: 50 });
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].startMs, 50);
  assert.equal(cuts[0].endMs, 750);
});

test("silenceLayer: silêncio CONTIDO numa zona de retake é DESCARTADO (#1)", () => {
  // silêncio 500-1500 (≥700) cairia em corte, mas está dentro da zona [400,2000] → descarta
  const vad = [seg(0, 500, true), seg(500, 1500, false), seg(1500, 2000, true)];
  const semZona = silenceLayer(vad, []);
  assert.equal(semZona.length, 1, "sem zona → corta");
  const comZona = silenceLayer(vad, [{ startMs: 400, endMs: 2000 }]);
  assert.equal(comZona.length, 0, "dentro da zona → descartado (morre com as tomadas)");
});

// ---------- #3 alucinação apertada ----------
function orphan(text: string, i: number, gapMs: number): Word {
  const s = i * 2000; // bem espaçadas → cortes separados (não fundem no merge)
  return { text, start: s / 1000, end: (s + 300) / 1000, vadStartMs: s, vadEndMs: s + 300, vadSegmentIdx: -1, vadHallGapMs: gapMs };
}

test("órfã: gap não-fala ≥400ms → alucinação APLICADA; <400ms → fronteira_vad_incerta NÃO aplicada", () => {
  const words: Word[] = [orphan("isolada", 0, 900), orphan("Quer", 1, 200)];
  const r = runDecupagem(words, ""); // sem track/silêncio; só a órfã
  const isolada = r.all.find((c) => c.startMs === 0);
  const densa = r.all.find((c) => c.startMs === 2000);
  assert.ok(isolada && isolada.reason.includes("whisper_hallucination"), "gap 900ms → alucinação");
  assert.equal(isolada!.applied, true, "alucinação real aplica");
  assert.ok(densa && densa.reason.includes("fronteira_vad_incerta"), "gap 200ms → fronteira incerta");
  assert.equal(densa!.applied, false, "fronteira incerta NÃO aplica (não lasca fala densa)");
});
