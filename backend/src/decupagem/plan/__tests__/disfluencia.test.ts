import { test } from "node:test";
import assert from "node:assert/strict";
import { disfluenciaLayer } from "../disfluenciaLayer.js";
import type { Word } from "../../../../../shared/timeline.js";
import type { CutInterval } from "../../semantic/types.js";

const blk = (s: number, e: number) => ({ startMs: s, endMs: e });
const w = (text: string, s: number, e: number, vadSeg = 0): Word => ({ text, start: s, end: e, vadSegmentIdx: vadSeg });
// blocos: [0-1000] [1500-2500] [3000-4000]
const blocks = [blk(0, 1000), blk(1500, 2500), blk(3000, 4000)];

test("disfluencia: palavra que ATRAVESSA fronteira de bloco → região marcada (applied:false, conf 0.5)", () => {
  const words = [w("a", 0.2, 0.5), w("colada", 0.8, 2.2), w("b", 3.1, 3.4)]; // "colada" 0.8-2.2 cruza bloco 0→1
  const r = disfluenciaLayer(words, blocks);
  assert.ok(r.length >= 1);
  assert.deepEqual(r[0].reason, ["disfluencia_provavel"]);
  assert.equal(r[0].applied, false);
  assert.equal(r[0].confidence, 0.5);
  assert.equal(r[0].copyIndependent, true);
});

test("disfluencia: duração degenerada (0s) e arrastada (≥1.5s) → marcada", () => {
  assert.ok(disfluenciaLayer([w("x", 1.6, 1.6), w("y", 1.9, 2.1)], blocks).length >= 1, "0s marca");
  assert.ok(disfluenciaLayer([w("x", 0.2, 0.5), w("arrastada", 0.6, 2.4)], blocks).length >= 1, "2s marca");
});

test("disfluencia: órfã em silêncio VAD (vadSegmentIdx -1) → marcada", () => {
  const r = disfluenciaLayer([w("orfa", 1.7, 1.9, -1)], blocks);
  assert.ok(r.length >= 1);
});

test("disfluencia: fala normal (dentro de 1 bloco, duração normal, não órfã) → NÃO marca", () => {
  const r = disfluenciaLayer([w("normal", 0.2, 0.6), w("fala", 1.6, 2.0)], blocks);
  assert.equal(r.length, 0);
});

test("disfluencia: SUPRIME onde falso_comeco/ai_retake já cobrem (alta confiança)", () => {
  const words = [w("colada", 0.8, 2.2)]; // cruza fronteira → região [0,2500]
  const existing: CutInterval[] = [{ startMs: 500, endMs: 2000, source: "ai_retake", reason: ["ai_retake_detection"], confidence: 0.95 }];
  assert.equal(disfluenciaLayer(words, blocks, existing).length, 0, "coberta por ai_retake → suprimida");
  assert.ok(disfluenciaLayer(words, blocks, []).length >= 1, "sem cobertura → marcada");
});
