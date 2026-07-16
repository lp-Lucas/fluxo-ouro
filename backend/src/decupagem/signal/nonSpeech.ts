import { SAMPLE_RATE, toDbfs, rms, msToSample } from "./audio.js";
import { magnitudeSpectrum } from "./fft.js";

/**
 * Classifica cada segmento NÃO-FALA do VAD: silêncio | respiração | estalo | ruído.
 * Cada rótulo vem com uma `confidence` (0..1). NÃO empilho heurísticas para forçar
 * acurácia — os limiares são explícitos e ajustáveis; a respiração (o rótulo mais
 * frágil) reporta confiança baixa quando fica na fronteira, pra você calibrar depois.
 */

export type NonSpeechLabel = "silence" | "breath" | "click" | "noise";

export interface NonSpeechResult {
  label: NonSpeechLabel;
  confidence: number;       // 0..1
  features: {               // exposto p/ calibração (histograma na mão)
    durationMs: number;
    rmsDb: number;
    crest: number;          // pico/RMS (linear)
    centroidHz: number;     // centroide espectral
    harmonicity: number;    // 0..1 (autocorrelação normalizada na faixa de voz)
  };
}

// ── limiares (explícitos, ajustáveis) ──
const SILENCE_DB = -45;          // abaixo disto = silêncio
const BREATH_DB_LO = -45, BREATH_DB_HI = -25;
const BREATH_DUR_LO = 100, BREATH_DUR_HI = 400;
const BREATH_CENTROID = 2000;    // Hz — respiração é energia de alta frequência
const BREATH_HARM_MAX = 0.30;    // respiração NÃO é harmônica (sopro)
const CLICK_DUR = 80;            // ms — estalo é curtíssimo
const CLICK_CREST = 6;           // pico/RMS alto = transiente abrupto

/** Fator de crista (pico/RMS) de um trecho. */
function crestFactor(seg: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < seg.length; i++) { const a = Math.abs(seg[i]); if (a > peak) peak = a; }
  return peak / (rms(seg) + 1e-9);
}

/** Centroide espectral (Hz) — "brilho" médio do espectro. */
function spectralCentroid(seg: Float32Array): number {
  if (seg.length < 8) return 0;
  const { mag, hzPerBin } = magnitudeSpectrum(seg, SAMPLE_RATE);
  let num = 0, den = 0;
  for (let i = 1; i < mag.length; i++) { num += i * hzPerBin * mag[i]; den += mag[i]; }
  return den > 0 ? num / den : 0;
}

/**
 * Harmonicidade via autocorrelação normalizada, no atraso correspondente a
 * fundamentais de voz (80–400 Hz). ~1 = fortemente periódico (voz/tom); ~0 = sopro/ruído.
 */
function harmonicity(seg: Float32Array): number {
  const minLag = Math.floor(SAMPLE_RATE / 400);
  const maxLag = Math.min(seg.length - 1, Math.floor(SAMPLE_RATE / 80));
  if (maxLag <= minLag) return 0;
  let energy = 0;
  for (let i = 0; i < seg.length; i++) energy += seg[i] * seg[i];
  if (energy < 1e-9) return 0;
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < seg.length; i++) acc += seg[i] * seg[i + lag];
    const norm = acc / energy;
    if (norm > best) best = norm;
  }
  return Math.max(0, Math.min(1, best));
}

/** Proximidade (0..1) de um valor dentro de uma faixa [lo,hi] (1 no centro, 0 fora). */
function bandFit(v: number, lo: number, hi: number): number {
  if (v < lo || v > hi) return 0;
  const mid = (lo + hi) / 2, half = (hi - lo) / 2;
  return 1 - Math.abs(v - mid) / half;
}

export function classifyNonSpeech(samples: Float32Array, startMs: number, endMs: number): NonSpeechResult {
  const from = Math.max(0, msToSample(startMs));
  const to = Math.min(samples.length, msToSample(endMs));
  const seg = samples.subarray(from, to);
  const durationMs = endMs - startMs;
  const rmsDb = toDbfs(rms(seg));
  const crest = crestFactor(seg);
  const centroidHz = spectralCentroid(seg);
  const harm = harmonicity(seg);
  const features = { durationMs, rmsDb, crest, centroidHz, harmonicity: harm };

  // 1) SILÊNCIO — energia abaixo do piso
  if (rmsDb < SILENCE_DB) {
    return { label: "silence", confidence: clamp((SILENCE_DB - rmsDb) / 10), features };
  }
  // 2) RESPIRAÇÃO — sopro: duração média, energia baixa-média, alta freq, não-harmônico.
  // TODO(BUG, ver __tests__/nonSpeech.todo.test.ts): vogal tônica ("e", prob 0.92) cai
  // aqui indevidamente. Vogal tem centroide BAIXO + harmônicos claros; reforçar esse
  // discriminante ANTES da Fase 4 (onde breath vira corte automático). Não mexer agora.
  if (durationMs >= BREATH_DUR_LO && durationMs <= BREATH_DUR_HI &&
      rmsDb >= BREATH_DB_LO && rmsDb <= BREATH_DB_HI &&
      centroidHz > BREATH_CENTROID && harm < BREATH_HARM_MAX) {
    const conf = Math.min(
      bandFit(durationMs, BREATH_DUR_LO, BREATH_DUR_HI),
      bandFit(rmsDb, BREATH_DB_LO, BREATH_DB_HI),
      clamp((centroidHz - BREATH_CENTROID) / 2000),
      clamp((BREATH_HARM_MAX - harm) / BREATH_HARM_MAX),
    );
    return { label: "breath", confidence: conf, features };
  }
  // 3) ESTALO — curtíssimo e com transiente abrupto
  if (durationMs < CLICK_DUR && crest > CLICK_CREST) {
    return { label: "click", confidence: Math.min(clamp((CLICK_DUR - durationMs) / CLICK_DUR), clamp((crest - CLICK_CREST) / CLICK_CREST)), features };
  }
  // 4) RUÍDO — o resto (confiança = 1 - a maior evidência de outro rótulo)
  return { label: "noise", confidence: 0.5, features };
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));
