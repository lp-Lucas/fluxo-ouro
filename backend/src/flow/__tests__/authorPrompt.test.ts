import { test } from "node:test";
import assert from "node:assert/strict";
import { authorDesignPrompt, type VisionFn } from "../authorPrompt.js";
import { colorLaw } from "../../../../shared/flow.js";

// bloco COLOR LAW pré-montado — o autor v2 recebe o bloco pronto (não a identidade)
const blocoComIdent = colorLaw("fundo azul-marinho, acento azul elétrico, texto branco");
const blocoVazio = "";
const base = { texto: "Converse agora sem atraso", delta: "personagem olhando o celular", aspectRatio: "9:16" as const, stylePath: "/fake/estilo.png", layoutPath: "/fake/layout.png" };

/** Visão sintética: devolve, em ordem, as respostas dadas (uma por tentativa). */
function fakeVision(...respostas: string[]): VisionFn {
  let i = 0;
  return async () => respostas[Math.min(i++, respostas.length - 1)];
}
const corpo = (n: number) => Array.from({ length: n }, (_, k) => `w${k}`).join(" ");
const wrap = (prompt: string, style = "estilo escuro") => `<STYLE_DESC>${style}</STYLE_DESC><PROMPT>${prompt}</PROMPT>`;

test("guard TETO: corpo de 200 palavras dispara o teto de 150, roda o retry, 2º fracasso cai em raw", async () => {
  const v = fakeVision(wrap(corpo(200)), wrap(corpo(200))); // 200 nas duas tentativas
  const r = await authorDesignPrompt({ ...base, identityBlock: blocoVazio }, v);
  assert.equal(r.source, "raw", "cai em raw após 2 fracassos");
  assert.equal(r.tentativas, 2, "o retry rodou (2 tentativas)");
  assert.match(r.motivoFallback ?? "", /longo demais \(200/);
});

test("guard TETO: se o retry devolve corpo curto, aceita como claude na 2ª tentativa", async () => {
  const v = fakeVision(wrap(corpo(200)), wrap(corpo(40))); // 1ª estoura, 2ª cabe
  const r = await authorDesignPrompt({ ...base, identityBlock: blocoVazio }, v);
  assert.equal(r.source, "claude");
  assert.equal(r.tentativas, 2);
  assert.equal(r.wordCount, 40);
});

test("guard IDENTIDADE: saída sem PROJECT IDENTITY → re-injeta (garante o bloco, mantém o corpo)", async () => {
  const v = fakeVision(wrap("place the headline centered, glass card below")); // corpo válido, SEM identidade
  const r = await authorDesignPrompt({ ...base, identityBlock: blocoComIdent }, v);
  assert.equal(r.source, "claude", "não descarta o corpo do Claude");
  assert.ok(r.prompt.includes("PROJECT IDENTITY"), "a identidade foi re-injetada");
  assert.ok(r.prompt.includes("glass card"), "o corpo do Claude foi preservado");
});

test("parser: <PROMPT> sem fechar falha LIMPO (cai em raw), não explode", async () => {
  const quebrado = "<STYLE_DESC>x</STYLE_DESC><PROMPT>texto sem tag de fechar";
  const v = fakeVision(quebrado, quebrado);
  const r = await authorDesignPrompt({ ...base, identityBlock: blocoComIdent }, v); // não deve lançar
  assert.equal(r.source, "raw");
  assert.match(r.motivoFallback ?? "", /formato de saída inválido/);
  assert.ok(r.prompt.includes("PROJECT IDENTITY"), "o fallback raw ainda leva a identidade");
});

test("parser: formato inválido na 1ª, válido na 2ª → aceita como claude", async () => {
  const v = fakeVision("lixo sem tags", wrap("clean centered headline"));
  const r = await authorDesignPrompt({ ...base, identityBlock: blocoComIdent }, v);
  assert.equal(r.source, "claude");
  assert.equal(r.tentativas, 2);
});
