/**
 * Módulo Chromakey — remover fundo verde/azul e substituir por cor/imagem/vídeo.
 *
 * REQUISITO DE PARIDADE preview↔export: mesmo algoritmo, mesma ordem, dos dois lados.
 *
 * ── Fórmula do `chromakey` do ffmpeg (a replicar no shader GLSL) ──
 * Opera em YUV. Converte a cor-chave para (Ukey, Vkey). Para cada pixel, no plano
 * de croma:
 *     du = U - Ukey ; dv = V - Vkey ; d = sqrt(du² + dv²)   // distância no plano UV
 *     se d < similarity            → alpha = 0            (transparente = fundo)
 *     se d < similarity + blend    → alpha = (d - similarity) / blend   (borda suave)
 *     senão                        → alpha = 1            (opaco = pessoa)
 *   (aqui `blend` = smoothness). O ffmpeg normaliza a distância por 255·√2 e usa
 *   BT.601 (coef. fixos 0.299/0.587/0.114) para o croma. O shader faz IDÊNTICO:
 *   RGB→UV em BT.601, distância em UV 0..1 dividida por √2, limiares sem escala.
 *   (Validado por backend/scripts/chroma-parity.ts: erro em área chata < 1/255.)
 *
 * ── Despill (remover contaminação verde na borda/pele) ──
 * ffmpeg `despill`: reduz o canal da cor-chave quando ele excede a média dos outros
 * dois canais. O shader replica a MESMA fórmula. Se paridade exata for inviável na
 * v1, o despill fica IGUAL nos dois lados ou fora dos dois — nunca só em um.
 *
 * ── ORDEM FIXA (decisão, documentada) ──
 *     keying (alpha) → despill → composição sobre o fundo → correção de cor/LUT
 * A correção de COR entra POR ÚLTIMO (sobre o resultado composto). Assim a cor não
 * altera a qualidade da chave — o keying vê sempre o vídeo bruto, igual nos dois lados.
 *
 * ── Interação com behindSubject (RVM) ──
 * Com chromakey ATIVO, o vídeo keyado JÁ É a "pessoa recortada". Então um popup
 * behindSubject entra ENTRE o fundo e o vídeo keyado — dispensa o RVM nesse caso.
 *
 * Fora do escopo v1 (schema extensível): garbage matte, keying por trecho,
 * edge blur avançado, light wrap.
 */

export interface RGB255 { r: number; g: number; b: number; }

export type ChromaBackground =
  | { type: "color"; value: string }                 // cor sólida (hex)
  | { type: "image"; file: string }                  // asset do projeto
  | { type: "video"; file: string; loop: boolean }   // asset do projeto (loop se mais curto)
  | null;                                             // null = transparente sobre preto

export interface ChromaSettings {
  enabled: boolean;
  keyColor: RGB255;    // 0..255 (verde ~#00FF00, azul ~#0000FF)
  similarity: number;  // 0..1 (tolerância) → ffmpeg similarity
  smoothness: number;  // 0..1 (suavidade da borda) → ffmpeg blend
  despill: number;     // 0..1
  /**
   * Clip do alpha APÓS a rampa (remapeia [bgClip..fgClip] → [0..1]).
   * Resolve o "sujeito semitransparente": alphas ≥ fgClip viram 1 (sujeito sólido)
   * e alphas ≤ bgClip viram 0 (limpa restos de fundo). Sem clip: bgClip 0, fgClip 1.
   * No export: replicado com uma curva no plano alpha (mesma matemática).
   */
  bgClip?: number;     // 0..1 (default 0)  — mais alto = tira mais restos de fundo
  fgClip?: number;     // 0..1 (default 1)  — mais baixo = sujeito mais sólido
  background: ChromaBackground;
  fit?: "cover" | "contain"; // ajuste do fundo (default cover)
}

export const DEFAULT_CHROMA: ChromaSettings = {
  enabled: false,
  keyColor: { r: 0, g: 255, b: 0 }, // verde padrão
  similarity: 0.3,
  smoothness: 0.1,
  despill: 0,
  bgClip: 0,
  fgClip: 1,
  background: null,
  fit: "cover",
};

/** True quando o chroma deve ser aplicado (liga/desliga global na v1). */
export function isChromaActive(c: ChromaSettings | undefined | null): boolean {
  return !!c && c.enabled;
}
