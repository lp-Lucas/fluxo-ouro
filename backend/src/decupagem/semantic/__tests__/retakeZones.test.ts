import { test, before } from "node:test";
import assert from "node:assert/strict";
import { detectaZonas, zonasCabeca, unirZonas, coalesceMicroBlocks } from "../retakeZones.js";
import { runCopyLayer } from "../copyLayer.js";
import { buildRestrictTo } from "../../index.js";
import { loadDicionario } from "../misheardGuard.js";
import type { Word } from "../../../../../shared/timeline.js";

before(async () => { await loadDicionario(); });

const words = (txts: string[]): Word[] => txts.map((t, i) => ({
  text: t, start: i, end: i + 0.5, vadStartMs: i * 1000, vadEndMs: i * 1000 + 500, vadSegmentIdx: 0,
}));
const P = ["Quer", "saber", "quanto", "sua", "frota", "está", "perdendo"]; // 7 palavras (≥5)

// ---------- detecção ----------
test("detectaZonas: 3 tomadas idênticas (≥5 palavras) → uma zona cobrindo as três", () => {
  const ws = words([...P, ...P, ...P, "Link", "na", "bio"]); // [0..20] = 3×P
  const z = detectaZonas(ws);
  assert.equal(z.length, 1);
  assert.deepEqual([z[0].from,z[0].to], [0,20]);
});

test("detectaZonas: repetição curta (<5 palavras) NÃO vira zona", () => {
  const ws = words(["sua", "frota", "sua", "frota", "está", "cara"]);
  assert.equal(detectaZonas(ws).length, 0);
});

test("detectaZonas: fala sem repetição → nenhuma zona", () => {
  const ws = words(["se", "você", "tem", "uma", "frota", "de", "vinte", "veículos", "grandes", "hoje"]);
  assert.equal(detectaZonas(ws).length, 0);
});

test("detectaZonas: fronteira EXATA — refino de fase exclui palavra dissimilar antes dos takes", () => {
  // "banana" (dissimilar) antes de P P: sem refino a família casaria [0,..] deslocada 1 índice
  // (1 palavra em 7 custa pouco no Levenshtein); com refino a fase pula p/ [1,14], EXATO.
  const ws = words(["banana", ...P, ...P]); // [1..7]=P [8..14]=P
  const z = detectaZonas(ws);
  assert.equal(z.length, 1);
  assert.deepEqual([z[0].from,z[0].to], [1,14], "a zona começa na 1ª palavra do take, banana fica fora");
});

test("detectaZonas: dois retakes ADJACENTES 'A A B B' → duas zonas distintas, sem sobreposição", () => {
  const A = ["compre", "agora", "sem", "pensar", "duas", "vezes"];
  const B = ["ligue", "para", "o", "nosso", "time", "hoje"];
  const z = detectaZonas(words([...A, ...A, ...B, ...B]));
  assert.equal(z.length, 2, "A-família e B-família são zonas separadas");
  assert.deepEqual([z[0].from,z[0].to], [0,11]);
  assert.deepEqual([z[1].from,z[1].to], [12,23]);
  assert.ok(z[0].to < z[1].from, "sem sobreposição");
});

// ---------- CABEÇA-DE-BLOCO (método 2) ----------
const blk = (s: number, e: number) => ({ startMs: s, endMs: e });
const wAt = (starts: number[]): Word[] => starts.map((s, i) => ({ text: `w${i}`, start: s, end: s + 0.2 }));

test("zonasCabeca: blocos com cabeças iguais encadeiam (SEM teto de pausa)", () => {
  const blocks = [blk(0, 1000), blk(1500, 2500), blk(9000, 10000)]; // pausa 6.5s entre 2 e 3
  const heads = ["quer saber quanto", "quer saber quanto", "quem sabe quantos"]; // garble no miolo do 3º
  const ws = wAt([0.2, 1.6, 9.2]);
  const z = zonasCabeca(blocks, heads, ws);
  assert.equal(z.length, 1, "similaridade encadeia mesmo com pausa longa (sem teto)");
  assert.equal(z[0].via, "cabeca");
  assert.deepEqual([z[0].from, z[0].to], [0, 2]);
});

test("zonasCabeca: cabeça dissimilar no meio QUEBRA a cadeia (guarda de intruso)", () => {
  const blocks = [blk(0, 1000), blk(1500, 2500), blk(3000, 4000)];
  const heads = ["quer saber quanto", "sem precisar de ninguem", "quer saber quanto"];
  const z = zonasCabeca(blocks, heads, wAt([0.2, 1.6, 3.2]));
  assert.equal(z.length, 0, "o intruso 'sem' quebra a cadeia em cada lado");
});

