import type { Cut, Seconds } from "./timeline";

/**
 * Plano de corte: mapeia o tempo do vídeo BRUTO (fonte) para o tempo do vídeo
 * FINAL (saída), removendo os trechos cortados e "emendando" o restante.
 *
 * Usado no render: o vídeo é dividido em segmentos mantidos e concatenado; e
 * legendas/zooms/popups têm seus tempos remapeados para o tempo de saída.
 */
export interface KeptSegment {
  srcStart: Seconds;
  srcEnd: Seconds;
  outStart: Seconds; // onde este segmento começa no vídeo final
}

export interface CutPlan {
  segments: KeptSegment[];
  outDuration: Seconds;
}

export function buildCutPlan(durationSec: Seconds, cuts: Cut[]): CutPlan {
  const active = cuts.filter((c) => c.enabled).sort((a, b) => a.start - b.start);

  // funde cortes que se sobrepõem
  const merged: { start: Seconds; end: Seconds }[] = [];
  for (const c of active) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end) last.end = Math.max(last.end, c.end);
    else merged.push({ start: Math.max(0, c.start), end: c.end });
  }

  const segments: KeptSegment[] = [];
  let cursor = 0, out = 0;
  for (const c of merged) {
    if (c.start > cursor) {
      const len = c.start - cursor;
      segments.push({ srcStart: cursor, srcEnd: c.start, outStart: out });
      out += len;
    }
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < durationSec) {
    segments.push({ srcStart: cursor, srcEnd: durationSec, outStart: out });
    out += durationSec - cursor;
  }
  return { segments, outDuration: out };
}

/** Converte um tempo da fonte para o tempo de saída; null se estiver num corte. */
export function remapTime(t: Seconds, plan: CutPlan): Seconds | null {
  for (const s of plan.segments) {
    if (t >= s.srcStart && t <= s.srcEnd) return s.outStart + (t - s.srcStart);
  }
  return null;
}

/**
 * Como `remapTime`, mas NUNCA devolve null: um tempo que caiu dentro de um corte
 * encosta no início do próximo trecho mantido. Para coisas que não podem sumir só
 * porque a borda caiu num corte — janela de legenda ajustada à mão, entrada de popup.
 */
export function remapTimeClamped(t: Seconds, plan: CutPlan): Seconds {
  for (const s of plan.segments) {
    if (t <= s.srcEnd) return s.outStart + Math.max(0, t - s.srcStart);
  }
  return plan.outDuration;
}
