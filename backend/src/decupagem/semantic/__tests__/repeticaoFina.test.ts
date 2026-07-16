import { test } from "node:test";
import assert from "node:assert/strict";
import { detectaRepeticaoFina } from "../repeticaoFina.js";
import type { Word } from "../../../../../shared/timeline.js";

const w = (t: string, s: number, e: number): Word => ({ text: t, start: s, end: e });

test("repetição fina: 'com a crux você' ×2 → corte da 1ª tomada, mantém a última", () => {
  // palavras FINAS reais medidas de 30.4–35.0s do vídeo (o canônico achatou em 'sabe' 2s)
  const words: Word[] = [
    w(" com", 30.40, 31.12), w(" a", 31.12, 31.32), w(" crux", 31.32, 31.78), w(" você", 31.78, 32.10),
    w(" com", 32.10, 33.16), w(" a", 33.16, 33.32), w(" crux", 33.32, 33.66), w(" você", 33.66, 33.86),
    w(" sabe", 33.86, 34.10), w(" exatamente", 34.10, 34.58), w(" quando", 34.58, 34.98),
  ];
  const r = detectaRepeticaoFina(words);
  assert.ok(r, "deve detectar a repetição");
  assert.equal(r!.vezes, 2);
  assert.equal(r!.cutStartMs, 30400);
  assert.equal(r!.cutEndMs, 32100); // fronteira EXATA: onset da 2ª tomada
  assert.match(r!.frase.toLowerCase(), /com a crux você/);
});

test("repetição fina: fala normal sem repetição → null (sem FP)", () => {
  const normal: Word[] = [
    w("quanto", 0, 0.3), w("a", 0.3, 0.4), w("sua", 0.4, 0.7), w("frota", 0.7, 1.1),
    w("perde", 1.1, 1.5), w("todo", 1.5, 1.8), w("mes", 1.8, 2.1),
  ];
  assert.equal(detectaRepeticaoFina(normal), null);
});

test("repetição fina: repetição curta (<3 palavras) não conta (coincidência)", () => {
  const curto: Word[] = [w("a", 0, 0.2), w("de", 0.2, 0.4), w("a", 0.4, 0.6), w("de", 0.6, 0.8)];
  assert.equal(detectaRepeticaoFina(curto), null);
});

test("repetição fina: ×3 tomadas → mantém só a última", () => {
  const tres: Word[] = [
    w("quer", 0.0, 0.3), w("saber", 0.3, 0.7), w("quanto", 0.7, 1.1),
    w("quer", 1.1, 1.4), w("saber", 1.4, 1.8), w("quanto", 1.8, 2.2),
    w("quer", 2.2, 2.5), w("saber", 2.5, 2.9), w("quanto", 2.9, 3.3),
  ];
  const r = detectaRepeticaoFina(tres);
  assert.ok(r);
  assert.equal(r!.vezes, 3);
  assert.equal(r!.cutStartMs, 0);
  assert.equal(r!.cutEndMs, 2200); // onset da 3ª (última) tomada
});
