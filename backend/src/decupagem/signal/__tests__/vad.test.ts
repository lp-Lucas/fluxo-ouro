import { test } from "node:test";
import assert from "node:assert/strict";
import { probsToSegments, WINDOW } from "../vad.js";
import { probRun } from "./synth.js";

// Cada janela = WINDOW amostras @16kHz. A borda de saída é grid de 10ms.
const WIN_MS = (WINDOW / 16000) * 1000;

test("probsToSegments: silêncio → fala → silêncio, bordas em ±10ms", () => {
  // 10 janelas silêncio | 30 fala | 20 silêncio (cauda longa p/ fechar independente da janela)
  const { probs, totalSamples } = probRun([
    { p: 0.05, windows: 10 },
    { p: 0.9, windows: 30 },
    { p: 0.05, windows: 20 },
  ]);
  const segs = probsToSegments(probs, totalSamples, { threshold: 0.5, minSilenceMs: 150, speechPadMs: 30 });

  // sem buracos, cobre [0, totalMs], sem sobreposição
  const totalMs = Math.round((totalSamples / 16000) * 1000 / 10) * 10;
  assert.equal(segs[0].startMs, 0);
  assert.equal(segs[segs.length - 1].endMs, totalMs);
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].startMs, segs[i - 1].endMs);

  const speech = segs.filter((s) => s.isSpeech);
  assert.equal(speech.length, 1, "deve haver exatamente 1 trecho de fala");

  // início da fala: janela 10 = 320ms, menos pad 30ms = ~290ms
  const expStart = 10 * WIN_MS - 30;
  assert.ok(Math.abs(speech[0].startMs - expStart) <= 10, `início ${speech[0].startMs} ~ ${expStart}`);
  // fim da fala: janela 40 = 1280ms, mais pad 30ms = ~1310ms
  const expEnd = 40 * WIN_MS + 30;
  assert.ok(Math.abs(speech[0].endMs - expEnd) <= 10, `fim ${speech[0].endMs} ~ ${expEnd}`);
});

test("probsToSegments: mergulho curto (<150ms) NÃO divide a fala", () => {
  // fala | 4 janelas de silêncio (<150ms em qualquer janela) | fala → segue UM trecho
  const { probs, totalSamples } = probRun([
    { p: 0.9, windows: 20 },
    { p: 0.05, windows: 4 },
    { p: 0.9, windows: 20 },
    { p: 0.05, windows: 20 },
  ]);
  const segs = probsToSegments(probs, totalSamples, { minSilenceMs: 150 });
  assert.equal(segs.filter((s) => s.isSpeech).length, 1, "mergulho curto não pode virar 2 trechos");
});

test("probsToSegments: mergulho longo (>150ms) DIVIDE a fala", () => {
  // fala | 12 janelas silêncio (>150ms em qualquer janela) | fala → dois trechos
  const { probs, totalSamples } = probRun([
    { p: 0.9, windows: 20 },
    { p: 0.05, windows: 12 },
    { p: 0.9, windows: 20 },
    { p: 0.05, windows: 20 },
  ]);
  const segs = probsToSegments(probs, totalSamples, { minSilenceMs: 150 });
  assert.equal(segs.filter((s) => s.isSpeech).length, 2, "silêncio longo deve separar em 2 trechos");
});

test("probsToSegments: tudo silêncio → um único não-fala, sem buracos", () => {
  const { probs, totalSamples } = probRun([{ p: 0.02, windows: 20 }]);
  const segs = probsToSegments(probs, totalSamples, {});
  assert.equal(segs.length, 1);
  assert.equal(segs[0].isSpeech, false);
  assert.equal(segs[0].startMs, 0);
});
