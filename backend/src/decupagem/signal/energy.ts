import { SAMPLE_RATE, rms, sampleToMs, msToSample } from "./audio.js";

/**
 * Envelope de energia (RMS) e busca de borda. É o que faz a borda do corte
 * POUSAR em silêncio real — nunca num timestamp inventado. Janela de 10ms, hop
 * de 5ms. `findNearestValley` acha o vale de energia; `findNearestZeroCrossing`
 * refina para o cruzamento por zero (emenda de áudio sem clique).
 */

const WIN_MS = 10;
const HOP_MS = 5;
const WIN = Math.round((WIN_MS / 1000) * SAMPLE_RATE); // 160 amostras
const HOP = Math.round((HOP_MS / 1000) * SAMPLE_RATE); // 80 amostras

export interface EnergyTrack {
  readonly samples: Float32Array;
  readonly hopMs: number;
  readonly rmsHops: Float32Array;           // RMS por hop (linear)
  /** RMS linear no tempo dado (hop mais próximo). */
  rmsAt(timeMs: number): number;
  /**
   * Vale de energia mais próximo de `timeMs` dentro de ±`radiusMs`, refinado
   * para o cruzamento por zero mais próximo. Devolve o tempo em ms.
   */
  findNearestValley(timeMs: number, radiusMs?: number): number;
  /** Cruzamento por zero mais próximo de um índice de amostra (puro). */
  findNearestZeroCrossing(sampleIdx: number): number;
}

export function buildEnergyTrack(samples: Float32Array): EnergyTrack {
  const nHops = Math.max(1, Math.floor((samples.length - WIN) / HOP) + 1);
  const rmsHops = new Float32Array(nHops);
  for (let k = 0; k < nHops; k++) {
    const from = k * HOP;
    rmsHops[k] = rms(samples, from, Math.min(samples.length, from + WIN));
  }

  /** Centro (em amostras) do hop k. */
  const hopCenterSample = (k: number) => k * HOP + WIN / 2;

  const findNearestZeroCrossing = (sampleIdx: number): number => {
    const i0 = Math.max(1, Math.min(samples.length - 1, Math.round(sampleIdx)));
    const limit = WIN; // não vai além de uma janela procurando
    for (let d = 0; d <= limit; d++) {
      const r = i0 + d, l = i0 - d;
      if (r < samples.length && samples[r - 1] <= 0 !== samples[r] <= 0) return r;
      if (l > 0 && samples[l - 1] <= 0 !== samples[l] <= 0) return l;
    }
    return i0;
  };

  const rmsAt = (timeMs: number): number => {
    const k = Math.max(0, Math.min(nHops - 1, Math.round((msToSample(timeMs) - WIN / 2) / HOP)));
    return rmsHops[k];
  };

  const findNearestValley = (timeMs: number, radiusMs = 60): number => {
    const centerSample = msToSample(timeMs);
    const radiusSamples = (radiusMs / 1000) * SAMPLE_RATE;
    const kLo = Math.max(0, Math.floor((centerSample - radiusSamples - WIN / 2) / HOP));
    const kHi = Math.min(nHops - 1, Math.ceil((centerSample + radiusSamples - WIN / 2) / HOP));
    let best = kLo, bestRms = Infinity;
    for (let k = kLo; k <= kHi; k++) {
      // desempate pelo mais próximo do centro quando a energia empata
      if (rmsHops[k] < bestRms - 1e-9 ||
        (Math.abs(rmsHops[k] - bestRms) <= 1e-9 && Math.abs(hopCenterSample(k) - centerSample) < Math.abs(hopCenterSample(best) - centerSample))) {
        best = k; bestRms = rmsHops[k];
      }
    }
    const zc = findNearestZeroCrossing(hopCenterSample(best));
    return sampleToMs(zc);
  };

  return { samples, hopMs: HOP_MS, rmsHops, rmsAt, findNearestValley, findNearestZeroCrossing };
}
