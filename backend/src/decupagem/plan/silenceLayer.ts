import type { VadSegment } from "../signal/vad.js";
import type { CutInterval } from "../semantic/types.js";

/**
 * FASE 4/5 — CORTE DE SILÊNCIO (dead-air). Todo segmento do VAD `isSpeech: false` com
 * duração ≥ `minSilenceMs` vira um corte `dead_air`.
 *
 * FONTE DE TEMPO = VAD, sempre. NÃO usar gap entre palavras do Whisper: o erro #1 provou
 * por quê — o Whisper embutiu 1,4s de pausa DENTRO da palavra "multiplica" (2,2s de
 * duração), então um detector por gap-de-palavra é cego ao buraco; o VAD o vê.
 *
 * RESPIRO: não corta o silêncio inteiro — deixa `breathMs` (120ms) de folga em cada borda.
 * Fala sem nenhuma pausa soa robótica. Ambos configuráveis.
 */

export interface SilenceOpts {
  minSilenceMs?: number; // default 700
  breathMs?: number;     // default 120 (folga em cada borda)
}

export interface MsRange { startMs: number; endMs: number; }

/**
 * `zonesMs` = zonas de retake em ms. Cortes de silêncio CONTIDOS numa zona são DESCARTADOS:
 * os silêncios entre tomadas morrem junto com as tomadas (a IA remove os takes redundantes),
 * e o silêncio na borda do keeper não deve lascá-lo. Fora das zonas, corta normal.
 */
export function silenceLayer(vad: VadSegment[], zonesMs: MsRange[] = [], opts: SilenceOpts = {}): CutInterval[] {
  const minSilenceMs = opts.minSilenceMs ?? 700;
  const breathMs = opts.breathMs ?? 120;
  const inZone = (a: number, b: number) => zonesMs.some((z) => a >= z.startMs && b <= z.endMs);

  const cuts: CutInterval[] = [];
  for (const s of vad) {
    if (s.isSpeech) continue;
    if (s.endMs - s.startMs < minSilenceMs) continue;
    const startMs = s.startMs + breathMs;
    const endMs = s.endMs - breathMs;
    if (endMs <= startMs) continue;
    if (inZone(startMs, endMs)) continue; // dentro de zona de retake → descarta
    cuts.push({ startMs, endMs, source: "vad_silence", reason: ["dead_air"], confidence: 0.97 });
  }
  return cuts;
}
