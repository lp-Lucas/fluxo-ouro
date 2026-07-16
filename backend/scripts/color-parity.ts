// Validação de paridade do módulo Color.
// Compara, pixel a pixel: (ref) a matemática analítica do shader do preview
// (transformPixel) vs (exp) a saída do pré-passe ffmpeg (LUT 65³ composta).
// Uso: npx tsx scripts/color-parity.ts <video>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { transformPixel, composeColorCubeText } from "../../shared/colorLut.js";
import { parseCube } from "../../shared/lut.js";
import type { ParsedLut } from "../../shared/lut.js";
import type { ColorSettings } from "../../shared/color.js";

const VIDEO = process.argv[2];
const OUT = path.resolve("out");
const TS = 1.0; // segundo do frame comparado

function probeSize(): { w: number; h: number } {
  const s = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", VIDEO]).toString().trim();
  const [w, h] = s.split("x").map(Number);
  return { w, h };
}

function frameRGB(file: string, w: number, h: number): Buffer {
  return execFileSync("ffmpeg", ["-v", "error", "-ss", String(TS), "-i", file,
    "-frames:v", "1", "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { maxBuffer: 200 * 1024 * 1024 });
}

/** Escreve um .cube de teste (look "warm": +R, -B). */
function writeWarmCube(p: string, size = 17) {
  const den = size - 1;
  const lines = [`LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const R = Math.min(1, (r / den) * 1.2 + 0.05);
        const G = g / den;
        const B = Math.max(0, (b / den) * 0.8);
        lines.push(`${R.toFixed(6)} ${G.toFixed(6)} ${B.toFixed(6)}`);
      }
  fs.writeFileSync(p, lines.join("\n"));
}

async function run() {
  const { w, h } = probeSize();
  const src = frameRGB(VIDEO, w, h); // frame fonte (sem cor)

  const warmPath = path.join(OUT, "test-warm.cube");
  writeWarmCube(warmPath);
  const warmLut = parseCube(fs.readFileSync(warmPath, "utf8"));

  const base = (o: Partial<ColorSettings["basic"]>): ColorSettings =>
    ({ basic: { brightness: 0, contrast: 1, saturation: 1, gamma: 1, ...o }, lut: null });

  const casos: { nome: string; color: ColorSettings; lut: ParsedLut | null; lutPath: string | null }[] = [
    { nome: "só brilho (+0.2)", color: base({ brightness: 0.2 }), lut: null, lutPath: null },
    { nome: "só contraste (1.4)", color: base({ contrast: 1.4 }), lut: null, lutPath: null },
    { nome: "só saturação (0.3)", color: base({ saturation: 0.3 }), lut: null, lutPath: null },
    { nome: "só gamma (1.6)", color: base({ gamma: 1.6 }), lut: null, lutPath: null },
    { nome: "combinação", color: base({ brightness: 0.1, contrast: 1.2, saturation: 1.3, gamma: 0.9 }), lut: null, lutPath: null },
    { nome: "só LUT (warm)", color: { basic: base({}).basic, lut: { file: "warm", intensity: 1 } }, lut: warmLut, lutPath: warmPath },
    { nome: "LUT intensidade 50%", color: { basic: base({}).basic, lut: { file: "warm", intensity: 0.5 } }, lut: warmLut, lutPath: warmPath },
    { nome: "tudo junto", color: { basic: { brightness: 0.05, contrast: 1.15, saturation: 1.1, gamma: 0.95 }, lut: { file: "warm", intensity: 0.7 } }, lut: warmLut, lutPath: warmPath },
  ];

  console.log(`frame ${w}x${h} @ ${TS}s`);
  console.log("caso".padEnd(24), "média/255", "máx/255", "veredito");
  for (const c of casos) {
    // referência analítica (= shader)
    const ref = Buffer.alloc(src.length);
    for (let i = 0; i < src.length; i += 3) {
      const [r, g, b] = transformPixel(c.color, c.lut, src[i] / 255, src[i + 1] / 255, src[i + 2] / 255);
      ref[i] = Math.round(r * 255); ref[i + 1] = Math.round(g * 255); ref[i + 2] = Math.round(b * 255);
    }
    // export — mede a MATEMÁTICA do lut3d direto em RGB (sem re-encode 4:2:0),
    // isolando a paridade das fórmulas. (O 4:2:0 do h264 final adiciona erro
    // localizado de croma, inerente ao formato — medido à parte.)
    const cubePath = path.join(OUT, `parity-${casos.indexOf(c)}.cube`);
    fs.writeFileSync(cubePath, composeColorCubeText(c.color, c.lut, 65));
    const exp = execFileSync("ffmpeg", ["-v", "error", "-ss", String(TS), "-i", VIDEO,
      "-vf", `lut3d=file=${path.basename(cubePath)}:interp=trilinear,scale=${w}:${h}`,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { cwd: OUT, maxBuffer: 200 * 1024 * 1024 });

    // diff
    let soma = 0, max = 0;
    const n = Math.min(ref.length, exp.length);
    for (let i = 0; i < n; i++) { const d = Math.abs(ref[i] - exp[i]); soma += d; if (d > max) max = d; }
    const media = soma / n;
    const ok = media < 2 && max < 8;
    console.log(c.nome.padEnd(24), media.toFixed(2).padStart(8), String(max).padStart(6), "  ", ok ? "OK ✓" : "FALHOU ✗");
  }
}
run().catch((e) => { console.error(e); process.exit(1); });
