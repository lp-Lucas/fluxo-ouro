import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorWords, HALLUCINATION } from "../anchor.js";
import type { VadSegment } from "../signal/vad.js";
import type { Word } from "../../../../shared/timeline.js";

// VAD: fala em [1000,3000] e [5000,7000]ms (índices de fala 0 e 1)
const vad: VadSegment[] = [
  { startMs: 0, endMs: 1000, isSpeech: false },
  { startMs: 1000, endMs: 3000, isSpeech: true },
  { startMs: 3000, endMs: 5000, isSpeech: false },
  { startMs: 5000, endMs: 7000, isSpeech: true },
  { startMs: 7000, endMs: 9000, isSpeech: false },
];
const w = (start: number, end: number): Word => ({ text: "x", start, end });

test("palavra DENTRO de um trecho → clampa às bordas da palavra (idx do trecho)", () => {
  const [r] = anchorWords([w(1.5, 2.5)], vad);
  assert.equal(r.vadSegmentIdx, 0);
  assert.equal(r.vadStartMs, 1500);
  assert.equal(r.vadEndMs, 2500);
});

test("palavra vazando pro silêncio → clampa a borda ao trecho de fala", () => {
  // começa antes do trecho (800ms) e termina dentro (1500ms) → start clampado a 1000
  const [r] = anchorWords([w(0.8, 1.5)], vad);
  assert.equal(r.vadSegmentIdx, 0);
  assert.equal(r.vadStartMs, 1000);
  assert.equal(r.vadEndMs, 1500);
});

test("palavra CRUZANDO dois trechos → estende para cobrir os tocados", () => {
  const [r] = anchorWords([w(2.5, 5.5)], vad); // toca fala 0 e 1
  assert.equal(r.vadSegmentIdx, 0);
  assert.equal(r.vadStartMs, 2500);
  assert.equal(r.vadEndMs, 5500);
});

test("órfã ENCOSTADA (≤100ms) → absorve ao trecho mais próximo, NÃO é alucinação", () => {
  // palavra em [3020,3080]ms, 20ms depois do fim da fala 0 (3000) → absorve
  const [r] = anchorWords([w(3.02, 3.08)], vad);
  assert.equal(r.vadSegmentIdx, 0);
  assert.notEqual(r.vadSegmentIdx, HALLUCINATION);
  // absorvida: a borda encosta no trecho (start puxado até o fim da fala)
  assert.ok(r.vadStartMs! <= 3000, `start ${r.vadStartMs} deve encostar no fim da fala (3000)`);
});

test("órfã ISOLADA (>100ms em silêncio) → vadSegmentIdx = -1 (alucinação)", () => {
  // palavra em [4000,4200]ms, a 1000ms de qualquer fala
  const [r] = anchorWords([w(4.0, 4.2)], vad);
  assert.equal(r.vadSegmentIdx, HALLUCINATION);
});

test("100ms é a fronteira: 100ms absorve, 110ms é alucinação", () => {
  const abs = anchorWords([w(3.1, 3.15)], vad)[0];   // 100ms depois de 3000
  const hal = anchorWords([w(3.11, 3.16)], vad)[0];  // 110ms depois
  assert.equal(abs.vadSegmentIdx, 0);
  assert.equal(hal.vadSegmentIdx, HALLUCINATION);
});
