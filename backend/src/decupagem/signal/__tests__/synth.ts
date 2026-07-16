import { SAMPLE_RATE } from "../audio.js";
import { WINDOW } from "../vad.js";

/** Geradores de sinal sintético (16kHz mono) para os testes de sinal. Determinísticos. */

const nSamples = (ms: number) => Math.round((ms / 1000) * SAMPLE_RATE);

export function silence(ms: number): Float32Array {
  return new Float32Array(nSamples(ms));
}

export function tone(freqHz: number, ms: number, amp = 0.5): Float32Array {
  const n = nSamples(ms);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE);
  return out;
}

/** PRNG determinístico (mulberry32) → ruído branco reprodutível. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function whiteNoise(ms: number, amp = 0.3, seed = 1): Float32Array {
  const n = nSamples(ms);
  const rand = mulberry32(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * (rand() * 2 - 1);
  return out;
}

/**
 * Estalo: transiente IMPULSIVO — pico agudo com decaimento rápido (~1.5ms) e cauda
 * quase nula. É o que fisicamente é um "estalo" (lábio/boca), com crest alto: a
 * energia se concentra em poucos ms, o resto da janela é silêncio.
 */
export function click(ms: number, amp = 0.95, seed = 2): Float32Array {
  const n = nSamples(ms);
  const rand = mulberry32(seed);
  const out = new Float32Array(n);
  const tau = Math.max(4, Math.round(0.0015 * SAMPLE_RATE)); // ~1.5ms
  for (let i = 0; i < n; i++) {
    const env = Math.exp(-i / tau);
    if (env < 1e-3) break; // cauda vira silêncio de verdade
    out[i] = amp * env * (i === 0 ? 1 : rand() * 2 - 1);
  }
  return out;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Array de probabilidades Silero sintético: cada entrada = uma janela (WINDOW amostras). */
export function probRun(pattern: { p: number; windows: number }[]): { probs: Float32Array; totalSamples: number } {
  const flat: number[] = [];
  for (const { p, windows } of pattern) for (let i = 0; i < windows; i++) flat.push(p);
  return { probs: Float32Array.from(flat), totalSamples: flat.length * WINDOW };
}