test("zonasCabeca: circuit breaker — cadeia > 20s abortada (patologia)", () => {
  const z = zonasCabeca([blk(0, 1000), blk(21000, 22000)], ["quer saber", "quer saber"], wAt([0.2, 21.2]));
  assert.equal(z.length, 0, "cadeia de 22s é abortada");
});

test("coalesceMicroBlocks: caco <400ms funde no vizinho de menor gap (desfaz o intruso garble)", () => {
  // "Agora muito"[12.26-13.02] + "Fica"[13.03-13.41] (380ms, gap 10ms ao prev) + "Agora multi"[13.86-15.87]
  const out = coalesceMicroBlocks([blk(12260, 13020), blk(13030, 13410), blk(13860, 15870)]);
  assert.equal(out.length, 2, "o caco de 380ms funde no prev (gap 10ms << 450ms ao next)");
  assert.deepEqual([out[0].startMs, out[0].endMs], [12260, 13410]);
  assert.deepEqual([out[1].startMs, out[1].endMs], [13860, 15870]);
});

test("coalesceMicroBlocks: blocos ≥400ms (frase repetida) não são tocados", () => {
  const out = coalesceMicroBlocks([blk(0, 820), blk(1000, 1920), blk(2500, 3400)]);
  assert.equal(out.length, 3);
});

test("unirZonas: sobreposição de métodos → via 'ambos'; separadas mantêm via", () => {
  const per = [{ from: 10, to: 20, via: "periodicidade" as const }];
  const cab = [{ from: 15, to: 25, via: "cabeca" as const }, { from: 40, to: 50, via: "cabeca" as const }];
  const u = unirZonas(per, cab);
  assert.equal(u.length, 2);
  assert.deepEqual([u[0].from, u[0].to, u[0].via], [10, 25, "ambos"]);
  assert.deepEqual([u[1].from, u[1].to, u[1].via], [40, 50, "cabeca"]);
});

// ---------- copyLayer se cala na zona ----------
test("copyLayer: 3 tomadas + copy com 1 ocorrência → retakeCandidates:[] e zona detectada", () => {
  const copy = "Quer saber quanto sua frota está perdendo? Link na bio.";
  const ws = words([...P, ...P, ...P, "Link", "na", "bio"]);
  const r = runCopyLayer(ws, copy);
  assert.deepEqual(r.retakeCandidates, [], "dentro da zona o copyLayer não emite candidatos");
  assert.equal(r.retakeZones.length, 1);
  assert.deepEqual([r.retakeZones[0].from,r.retakeZones[0].to], [0,20]);
  // e restrictTo dessa condição = undefined (IA livre na zona)
  assert.equal(buildRestrictTo(r.retakeCandidates, r.retakeZones, true), undefined);
});

// ---------- buildRestrictTo ----------
test("buildRestrictTo: zona pura → undefined; candidato solto → Set normal; sem copy → undefined", () => {
  assert.equal(buildRestrictTo([], [{ from: 0, to: 20 }], true), undefined, "zona pura → IA livre");
  const r = buildRestrictTo([42], [], true);
  assert.ok(r instanceof Set && r.has(42) && r.size === 1, "candidato solto → restrição normal");
  assert.equal(buildRestrictTo([42], [], false), undefined, "sem copy → undefined");
});

// ---------- H2 FECHADO + copy mantém autoridade sobre fora-do-roteiro ----------
test("H2 fechado: repetição curta fora de zona NÃO vira candidato; fora-do-roteiro AINDA é cortado", () => {
  // 'sua' repetido (bate com a copy) — curto, sem zona → INTOCADO (nem zona nem candidato)
  const copy = "a sua frota está cara demais hoje";
  const ws = words(["a", "sua", "sua", "frota", "está", "cara", "demais", "hoje"]);
  const r = runCopyLayer(ws, copy);
  assert.deepEqual(r.retakeZones, [], "repetição de 1 palavra não é zona");
  assert.deepEqual(r.retakeCandidates, [], "repetição não vira candidato (copyLayer sem autoridade)");
  assert.equal(buildRestrictTo(r.retakeCandidates, r.retakeZones, true), undefined, "sem candidato → restrictTo undefined");

  // MAS um fora-do-roteiro DE VERDADE (não bate com a copy) continua sendo cortado pela copy
  const ws2 = words(["a", "sua", "frota", "bananas", "está", "cara", "demais", "hoje"]);
  const r2 = runCopyLayer(ws2, copy);
  assert.ok(r2.cuts.some((c) => c.source === "copy"), "'bananas' fora do roteiro → copy corta (autoridade preservada)");
});
