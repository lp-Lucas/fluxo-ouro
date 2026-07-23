/**
 * SINCRONIA do tratamento de áudio — a propriedade inviolável do módulo.
 *
 * Os cortes, as legendas e os popups vivem em tempo de FONTE. Se o áudio tratado
 * sair com duração diferente, ou deslocado no tempo, o projeto inteiro
 * dessincroniza — e o sintoma (legenda "fora do lugar") não parece nem de longe
 * um problema de áudio, o que faz esse bug custar horas pra achar.
 *
 * Este teste roda o pipeline REAL (motor local, sem chave de API) num sinal
 * sintético e cobra três coisas:
 *   1. a saída tem a duração da origem;
 *   2. a voz isolada está alinhada com o original — inclusive depois de vários
 *      chunks, que é onde um atraso por fatia viraria deriva acumulada;
 *   3. as emendas entre chunks não abrem buraco.
 *
 * Regressão que ele trava: `afftdn` custa ~25 ms de latência POR passada. Sem a
 * correção de alinhamento, o stem saía 50 ms atrasado.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);
const SR = 48000;
const DUR = 60;
const CHUNK = 20; // força 4 chunks / 3 emendas num teste curto

// O env é lido na carga do módulo → precisa estar setado ANTES do import.
process.env.AUDIO_CHUNK_S = String(CHUNK);
const { tratarAudio, chaveOrigem } = await import("../enhance.js");
const { DEFAULT_AUDIO, LOUDNESS } = await import("../../../../shared/audio.js");

let dir: string;
let src: string;

/** Lê um WAV pcm_s16le mono (parser de RIFF mínimo). */
function lerWav(f: string): Int16Array {
  const b = fs.readFileSync(f);
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "data") return new Int16Array(b.buffer, b.byteOffset + off + 8, size >> 1);
    off += 8 + size + (size & 1);
  }
  throw new Error(`sem chunk data em ${f}`);
}

/** Deslocamento de `b` em relação a `a` numa janela, em ms (decimado 4× por velocidade). */
function atrasoMs(a: Int16Array, b: Int16Array, tSeg: number, janelaSeg: number): number {
  const D = 4, sr = SR / D;
  const maxLag = Math.round(0.04 * sr); // ±40 ms
  const ini = Math.round(tSeg * sr), n = Math.round(janelaSeg * sr);
  let melhorLag = 0, melhor = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let soma = 0;
    for (let i = 0; i < n; i++) {
      const av = a[(ini + i) * D], bv = b[(ini + i + lag) * D];
      if (av === undefined || bv === undefined) continue;
      soma += av * bv;
    }
    if (soma > melhor) { melhor = soma; melhorLag = lag; }
  }
  return (melhorLag / sr) * 1000;
}

async function duracao(f: string): Promise<number> {
  const { stdout } = await execFileP("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f,
  ]);
  return parseFloat(stdout.trim());
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-sync-"));
  src = path.join(dir, "src.wav");
  // Sinal tonal com AM e FM em períodos INCOMENSURÁVEIS (1,3 s e 7 s): sobrevive ao
  // denoise (ao contrário de ruído puro) e não se repete dentro da janela de busca,
  // então a correlação tem um pico único — sem isso o teste mediria lag ambíguo.
  await execFileP("ffmpeg", [
    "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i",
    `aevalsrc=0.35*sin(2*PI*(320+180*sin(2*PI*t/7))*t)*(0.35+0.65*sin(2*PI*t/1.3)^2):s=${SR}:d=${DUR}`,
    "-ac", "1", "-c:a", "pcm_s16le", src,
  ]);
});

after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

test("pipeline multi-chunk: duração exata, sem deriva e sem buraco nas emendas", async () => {
  const r = await tratarAudio(src, { ...DEFAULT_AUDIO, enhance: true }, dir);

  // 1. duração idêntica à origem
  const dIn = await duracao(src), dOut = await duracao(r.outPath);
  assert.ok(Math.abs(dOut - dIn) * 1000 <= 20, `duração fora: ${dIn}s → ${dOut}s`);

  const key = chaveOrigem(src);
  const dry = lerWav(path.join(dir, `audio-dry-${key}.wav`));
  const stem = fs.readdirSync(dir).find((f) => f.startsWith("voz-isolada-") && f.endsWith(`${key}.wav`));
  assert.ok(stem, "stem da voz isolada não foi gerado");
  const voz = lerWav(path.join(dir, stem));

  // 2. alinhamento ao longo do arquivo — um atraso por chunk apareceria crescendo
  for (const t of [10, 30, 50]) {
    const ms = atrasoMs(dry, voz, t, 2);
    assert.ok(Math.abs(ms) <= 5, `t=${t}s desalinhado em ${ms.toFixed(1)} ms`);
  }

  // 3. emendas dos chunks: crossfade errado deixaria silêncio na junção
  for (let t = CHUNK - 1; t + 1 < DUR; t += CHUNK - 1) {
    let pico = 0;
    for (let i = Math.round((t - 0.05) * SR); i < Math.round((t + 0.05) * SR); i++) {
      pico = Math.max(pico, Math.abs(voz[i] ?? 0));
    }
    assert.ok(pico > 30, `buraco na emenda em t=${t}s (pico ${pico})`);
  }
});

test("masterização entrega o loudness alvo do preset", async () => {
  const r = await tratarAudio(src, { ...DEFAULT_AUDIO, enhance: true, preset: "social" }, dir);
  const { stderr } = await execFileP("ffmpeg", [
    "-hide_banner", "-nostats", "-i", r.outPath, "-af", "loudnorm=print_format=json", "-f", "null", "-",
  ], { maxBuffer: 1 << 26 });
  const medido = Number(JSON.parse(stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1)).input_i);
  const alvo = LOUDNESS.social.i;
  assert.ok(Math.abs(medido - alvo) <= 1, `loudness ${medido} LUFS, alvo ${alvo}`);
});
