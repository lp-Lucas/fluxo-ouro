import { test } from "node:test";
import assert from "node:assert/strict";
import { verificaRetake } from "../verificaRetake.js";
import type { Word } from "../../../../../shared/timeline.js";

const words = (txts: string[]): Word[] => txts.map((t, i) => ({ text: t, start: i, end: i + 0.5 }));
const P = ["Quer", "saber", "quanto", "sua", "frota", "está", "perdendo?"]; // a tomada repetida

test("['P P'] agrupado (2 takes) → interna k=2 = 1.0 → verificado", () => {
  const ws = words([...P, ...P, ...P, "Link", "na", "bio."]); // [0..6]P [7..13]P [14..20]P
  const r = verificaRetake(ws, 0, 13); // a IA agrupou 2 takes
  assert.equal(r.verified, true);
  assert.equal(r.sim, 1);
  assert.equal(r.via, "interna:k=2");
});

test("['P'] unitário → externa = 1.0 → verificado", () => {
  const ws = words([...P, ...P, ...P, "Link", "na", "bio."]);
  const r = verificaRetake(ws, 0, 6); // 1 take; o de fora repete
  assert.equal(r.verified, true);
  assert.equal(r.sim, 1);
  assert.equal(r.via, "externa");
});

test("['P P P'] agrupado (3 takes) → interna k=3 = 1.0 → verificado", () => {
  const ws = words([...P, ...P, ...P, "Link", "na", "bio."]);
  const r = verificaRetake(ws, 0, 20); // a IA agrupou os três
  assert.equal(r.verified, true);
  assert.equal(r.via, "interna:k=3");
});

test("'Se equipamento…' → nem interna nem externa → marcado", () => {
  const ws = words(["Se", "equipamento,", "os", "8", "horas", "de", "operação,", "27", "dias", "úteis.",
    "Isso", "é", "mais", "de", "45", "mil", "reais", "por", "mês,", "evaporando"]);
  const r = verificaRetake(ws, 0, 9);
  assert.equal(r.verified, false);
  assert.equal(r.via, "nenhuma");
  assert.ok(r.sim < 0.6);
});

test("fim da transcrição (sem janela após) → simExterna 0, sem crash → marcado", () => {
  const ws = words([...P, "Link", "na", "bio."]); // [7,8,9] = fim
  const r = verificaRetake(ws, 7, 9);
  assert.equal(r.verified, false);
  assert.ok(!Number.isNaN(r.sim));
});

test("falso começo 'agora multi' / 'agora multiplica' → externa ≥ 0.6 → verificado", () => {
  const ws = words(["agora", "multi", "agora", "multiplica", "pela", "sua"]);
  const r = verificaRetake(ws, 0, 1);
  assert.equal(r.verified, true);
  assert.equal(r.via, "externa");
});

test("três tomadas com a do MEIO divergindo (P P' P) → MIN puxa p/ baixo → marcado", () => {
  // P' bem diferente (>40%): mesma contagem de palavras, texto trocado
  const Plinha = ["compre", "agora", "mesmo", "sem", "pensar", "duas", "vezes"];
  const ws = words([...P, ...Plinha, ...P, "Link", "na", "bio."]);
  const r = verificaRetake(ws, 0, 20); // k=3: pares (P,P')↓ (P',P)↓ (P,P)=1 → MIN baixo
  assert.equal(r.verified, false, `MIN entre pares deveria reprovar; sim=${r.sim}`);
});
