import { test } from "node:test";
import assert from "node:assert/strict";
import { keeperEdges, shrinkAtEdges } from "../edges.js";
import type { CutInterval } from "../../semantic/types.js";
import type { Word } from "../../../../../shared/timeline.js";

const w = (i: number): Word => ({ text: `w${i}`, start: i, end: i + 0.5, vadStartMs: i * 1000, vadEndMs: i * 1000 + 800, vadSegmentIdx: 0 });

// ---------- #2 regra de borda: encolher, não descartar ----------
test("shrinkAtEdges: silêncio que termina 200ms DENTRO do keeper → encolhe até a borda exata", () => {
  // keeper começa em 1000ms; corte de silêncio [600, 1200] entra 200ms no keeper
  const keeper = [{ startMs: 1000, endMs: 3000 }];
  const cut: CutInterval = { startMs: 600, endMs: 1200, source: "vad_silence", reason: ["dead_air"], confidence: 0.97 };
  const [out] = shrinkAtEdges([cut], keeper);
  assert.equal(out.startMs, 600, "início intacto (era só silêncio)");
  assert.equal(out.endMs, 1000, "fim ENCOLHIDO até a borda exata do keeper");
  assert.deepEqual(out.reason, ["dead_air"], "reason preservada");
  assert.equal(out.confidence, 0.97, "confidence intacta");
});

test("shrinkAtEdges: corte fora do keeper passa intacto; corte inteiro dentro some", () => {
  const keeper = [{ startMs: 1000, endMs: 3000 }];
  const fora: CutInterval = { startMs: 0, endMs: 500, source: "vad_silence", reason: ["dead_air"] };
  const dentro: CutInterval = { startMs: 1500, endMs: 2500, source: "vad_silence", reason: ["dead_air"] };
  const out = shrinkAtEdges([fora, dentro], keeper);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].startMs, out[0].endMs], [0, 500]);
});

test("shrinkAtEdges: invade pela direita → início empurrado até o fim do keeper", () => {
  const keeper = [{ startMs: 1000, endMs: 2000 }];
  const cut: CutInterval = { startMs: 1800, endMs: 2600, source: "ai_retake", reason: ["ai_retake_detection"], confidence: 0.95 };
  const [out] = shrinkAtEdges([cut], keeper);
  assert.equal(out.startMs, 2000);
  assert.equal(out.endMs, 2600);
});

// ---------- keeperEdges: word-based (o gap antes do keeper NÃO é keeper) ----------
test("keeperEdges: zona menos o que a IA cortou → só as PALAVRAS mantidas (word-based)", () => {
  // zona [0..5]; IA cortou [0..2] (takes redundantes). Keeper = palavras [3..5].
  const words = [0, 1, 2, 3, 4, 5].map(w);
  const aiCut: CutInterval = { startMs: 0, endMs: words[2].vadEndMs!, source: "ai_retake", reason: ["ai_retake_detection"] };
  const edges = keeperEdges(words, [{ from: 0, to: 5 }], [aiCut]);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].startMs, words[3].vadStartMs, "borda = 1ª palavra mantida ([3]), não o fim do corte");
  assert.equal(edges[0].endMs, words[5].vadEndMs);
});
