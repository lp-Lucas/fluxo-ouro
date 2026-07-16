import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAiPrompt } from "../aiRetake.js";
import type { Word } from "../../../../../shared/timeline.js";

function w(text: string, i: number, prob?: number): Word {
  const startMs = i * 1000, endMs = i * 1000 + 500;
  return {
    text, start: startMs / 1000, end: endMs / 1000,
    vadStartMs: startMs, vadEndMs: endMs, vadSegmentIdx: 0,
    ...(prob != null ? { probability: prob } : {}),
  };
}

// fixture: palavras com logprobs baixos (o histograma refutou a hipótese; nenhum número
// deve vazar pro prompt).
const words: Word[] = [
  w("axismo", 0, 0.61),   // mishear do transcritor, lp ~ -0.49
  w("tá", 1, 0.02),       // muleta real, lp ~ -3.9
  w("vamos", 2, 0.98),
  w("começar", 3, 0.97),
];

test("aiRetake: o prompt renderizado NÃO contém a string 'logprob'", () => {
  const prompt = buildAiPrompt(words, "vamos começar agora", 0);
  assert.ok(!prompt.includes("logprob"), "o prompt não pode mencionar logprob");
});

test("aiRetake: o prompt NÃO expõe números de probabilidade/lp por palavra", () => {
  const prompt = buildAiPrompt(words, "vamos começar", 0);
  assert.ok(!/\(lp\s/.test(prompt), "não pode haver '(lp ...)' por palavra");
  // o formato por palavra é [idx] texto — sem lp entre parênteses
  assert.ok(prompt.includes(`#0 "axismo"`), "formato deve ser '#idx \"texto\"'");
  assert.ok(!/"axismo"\s*\(/.test(prompt), "não pode haver parênteses de número após a palavra");
});

test("aiRetake: o prompt traz a distinção lexical não-palavra vs muleta, sem números", () => {
  const prompt = buildAiPrompt(words, "vamos começar", 0);
  assert.ok(prompt.includes("axismo") && prompt.includes("erros do TRANSCRITOR"),
    "deve explicar que não-palavras são erro do transcritor");
  assert.ok(prompt.includes('"tá"') && prompt.includes("muletas"),
    "deve explicar que muletas periféricas são cortadas");
  // nenhum limiar numérico (-1.0 etc.) no prompt
  assert.ok(!/-?\d+\.\d+/.test(prompt), "o prompt não pode conter limiares numéricos");
});
