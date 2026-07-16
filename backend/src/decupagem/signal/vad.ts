import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { loadMono16k, SAMPLE_RATE } from "./audio.js";

// onnxruntime-node é CommonJS (binário nativo) e não expõe tipos resolvíveis pelo TS —
// tipamos com uma interface mínima local (o contrato foi verificado em runtime).
interface OrtTensor { data: Float32Array | BigInt64Array; dims: number[]; }
interface OrtSession { run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>; }
interface Ort {
  InferenceSession: { create(modelPath: string): Promise<OrtSession> };
  Tensor: new (type: string, data: ArrayLike<number> | BigInt64Array, dims: number[]) => OrtTensor;
}
const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node") as Ort;

/**
 * Silero VAD (ONNX) — a ÚNICA autoridade de tempo do pipeline. Devolve um mapa
 * fala/não-fala REAL, sem buracos, com bordas em resolução de 10ms.
 *
 * O Silero v5 processa em janelas fixas de 512 amostras (32ms @16kHz) e devolve
 * uma probabilidade de fala por janela. A segmentação (histerese + minSilence +
 * pad) é o algoritmo get_speech_timestamps do Silero, reimplementado como função
 * PURA `probsToSegments` para ser testável sem o modelo.
 */

export interface VadSegment {
  startMs: number;
  endMs: number;
  isSpeech: boolean;
}

export interface VadOptions {
  threshold?: number;     // prob mínima p/ fala (default 0.5); histerese usa threshold-0.15
  minSilenceMs?: number;  // silêncio mínimo p/ fechar um trecho de fala (default 150)
  speechPadMs?: number;   // margem adicionada a cada lado de um trecho de fala (default 30)
  minSpeechMs?: number;   // trecho de fala mínimo (default 0 = não filtra; a classificação cuida)
}

// Frame de 512 amostras (32ms @16kHz) — contrato documentado do Silero v5 @16kHz.
// (O export do master usava 256 e quebrava aqui; por isso o modelo é PINADO no v5.1,
// verificado por sha256.) Exportado para os testes usarem o mesmo valor do pipeline.
export const WINDOW = 512;
const STATE_DIMS = [2, 1, 128] as const;
const GRID_MS = 10;        // resolução de saída

const MODEL_PATH = process.env.SILERO_VAD_PATH ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../models/silero_vad.onnx");

/** Verifica o sha256 do modelo contra o `.sha256` pinado (garante o export v5.1 correto). */
function verifyModelHash(): void {
  const shaFile = MODEL_PATH + ".sha256";
  if (!fs.existsSync(shaFile)) return; // sem arquivo de hash → não trava (ex.: modelo customizado por env)
  const want = fs.readFileSync(shaFile, "utf8").trim().split(/\s+/)[0];
  const got = crypto.createHash("sha256").update(fs.readFileSync(MODEL_PATH)).digest("hex");
  if (want && got !== want) {
    throw new Error(`silero_vad.onnx com hash inesperado (esperado ${want.slice(0, 16)}…, obtido ${got.slice(0, 16)}…). ` +
      `O modelo do master usa janela 256 e quebra com 512 — use o release PINADO v5.1.`);
  }
}

let sessionPromise: Promise<OrtSession> | null = null;
function getSession(): Promise<OrtSession> {
  if (!sessionPromise) { verifyModelHash(); sessionPromise = ort.InferenceSession.create(MODEL_PATH); }
  return sessionPromise;
}

/** Roda o Silero janela a janela e devolve a probabilidade de fala por janela. */
export async function computeSpeechProbs(samples: Float32Array): Promise<Float32Array> {
  const session = await getSession();
  const nWin = Math.floor(samples.length / WINDOW);
  const probs = new Float32Array(nWin);
  let state: Float32Array = new Float32Array(2 * 1 * 128); // zeros
  const srTensor = new ort.Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);
  for (let i = 0; i < nWin; i++) {
    // CÓPIA em array próprio: o Tensor lê do offset 0 do buffer subjacente e ignora o
    // offset de uma subarray (view) — sem copiar, toda janela leria os mesmos samples.
    const chunk = samples.slice(i * WINDOW, i * WINDOW + WINDOW);
    const input = new ort.Tensor("float32", chunk, [1, WINDOW]);
    const stateT = new ort.Tensor("float32", state, [...STATE_DIMS]);
    const out = await session.run({ input, state: stateT, sr: srTensor });
    probs[i] = (out.output.data as Float32Array)[0];
    state = Float32Array.from(out.stateN.data as Float32Array); // cópia do estado p/ realimentar
  }
  return probs;
}

