import type { Seconds } from "./timeline";

/** Um zoom (já em tempo de saída, se aplicável): início, duração e escala. */
export interface ZoomLike { at: Seconds; duration: Seconds; scale: number; }

/** Padrão da rampa (s) — igual à transição do preview (0.4s). */
export const ZOOM_RAMP = 0.4;

function easeInOut(p: number): number {
  const x = Math.max(0, Math.min(1, p));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * Escala de zoom SUAVE em um tempo `t`: rampa de entrada e saída (ease-in-out) de
 * `ramp` segundos — ANIMA o zoom em vez de dar um "zoom seco".
 *
 * Usada no preview E no export (paridade): antes o export aplicava a escala em
 * degrau (pulo brusco) enquanto o preview suavizava via transição CSS. Agora a
 * mesma curva vale nos dois lados. Zooms com scale≈1 são no-op.
 */
export function easedZoomScale(zooms: ZoomLike[], t: Seconds, ramp = ZOOM_RAMP): number {
  let scale = 1;
  for (const z of zooms) {
    if (Math.abs(z.scale - 1) < 1e-4) continue; // sem zoom
    const start = z.at, end = z.at + z.duration;
    if (t < start || t >= end) continue;
    const r = Math.min(ramp, z.duration / 2); // rampa não passa da metade da duração
    let k = 1;
    if (r > 0) {
      if (t < start + r) k = easeInOut((t - start) / r);       // entrada (1 → scale)
      else if (t > end - r) k = easeInOut((end - t) / r);      // saída  (scale → 1)
    }
    const s = 1 + (z.scale - 1) * k;
    if (Math.abs(s - 1) > Math.abs(scale - 1)) scale = s;       // pega o zoom mais forte
  }
  return scale;
}
