import type { CutInterval } from "../semantic/types.js";
import type { EnergyTrack } from "../signal/energy.js";
import { mergeCuts } from "./merge.js";
import { snapCuts } from "./snap.js";
import { scoreCuts } from "./score.js";
import { shrinkAtEdges, type MsRange } from "./edges.js";

export { mergeCuts, DILATION_MS, EDGE_DISAGREE_MS } from "./merge.js";
export { snapCuts, SNAP_RADIUS_MS, VALLEY_FLOOR_DBFS, SNAP_PENALTY } from "./snap.js";
export { scoreCuts, APPLY_THRESHOLD, BREATH_REASON } from "./score.js";
export { keeperEdges, shrinkAtEdges, type MsRange } from "./edges.js";

/**
 * FASE 4 — pipeline de plano: merge (união+dilatação) → REGRA DE BORDA (encolhe cortes que
 * invadem uma palavra do keeper) → snap (vale de energia) → score (applied). `protect` =
 * intervalos das palavras mantidas (keeperEdges); sem ele, a regra de borda não roda.
 * Puro/determinístico.
 */
export function planCuts(intervals: CutInterval[], track?: EnergyTrack, protect?: MsRange[]): CutInterval[] {
  const merged = mergeCuts(intervals);
  const guarded = protect && protect.length ? shrinkAtEdges(merged, protect) : merged;
  const snapped = track ? snapCuts(guarded, track) : guarded;
  return scoreCuts(snapped);
}
