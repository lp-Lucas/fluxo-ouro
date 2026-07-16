/**
 * Módulo Color — correção de cor básica + LUT (.cube).
 *
 * REQUISITO DE PARIDADE preview↔export: a mesma matemática, na mesma ORDEM,
 * nos dois lados.  Ordem fixa (sem exceção):
 *     vídeo fonte → correção básica → LUT → saída
 *
 * ── DECISÃO DE PARIDADE (investigação + escolha) ──
 * O `eq` do ffmpeg opera em YUV (vf_eq.c): brilho/contraste/gamma na luma,
 * saturação na croma. Replicar isso num shader WebGL (que recebe RGB já
 * decodificado pelo browser) é FRÁGIL: diferenças de range (limited/full) e de
 * matriz entre o decode do browser e os planos YUV crus do ffmpeg quebram a
 * tolerância de <2/255. Por isso NÃO usamos `eq`.
 *
 * ESTRATÉGIA ESCOLHIDA: operar em RGB dos DOIS lados, com fórmulas idênticas.
 *   Ordem fixa: contraste → brilho → gamma → saturação → (LUT).
 *   Fórmulas RGB (aplicadas por canal, com rgb em 0..1):
 *     c = (c - 0.5) * contrast + 0.5        // contraste
 *     c = c + brightness                    // brilho
 *     c = pow(clamp(c,0,1), 1 / gamma)      // gamma
 *     luma = dot(c, [0.2126, 0.7152, 0.0722])   // pesos BT.709
 *     c = mix(vec3(luma), c, saturation)    // saturação
 *   LUT: trilinear (textura 3D LINEAR no shader == `lut3d interp=trilinear`),
 *        com mix de intensidade: c = mix(c, lut(c), intensity).
 *
 * Export (Fase 4): a correção básica é "assada" num LUT 3D (identidade→fórmulas
 * acima) e aplicada via ffmpeg `lut3d`, seguida do `.cube` do usuário. Como os
 * dois lados usam a MESMA matemática RGB + LUT trilinear, a paridade é por
 * construção (só difere por precisão de float). Validação obrigatória na Fase 5.
 *
 * Fora do escopo v1 (schema deixado extensível): temperatura/tint, curvas,
 * HSL por faixa, vetorscópio.
 */

export interface ColorBasic {
  brightness: number; // -1 a +1  (default 0)   → eq: brightness
  contrast: number;   //  0 a 2   (default 1)   → eq: contrast
  saturation: number; //  0 a 2   (default 1)   → eq: saturation
  gamma: number;      //  0.5 a 2 (default 1)   → eq: gamma
}

export interface ColorLut {
  file: string | null; // referência (nome/hash) do .cube em /uploads/luts — NÃO o conteúdo
  intensity: number;   // 0..1 — mix entre imagem corrigida e imagem com LUT
}

export interface ColorSettings {
  basic: ColorBasic;
  lut: ColorLut | null;
}

export const DEFAULT_COLOR: ColorSettings = {
  basic: { brightness: 0, contrast: 1, saturation: 1, gamma: 1 },
  lut: null,
};

/**
 * Preset de cor (salvo no navegador). Guarda o look completo: correção básica +
 * referência/intensidade do LUT + o TEXTO do .cube (pra o preset ser
 * autossuficiente — reaplica e reenvia sem depender do arquivo original).
 */
export interface ColorPreset {
  name: string;
  color: ColorSettings;
  lutText?: string; // conteúdo do .cube, se o preset usa LUT
}

/** Looks prontos (só correção básica). */
export const BUILTIN_COLOR_PRESETS: ColorPreset[] = [
  { name: "Vívido", color: { basic: { brightness: 0, contrast: 1.15, saturation: 1.25, gamma: 1 }, lut: null } },
  { name: "Suave", color: { basic: { brightness: 0.03, contrast: 0.9, saturation: 0.9, gamma: 1 }, lut: null } },
  { name: "Alto contraste", color: { basic: { brightness: 0, contrast: 1.4, saturation: 1.05, gamma: 1 }, lut: null } },
  { name: "Clarear", color: { basic: { brightness: 0.1, contrast: 1, saturation: 1, gamma: 1.1 }, lut: null } },
  { name: "P&B", color: { basic: { brightness: 0, contrast: 1.05, saturation: 0, gamma: 1 }, lut: null } },
];

const LS_KEY = "fluxo-ouro:color-presets";

export function loadColorPresets(): ColorPreset[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]"); } catch { return []; }
}
export function saveColorPresets(presets: ColorPreset[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(presets));
}

/** True quando nada altera a imagem — permite bypass total (preview e pré-passe). */
export function isColorNeutral(c: ColorSettings | undefined | null): boolean {
  if (!c) return true;
  const { brightness, contrast, saturation, gamma } = c.basic;
  const basicNeutral = brightness === 0 && contrast === 1 && saturation === 1 && gamma === 1;
  const lutNeutral = !c.lut || !c.lut.file || c.lut.intensity <= 0;
  return basicNeutral && lutNeutral;
}
