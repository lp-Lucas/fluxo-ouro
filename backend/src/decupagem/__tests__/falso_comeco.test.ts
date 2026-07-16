import { test } from "node:test";
import assert from "node:assert/strict";
import { runDecupagem } from "../index.js";
import type { Word } from "../../../../shared/timeline.js";

const wSpan = (text: string, s: number, e: number): Word => ({ text, start: s, end: e });
const headZone = { from: 0, to: 2, via: "cabeca" as const, cut: { startMs: 200, endMs: 1300 } };

// O E2E de convergência mede DETERMINISMO, não correção. Este mede correção da LEGENDA:
// o corte acústico de falso começo só é seguro onde a estrutura textual concorda com ele.

test("falso começo: corte que PARTE uma palavra canônica → applied:false, blocked_by (legenda intacta)", () => {
  // "multiplica" (0.5-2.0s) atravessa a borda do corte (1.3s) — o Whisper colou as duas tentativas nela
  const words = [wSpan("Agora", 0.2, 0.5), wSpan("multiplica", 0.5, 2.0), wSpan("pela", 2.0, 2.3)];
  const r = runDecupagem(words, "", { headZones: [headZone] });
  const fc = r.all.find((c) => c.reason.includes("falso_comeco"))!;
  assert.ok(fc, "detecta o falso começo");
  assert.equal(fc.applied, false, "NÃO aplica — partiria 'multiplica' e a legenda quebraria");
  assert.equal(fc.blocked_by, "caption_timestamp_collapse");
  assert.equal(fc.confidence, 0.9, "confiança intacta — a detecção é confiável, falta poder agir");
  assert.equal(r.cuts.length, 0, "nenhum corte aplicado → 'multiplica' sobrevive na legenda");
});

test("falso começo: fronteira de palavra LIMPA (nenhuma atravessa) → aplica (gate libera)", () => {
  const words = [wSpan("a", 0.2, 0.4), wSpan("b", 1.4, 1.8), wSpan("c", 2.0, 2.4)];
  const r = runDecupagem(words, "", { headZones: [headZone] });
  const fc = r.all.find((c) => c.reason.includes("falso_comeco"))!;
  assert.equal(fc.applied, true, "estrutura textual concorda → corte seguro");
  assert.equal(fc.blocked_by, undefined);
});
