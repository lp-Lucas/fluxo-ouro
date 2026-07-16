// Validação de paridade do módulo Chromakey.
// Compara, pixel a pixel: (ref) a matemática do shader do preview (replicada em JS)
// vs (exp) a saída do pré-passe ffmpeg (chromakey + clip + composição sobre o fundo).
// Cor mantida NEUTRA para isolar o keying (a paridade da cor já é medida à parte).
// Uso: npx tsx scripts/chroma-parity.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ChromaSettings } from "../../shared/chroma.js";

const OUT = path.resolve("out");
fs.mkdirSync(OUT, { recursive: true });
const W = 320, H = 240;
const SQRT2 = 1.41421356;

// ── Frame sintético: fundo verde + blocos de sujeito + gradiente atravessando a rampa ──
function makeFrame(): Buffer {
  const buf = Buffer.alloc(W * H * 3);
  const put = (x: number, y: number, r: number, g: number, b: number) => {
    const i = (y * W + x) * 3; buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
  };
  const subjects = [
    [230, 180, 150], // pele
    [200, 40, 40],   // vermelho
    [40, 60, 200],   // azul
    [120, 120, 120], // cinza
  ];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // fundo verde por padrão
      let r = 0, g = 255, b = 0;
      // faixa superior: gradiente de verde puro → cinza (varre a distância UV)
      if (y < 60) {
        const t = x / (W - 1);
        r = Math.round(0 + t * 120); g = Math.round(255 - t * 135); b = Math.round(0 + t * 120);
      } else {
        // 4 blocos de sujeito centrais
        const bw = W / 4;
        const bi = Math.floor(x / bw);
        if (y > 90 && y < 180 && bi >= 0 && bi < 4) {
          const s = subjects[bi];
          if (x % bw > 10 && x % bw < bw - 10) { r = s[0]; g = s[1]; b = s[2]; }
        }
      }
      put(x, y, r, g, b);
    }
  }
  return buf;
}

// rgb2uv BT.601 (idêntico ao shader e ao chromakey do ffmpeg), entradas 0..1.
function rgb2uv(r: number, g: number, b: number): [number, number] {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return [(b - y) / 1.772 + 0.5, (r - y) / 1.402 + 0.5];
}

// Replica EXATAMENTE o shader: keying → clip → despill → composição sobre o fundo.
function shaderComposite(src: Buffer, ch: ChromaSettings, bg: [number, number, number]): Buffer {
  const out = Buffer.alloc(src.length);
  const [uk, vk] = rgb2uv(ch.keyColor.r / 255, ch.keyColor.g / 255, ch.keyColor.b / 255);
  const bgClip = ch.bgClip ?? 0, fgClip = ch.fgClip ?? 1;
  const keyChan = ch.keyColor.g >= ch.keyColor.r && ch.keyColor.g >= ch.keyColor.b ? 1
    : ch.keyColor.b >= ch.keyColor.r ? 2 : 0;
  for (let i = 0; i < src.length; i += 3) {
    let r = src[i] / 255, g = src[i + 1] / 255, b = src[i + 2] / 255;
    const [u, v] = rgb2uv(r, g, b);
    const diff = Math.hypot(u - uk, v - vk) / SQRT2;
    let a = Math.min(1, Math.max(0, (diff - ch.similarity) / Math.max(ch.smoothness, 1e-4)));
    a = Math.min(1, Math.max(0, (a - bgClip) / Math.max(fgClip - bgClip, 1e-4)));
    if (ch.despill > 0) {
      if (keyChan === 1) { const m = (r + b) / 2; if (g > m) g = g + (m - g) * ch.despill; }
      else if (keyChan === 2) { const m = (r + g) / 2; if (b > m) b = b + (m - b) * ch.despill; }
      else { const m = (g + b) / 2; if (r > m) r = r + (m - r) * ch.despill; }
    }
    out[i] = Math.round((bg[0] * (1 - a) + r * a) * 255);
    out[i + 1] = Math.round((bg[1] * (1 - a) + g * a) * 255);
    out[i + 2] = Math.round((bg[2] * (1 - a) + b * a) * 255);
  }
  return out;
}

