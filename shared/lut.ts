/**
 * Parser de LUT .cube (Adobe Cube LUT) — lógica pura, reusável (preview + export).
 *
 * Suporta: LUT_3D_SIZE, DOMAIN_MIN/DOMAIN_MAX, comentários com '#', linhas em
 * branco, e os tamanhos comuns (17/33/65). Erros legíveis em PT-BR.
 *
 * `data` é um Float32Array com size³ * 3 valores (RGB, 0..1), na ordem padrão do
 * .cube: o R varia mais rápido, depois G, depois B (índice = (b*size + g)*size + r).
 */

export interface ParsedLut {
  size: number;
  data: Float32Array; // size^3 * 3, RGB 0..1
  domainMin: [number, number, number];
  domainMax: [number, number, number];
}

export function parseCube(text: string): ParsedLut {
  let size = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    if (line.startsWith("LUT_3D_SIZE")) {
      size = parseInt(line.split(/\s+/)[1], 10);
      continue;
    }
    if (line.startsWith("LUT_1D_SIZE")) {
      throw new Error("LUT 1D não é suportada — use uma LUT 3D (.cube com LUT_3D_SIZE).");
    }
    if (line.startsWith("DOMAIN_MIN")) {
      const p = line.split(/\s+/).slice(1).map(Number);
      domainMin = [p[0], p[1], p[2]];
      continue;
    }
    if (line.startsWith("DOMAIN_MAX")) {
      const p = line.split(/\s+/).slice(1).map(Number);
      domainMax = [p[0], p[1], p[2]];
      continue;
    }
    if (line.startsWith("TITLE")) continue;

    // linha de dados: 3 floats
    const nums = line.split(/\s+/).map(Number);
    if (nums.length === 3 && nums.every((n) => Number.isFinite(n))) {
      values.push(nums[0], nums[1], nums[2]);
    }
  }

  if (!size || size < 2) {
    throw new Error("Arquivo .cube inválido: LUT_3D_SIZE ausente ou inválido.");
  }
  const esperado = size * size * size * 3;
  if (values.length !== esperado) {
    throw new Error(
      `Arquivo .cube inconsistente: esperava ${esperado / 3} linhas de cor para tamanho ${size}, ` +
      `mas encontrei ${values.length / 3}. Arquivo pode estar truncado ou corrompido.`,
    );
  }

  return { size, data: new Float32Array(values), domainMin, domainMax };
}