/**
 * PURA: converte as probabilidades por janela em segmentos fala/não-fala SEM
 * BURACOS, cobrindo [0, totalMs], com bordas alinhadas ao grid de 10ms.
 * Algoritmo (Silero get_speech_timestamps):
 *  - histerese: entra em fala com prob≥threshold, sai com prob<threshold-0.15;
 *  - um mergulho de silêncio menor que minSilence NÃO fecha o trecho;
 *  - aplica speechPad de cada lado; funde trechos que passam a se sobrepor.
 */
export function probsToSegments(
  probs: Float32Array, totalSamples: number, opts: VadOptions = {},
): VadSegment[] {
  const threshold = opts.threshold ?? 0.5;
  const negThreshold = threshold - 0.15;
  const minSilence = Math.round(((opts.minSilenceMs ?? 150) / 1000) * SAMPLE_RATE);
  const speechPad = Math.round(((opts.speechPadMs ?? 30) / 1000) * SAMPLE_RATE);
  const minSpeech = Math.round(((opts.minSpeechMs ?? 0) / 1000) * SAMPLE_RATE);

  // 1) trechos de fala em AMOSTRAS
  const speeches: { start: number; end: number }[] = [];
  let triggered = false, start = 0, tempEnd = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    const cur = i * WINDOW;
    if (p >= threshold && tempEnd !== 0) tempEnd = 0;
    if (p >= threshold && !triggered) { triggered = true; start = cur; continue; }
    if (p < negThreshold && triggered) {
      if (tempEnd === 0) tempEnd = cur;
      if (cur - tempEnd < minSilence) continue; // mergulho curto: segue como fala
      if (tempEnd - start > minSpeech) speeches.push({ start, end: tempEnd });
      triggered = false; tempEnd = 0;
    }
  }
  if (triggered && totalSamples - start > minSpeech) speeches.push({ start, end: totalSamples });

  // 2) aplica pad e funde sobreposições
  const padded: { start: number; end: number }[] = [];
  for (const s of speeches) {
    const a = Math.max(0, s.start - speechPad);
    const b = Math.min(totalSamples, s.end + speechPad);
    const last = padded[padded.length - 1];
    if (last && a <= last.end) last.end = Math.max(last.end, b);
    else padded.push({ start: a, end: b });
  }

  // 3) amostras → ms alinhado ao grid de 10ms
  const totalMs = snap(sampleToMsLocal(totalSamples));
  const snapMs = (samp: number) => Math.max(0, Math.min(totalMs, snap(sampleToMsLocal(samp))));

  // 4) preenche buracos → lista sem gaps cobrindo [0, totalMs]
  const segs: VadSegment[] = [];
  let cursor = 0;
  for (const s of padded) {
    const a = snapMs(s.start), b = snapMs(s.end);
    if (b <= a) continue;
    if (a > cursor) segs.push({ startMs: cursor, endMs: a, isSpeech: false });
    // funde se colou no anterior de fala (após snap)
    const prev = segs[segs.length - 1];
    if (prev && prev.isSpeech && prev.endMs >= a) prev.endMs = Math.max(prev.endMs, b);
    else segs.push({ startMs: Math.max(cursor, a), endMs: b, isSpeech: true });
    cursor = Math.max(cursor, b);
  }
  if (cursor < totalMs) segs.push({ startMs: cursor, endMs: totalMs, isSpeech: false });
  if (segs.length === 0) segs.push({ startMs: 0, endMs: totalMs, isSpeech: false });
  return segs;
}

const sampleToMsLocal = (i: number) => (i / SAMPLE_RATE) * 1000;
const snap = (ms: number) => Math.round(ms / GRID_MS) * GRID_MS;

/** Pipeline completo: decodifica o mídia, roda o Silero e segmenta. */
export async function runVad(mediaPath: string, opts: VadOptions = {}): Promise<VadSegment[]> {
  const samples = await loadMono16k(mediaPath);
  const probs = await computeSpeechProbs(samples);
  return probsToSegments(probs, samples.length, opts);
}
