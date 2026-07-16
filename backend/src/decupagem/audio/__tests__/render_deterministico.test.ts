import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { renderDecupadoAudio, buildFilterComplex, type KeptSpan } from "../render.js";

const execFileP = promisify(execFile);
const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const SR = 48000;

async function duration(f: string): Promise<number> {
  const { stdout } = await execFileP("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f,
  ]);
  return parseFloat(stdout.trim());
}

let dir: string;
let src: string;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "decup-audio-"));
  src = path.join(dir, "src.wav");
  await execFileP("ffmpeg", [
    "-hide_banner", "-v", "error", "-y", "-bitexact", "-fflags", "+bitexact",
    "-f", "lavfi", "-i", `sine=frequency=440:duration=3:sample_rate=${SR}`,
    "-ac", "2", "-flags", "+bitexact", "-map_metadata", "-1", src,
  ]);
});

after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

// ---------- filter_complex (puro) ----------
test("buildFilterComplex: 1 segmento → sem crossfade, fade de 5ms nas pontas", () => {
  const { filter, outLabel } = buildFilterComplex([{ srcStart: 0, srcEnd: 1 }], 10);
  assert.equal(outLabel, "aout");
  assert.ok(!filter.includes("acrossfade"));
  assert.ok(filter.includes("afade=t=in") && filter.includes("afade=t=out"));
});

test("buildFilterComplex: N segmentos → cadeia acrossfade equal-power (qsin), bordas estendidas p/ o corte", () => {
  const spans: KeptSpan[] = [{ srcStart: 0, srcEnd: 0.5 }, { srcStart: 0.7, srcEnd: 1.2 }, { srcStart: 1.5, srcEnd: 2 }];
  const { filter, outLabel } = buildFilterComplex(spans, 10);
  assert.equal(outLabel, "aout");
  assert.equal((filter.match(/acrossfade/g) ?? []).length, 2, "2 emendas p/ 3 segmentos");
  assert.ok(filter.includes("c1=qsin:c2=qsin"), "crossfade equal-power");
  // 1º segmento não estende à esquerda (start=0.000000); 2º empresta 5ms à esquerda (0.695)
  assert.ok(filter.includes("atrim=start=0.000000:end=0.505000"), "1º: sem extensão esquerda, +5ms direita");
  assert.ok(filter.includes("atrim=start=0.695000:end=1.205000"), "2º (interno): +5ms nos dois lados");
  assert.ok(filter.includes("atrim=start=1.495000:end=2.000000"), "último: +5ms esquerda, sem extensão direita");
});

// ---------- determinismo de render.ts (NÃO é paridade preview↔export) ----------
test("determinismo: mesmo plano → hash sha256 idêntico (render.ts é reprodutível)", async () => {
  const spans: KeptSpan[] = [{ srcStart: 0, srcEnd: 0.5 }, { srcStart: 1.0, srcEnd: 1.5 }];
  const a = path.join(dir, "a.wav"), b = path.join(dir, "b.wav");
  await renderDecupadoAudio(src, spans, a);
  await renderDecupadoAudio(src, spans, b);
  assert.equal(sha(a), sha(b), "o mesmo plano de corte deve produzir bytes idênticos");
});

// A paridade REAL preview↔export só existe após o wiring (hoje o preview toca o <video>
// original com seek; o export toca este WAV — caminhos distintos, nada compartilhado).
// Deixado VISÍVEL na saída dos testes até lá.
test("paridade preview↔export: mesmo WAV nos dois caminhos", { todo: "aguarda o wiring do preview (Fase pós-5)" });

// ---------- DURAÇÃO PRESERVADA (crossfade não encurta) ----------
test("duração: crossfade preserva Σ(srcEnd−srcStart) dentro de ±1 amostra", async () => {
  // segmentos alinhados à amostra (múltiplos exatos de 1/48000): 0.5+0.5+0.5 = 1.5s
  const spans: KeptSpan[] = [{ srcStart: 0, srcEnd: 0.5 }, { srcStart: 0.7, srcEnd: 1.2 }, { srcStart: 1.5, srcEnd: 2.0 }];
  const out = path.join(dir, "preserved.wav");
  await renderDecupadoAudio(src, spans, out);
  const sum = spans.reduce((a, s) => a + (s.srcEnd - s.srcStart), 0); // 1.5
  const dur = await duration(out);
  const err = Math.abs(dur - sum);
  assert.ok(err <= 1 / SR + 1e-9, `duração ${dur}s vs Σ ${sum}s difere ${(err * 1000).toFixed(3)}ms (> 1 amostra)`);
});

test("duração: 1 segmento único = seu próprio comprimento", async () => {
  const out = path.join(dir, "one.wav");
  await renderDecupadoAudio(src, [{ srcStart: 0.25, srcEnd: 1.25 }], out);
  const dur = await duration(out);
  assert.ok(Math.abs(dur - 1.0) <= 1 / SR + 1e-9, `duração ${dur}s ≠ 1.0s`);
});
