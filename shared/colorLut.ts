import type { ColorSettings, ColorBasic } from "./color.js";
import type { ParsedLut } from "./lut.js";

/**
 * Compõe a correção de cor (correção básica + LUT do usuário + intensidade) num
 * ÚNICO LUT 3D e devolve o texto .cube. O export aplica esse .cube via ffmpeg
 * `lut3d=interp=trilinear` → MESMA matemática RGB do shader do preview (paridade).
 *
 * A ordem é idêntica ao shader (ver shared/color.ts):
 *   contraste → brilho → gamma → saturação → mix(imagem, LUT(imagem), intensidade)
 */

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const LW: [number, number, number] = [0.2126, 0.7152, 0.0722]; // pesos de luma BT.709

/** Correção básica em RGB — MESMAS fórmulas do shader. */
function applyBasic(r: number, g: number, b: number, s: ColorBasic): [number, number, number] {
  const f = (x: number) => {
    x = (x - 0.5) * s.contrast + 0.5; // contraste
    x = x + s.brightness;             // brilho
    x = clamp01(x);
    return Math.pow(x, 1 / s.gamma);  // gamma
  };
  let rr = f(r), gg = f(g), bb = f(b);
  const luma = LW[0] * rr + LW[1] * gg + LW[2] * bb;
  rr = luma + (rr - luma) * s.saturation; // saturação = mix(luma, canal, sat)
  gg = luma + (gg - luma) * s.saturation;
  bb = luma + (bb - luma) * s.saturation;
  return [clamp01(rr), clamp01(gg), clamp01(bb)];
}

/** Amostra a LUT do usuário por interpolação trilinear (== lut3d trilinear / textura LINEAR). */
function sampleLut(lut: ParsedLut, r: number, g: number, b: number): [number, number, number] {
  const n = lut.size;
  const norm = (v: number, mn: number, mx: number) => clamp01((v - mn) / (mx - mn || 1)) * (n - 1);
  const x = norm(r, lut.domainMin[0], lut.domainMax[0]);
  const y = norm(g, lut.domainMin[1], lut.domainMax[1]);
  const z = norm(b, lut.domainMin[2], lut.domainMax[2]);
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const x1 = Math.min(x0 + 1, n - 1), y1 = Math.min(y0 + 1, n - 1), z1 = Math.min(z0 + 1, n - 1);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  const at = (xi: number, yi: number, zi: number, c: number) => lut.data[((zi * n + yi) * n + xi) * 3 + c];
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = at(x0, y0, z0, c) * (1 - fx) + at(x1, y0, z0, c) * fx;
    const c10 = at(x0, y1, z0, c) * (1 - fx) + at(x1, y1, z0, c) * fx;
    const c01 = at(x0, y0, z1, c) * (1 - fx) + at(x1, y0, z1, c) * fx;
    const c11 = at(x0, y1, z1, c) * (1 - fx) + at(x1, y1, z1, c) * fx;
    const c0 = c00 * (1 - fy) + c10 * fy;
    const c1 = c01 * (1 - fy) + c11 * fy;
    out[c] = c0 * (1 - fz) + c1 * fz;
  }
  return out;
}

/**
 * Transformação de cor por pixel (RGB 0..1) — a MESMA que o shader do preview faz:
 * correção básica → mix(imagem, LUT(imagem), intensidade). Usada pela composição
 * do .cube e pela validação de paridade (referência do preview).
 */
export function transformPixel(
  color: ColorSettings, userLut: ParsedLut | null, r: number, g: number, b: number,
): [number, number, number] {
  let [rr, gg, bb] = applyBasic(r, g, b, color.basic);
  const useLut = !!userLut && !!color.lut && color.lut.intensity > 0;
  if (useLut) {
    const [lr, lg, lb] = sampleLut(userLut!, rr, gg, bb);
    const t = color.lut!.intensity;
    rr = rr + (lr - rr) * t;
    gg = gg + (lg - gg) * t;
    bb = bb + (lb - bb) * t;
  }
  return [rr, gg, bb];
}

export function composeColorCubeText(color: ColorSettings, userLut: ParsedLut | null, size = 65): string {
  const lines: string[] = [`# Fluxo Ouro — LUT composta (correção + LUT + intensidade)`, `LUT_3D_SIZE ${size}`];
  const den = size - 1;
  // Ordem .cube: r varia mais rápido, depois g, depois b.
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const [r, g, b] = transformPixel(color, userLut, ri / den, gi / den, bi / den);
        lines.push(`${r.toFixed(6)} ${g.toFixed(6)} ${b.toFixed(6)}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}