// Pré-passe ffmpeg: MESMO filtergraph do chromaPrePass (modo assado, fundo cor).
function ffmpegComposite(pngPath: string, ch: ChromaSettings, bgHex: string): Buffer {
  const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  const keyHex = `0x${hex2(ch.keyColor.r)}${hex2(ch.keyColor.g)}${hex2(ch.keyColor.b)}`;
  const sim = Math.min(1, ch.similarity).toFixed(4);
  const blend = Math.max(1e-4, ch.smoothness).toFixed(4);
  const bgClip = (ch.bgClip ?? 0).toFixed(4);
  const span = Math.max((ch.fgClip ?? 1) - (ch.bgClip ?? 0), 0.0001).toFixed(4);
  let keyed = `[0:v]format=rgba,chromakey=${keyHex}:${sim}:${blend},lut=a='clip((val/255-${bgClip})/${span},0,1)*255'`;
  if (ch.despill > 0) keyed += `,despill=type=green:mix=${ch.despill.toFixed(3)}:expand=0`;
  keyed += `[keyed]`;
  const fg = `color=c=${bgHex}:s=${W}x${H}[bg]`;
  const graph = `${keyed};${fg};[bg][keyed]overlay=format=auto,format=rgb24[out]`;
  return execFileSync("ffmpeg", ["-v", "error", "-i", pngPath,
    "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { cwd: OUT, maxBuffer: 200 * 1024 * 1024 });
}

// Marca pixels de "borda" (transição de alpha) p/ separar o erro inerente do keying.
function edgeMask(src: Buffer, ch: ChromaSettings): boolean[] {
  const [uk, vk] = rgb2uv(ch.keyColor.r / 255, ch.keyColor.g / 255, ch.keyColor.b / 255);
  const mask: boolean[] = [];
  for (let i = 0; i < src.length; i += 3) {
    const [u, v] = rgb2uv(src[i] / 255, src[i + 1] / 255, src[i + 2] / 255);
    const diff = Math.hypot(u - uk, v - vk) / SQRT2;
    let a = Math.min(1, Math.max(0, (diff - ch.similarity) / Math.max(ch.smoothness, 1e-4)));
    a = Math.min(1, Math.max(0, (a - (ch.bgClip ?? 0)) / Math.max((ch.fgClip ?? 1) - (ch.bgClip ?? 0), 1e-4)));
    mask.push(a > 0.02 && a < 0.98); // pixel em transição
  }
  return mask;
}

const chroma = (o: Partial<ChromaSettings>): ChromaSettings => ({
  enabled: true, keyColor: { r: 0, g: 255, b: 0 }, similarity: 0.3, smoothness: 0.1,
  despill: 0, background: null, fit: "cover", bgClip: 0, fgClip: 1, ...o,
});

function run() {
  const src = makeFrame();
  const pngPath = path.join(OUT, "chroma-parity-src.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
    "-s", `${W}x${H}`, "-i", "-", "-frames:v", "1", pngPath], { input: src });

  const bgHex = "0x101820", bg: [number, number, number] = [0x10 / 255, 0x18 / 255, 0x20 / 255];
  const casos: { nome: string; ch: ChromaSettings }[] = [
    { nome: "padrão (sim.3 sm.1)", ch: chroma({}) },
    { nome: "tolerância alta (.45)", ch: chroma({ similarity: 0.45 }) },
    { nome: "borda suave (sm .25)", ch: chroma({ smoothness: 0.25 }) },
    { nome: "clip sujeito (fg .5)", ch: chroma({ fgClip: 0.5 }) },
    { nome: "clip fundo (bg .3)", ch: chroma({ bgClip: 0.3 }) },
    { nome: "despill .6", ch: chroma({ despill: 0.6 }) },
  ];

  console.log(`frame sintético ${W}x${H}, fundo ${bgHex} (cor neutra p/ isolar o keying)`);
  console.log("caso".padEnd(22), "média".padStart(7), "máx".padStart(5), "  média(sem borda)", " veredito");
  for (const c of casos) {
    const ref = shaderComposite(src, c.ch, bg);
    const exp = ffmpegComposite(pngPath, c.ch, bgHex);
    const edges = edgeMask(src, c.ch);
    let soma = 0, max = 0, somaFlat = 0, nFlat = 0;
    const n = Math.min(ref.length, exp.length);
    for (let i = 0; i < n; i++) {
      const d = Math.abs(ref[i] - exp[i]); soma += d; if (d > max) max = d;
      if (!edges[Math.floor(i / 3)]) { somaFlat += d; nFlat++; }
    }
    const media = soma / n, mediaFlat = somaFlat / Math.max(nFlat, 1);
    // Regiões chatas (fundo/sujeito sólidos) devem casar quase exato; bordas divergem
    // (chromakey do ffmpeg ≠ shader GLSL) — erro inerente, como o 4:2:0 da cor.
    const ok = mediaFlat < 3 && media < 12;
    console.log(c.nome.padEnd(22), media.toFixed(2).padStart(7), String(max).padStart(5),
      "  ", mediaFlat.toFixed(2).padStart(6), "        ", ok ? "OK ✓" : "revisar ✗");
  }
}
run();
