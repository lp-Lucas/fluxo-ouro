import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCuts } from "../merge.js";
import { snapCuts } from "../snap.js";
import { scoreCuts } from "../score.js";
import { planCuts } from "../index.js";
import { buildEnergyTrack } from "../../signal/energy.js";
import { tone, silence, concat } from "../../signal/__tests__/synth.js";
import type { CutInterval } from "../../semantic/types.js";

const cut = (startMs: number, endMs: number, source: CutInterval["source"], reason: string, confidence?: number): CutInterval =>
  ({ startMs, endMs, source, reason: [reason], confidence });

// ---------- MERGE: dilatação ----------
test("merge: folga ≤ 250ms funde num corte só; > 250ms mantém separados", () => {
  const near = mergeCuts([cut(0, 1000, "copy", "a"), cut(1200, 2000, "copy", "b")]); // folga 200
  assert.equal(near.length, 1, "folga 200ms deveria fundir");
  assert.deepEqual([near[0].startMs, near[0].endMs], [0, 2000]);

  const far = mergeCuts([cut(0, 1000, "copy", "a"), cut(1300, 2000, "copy", "b")]); // folga 300
  assert.equal(far.length, 2, "folga 300ms NÃO deveria fundir");
});

test("merge: reason[] acumula (sem duplicar) na união", () => {
  const m = mergeCuts([cut(0, 500, "copy", "fora_do_roteiro"), cut(400, 900, "hallucination", "whisper_hallucination"), cut(800, 1000, "copy", "fora_do_roteiro")]);
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].reason, ["fora_do_roteiro", "whisper_hallucination"]);
});

// ---------- MERGE: confiança concordante vs penalizada ----------
test("merge: fontes concordam nas bordas (≤300ms) → confidence = max", () => {
  const m = mergeCuts([cut(1000, 1500, "copy", "a", 0.9), cut(1050, 1480, "vad_silence", "b", 0.9)]);
  assert.equal(m.length, 1);
  assert.equal(m[0].confidence, 0.9, "bordas próximas → sem penalidade");
});

test("merge: fontes sobrepõem mas discordam da borda em > 300ms → penaliza", () => {
  const m = mergeCuts([cut(1000, 1500, "copy", "a", 0.9), cut(1000, 1900, "ai_retake", "b", 0.75)]);
  assert.equal(m.length, 1);
  assert.equal(m[0].confidence, 0.72, "fim discorda 400ms → 0.9*0.8");
});

test("merge: adjacência dilatada de fontes diferentes NÃO é divergência", () => {
  const m = mergeCuts([cut(1000, 1500, "copy", "a", 0.9), cut(1550, 2000, "hallucination", "b", 0.9)]); // folga 50, sem sobreposição
  assert.equal(m.length, 1);
  assert.equal(m[0].confidence, 0.9, "regiões adjacentes não conflitam");
});

// ---------- SNAP: vale de energia + penalidade RMS ----------
test("snap: borda perto de silêncio pousa no vale sem penalidade; dentro da fala penaliza 0.3", () => {
  // 200ms tom | 100ms silêncio | 200ms tom  → vale de energia em 200–300ms
  const sig = concat(tone(500, 200, 0.5), silence(100), tone(500, 200, 0.5));
  const track = buildEnergyTrack(sig);

  // corte cuja borda-início cai perto do silêncio (250) e o fim bem dentro do 2º tom (450)
  const [snapped] = snapCuts([cut(250, 450, "copy", "a", 0.9)], track);
  // início snapa pra dentro do silêncio (~200–300); fim fica em fala alta → penaliza uma vez
  assert.ok(snapped.startMs >= 200 && snapped.startMs <= 300, `início deveria pousar no silêncio, foi ${snapped.startMs}`);
  assert.equal(snapped.confidence, 0.6, "fim fora de silêncio → 0.9-0.3");
});

test("snap: ambas as bordas no silêncio → sem penalidade", () => {
  const sig = concat(tone(500, 150, 0.5), silence(120), tone(500, 150, 0.5), silence(120), tone(500, 150, 0.5));
  const track = buildEnergyTrack(sig);
  // vales em ~150–270 e ~420–540; corte de vale a vale
  const [snapped] = snapCuts([cut(210, 480, "copy", "a", 0.9)], track);
  assert.equal(snapped.confidence, 0.9, "duas bordas em silêncio → sem penalidade");
});

// ---------- SCORE: applied + exceção breath ----------
test("score: confidence ≥ 0.85 aplica; < 0.85 não", () => {
  const [hi, lo] = scoreCuts([cut(0, 100, "copy", "a", 0.9), cut(200, 300, "ai_retake", "b", 0.72)]);
  assert.equal(hi.applied, true);
  assert.equal(lo.applied, false);
});

test("score: corte SÓ de respiração NUNCA aplica (mesmo 0.92)", () => {
  const [breath] = scoreCuts([cut(0, 300, "vad_breath", "vad_breath", 0.92)]);
  assert.equal(breath.applied, false, "breath-only não aplica enquanto vogal→breath está aberto");
});

test("score: respiração sobreposta a corte com OUTRA razão aplica pela outra razão", () => {
  // merge de copy+breath → reason tem 'fora_do_roteiro' além de 'vad_breath' → não é breath-only
  const merged = mergeCuts([cut(0, 400, "copy", "fora_do_roteiro", 0.9), cut(100, 500, "vad_breath", "vad_breath", 0.92)]);
  const [scored] = scoreCuts(merged);
  assert.ok(scored.reason.includes("fora_do_roteiro") && scored.reason.includes("vad_breath"));
  assert.equal(scored.applied, true, "há razão não-respiração → aplica");
});

// ---------- pipeline ----------
test("planCuts: merge → snap → score end-to-end", () => {
  const sig = concat(tone(500, 200, 0.5), silence(100), tone(500, 200, 0.5));
  const track = buildEnergyTrack(sig);
  const out = planCuts([cut(50, 240, "copy", "a", 0.9), cut(260, 480, "copy", "b", 0.9)], track);
  assert.ok(out.length >= 1);
  assert.ok(out.every((c) => typeof c.applied === "boolean"), "todo corte tem applied após o pipeline");
});
