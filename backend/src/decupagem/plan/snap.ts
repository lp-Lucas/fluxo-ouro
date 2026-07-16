import type { CutInterval } from "../semantic/types.js";
import type { EnergyTrack } from "../signal/energy.js";
import { toDbfs } from "../signal/audio.js";

/**
 * FASE 4 — SNAP. Faz as bordas do corte POUSAREM em silêncio real. Para cada borda:
 *
 *  1. vale de energia mais próximo dentro de ±60ms (findNearestValley já refina para o
 *     cruzamento por zero — emenda sem clique).
 *  2. se o vale NÃO é silêncio de verdade (RMS > −35 dBFS), penaliza a confiança em 0.3
 *     — cortar em cima de fala é arriscado; a Fase 5 pode não aplicar.
 *
 * O snap não move a borda para fora do corte a ponto de invertê-lo; se colapsar, mantém
 * o intervalo original (deixa a Fase 5 decidir).
 */

export const SNAP_RADIUS_MS = 60;
export const VALLEY_FLOOR_DBFS = -35;
export const SNAP_PENALTY = 0.3;

export function snapCuts(cuts: CutInterval[], track: EnergyTrack): CutInterval[] {
  return cuts.map((c) => {
    const start = track.findNearestValley(c.startMs, SNAP_RADIUS_MS);
    const end = track.findNearestValley(c.endMs, SNAP_RADIUS_MS);
    if (!(end > start)) return c; // snap colapsou/inverteu → não mexe

    // penaliza uma vez se QUALQUER borda pousou fora de silêncio real
    const noisyStart = toDbfs(track.rmsAt(start)) > VALLEY_FLOOR_DBFS;
    const noisyEnd = toDbfs(track.rmsAt(end)) > VALLEY_FLOOR_DBFS;
    const base = c.confidence ?? 1;
    const confidence = noisyStart || noisyEnd ? +Math.max(0, base - SNAP_PENALTY).toFixed(4) : base;

    return { ...c, startMs: Math.round(start), endMs: Math.round(end), confidence };
  });
}
