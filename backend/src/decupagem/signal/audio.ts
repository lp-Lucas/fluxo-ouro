import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Taxa de amostragem única de todo o pipeline de decupagem. */
export const SAMPLE_RATE = 16000;

/**
 * Decodifica QUALQUER áudio/vídeo para PCM mono 16 kHz float32 e devolve as
 * amostras normalizadas em [-1, 1]. O ffmpeg faz a conversão (resample + downmix);
 * lemos o f32le cru do stdout — sem parser de WAV, sem dependência extra.
 */
export async function loadMono16k(mediaPath: string): Promise<Float32Array> {
  const { stdout } = await execFileP(
    "ffmpeg",
    ["-v", "error", "-i", mediaPath, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-acodec", "pcm_f32le", "-"],
    { encoding: "buffer", maxBuffer: 1 << 30 }, // 1 GB (folga p/ vídeos longos)
  );
  const buf = stdout as unknown as Buffer;
  const n = Math.floor(buf.length / 4);
  const out = new Float32Array(n);
  // readFloatLE é seguro independente do alinhamento do buffer.
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** RMS linear (0..1, fundo de escala = 1.0) de um trecho de amostras. */
export function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let acc = 0;
  const n = Math.max(1, to - from);
  for (let i = from; i < to; i++) acc += samples[i] * samples[i];
  return Math.sqrt(acc / n);
}

/** Converte RMS linear → dBFS (0 dBFS = amplitude 1.0). */
export function toDbfs(linear: number): number {
  return 20 * Math.log10(linear + 1e-12);
}

/** Converte dBFS → RMS linear. */
export function fromDbfs(db: number): number {
  return Math.pow(10, db / 20);
}

/** Amostra (índice) ↔ milissegundos, na taxa do pipeline. */
export const sampleToMs = (i: number): number => (i / SAMPLE_RATE) * 1000;
export const msToSample = (ms: number): number => Math.round((ms / 1000) * SAMPLE_RATE);
