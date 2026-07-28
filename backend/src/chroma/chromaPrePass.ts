import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { composeColorCubeText } from "../../../shared/colorLut.js";
import { parseCube } from "../../../shared/lut.js";
import { isColorNeutral } from "../../../shared/color.js";
import type { ColorSettings } from "../../../shared/color.js";
import type { ChromaSettings } from "../../../shared/chroma.js";

/** Mata a árvore de processos (Windows: taskkill /T; Unix: SIGKILL). */
function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
    else process.kill(pid, "SIGKILL");
  } catch { /* já morreu */ }
}

/** Roda o ffmpeg com cancelamento; rejeita com o stderr final se falhar. */
function runFfmpeg(args: string[], cwd: string, signal: AbortSignal | undefined, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { cwd });
    const onAbort = () => { killTree(proc.pid); reject(new Error(`${label} cancelado (timeout)`)); };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) { resolve(); return; }
      // Extrai a LINHA-CHAVE do erro (o .slice do tail costumava cortá-la no meio) + o tail.
      const key = stderr.split(/\r?\n/).reverse().find((l) =>
        /error|invalid|not divisible|out of range|no packets|incorrect parameters|failed|cannot|unable/i.test(l));
      const detalhe = [key?.trim(), stderr.slice(-800)].filter(Boolean).join(" ⟵ ");
      reject(new Error(`ffmpeg (${label}) saiu com código ${code}: ${detalhe}`));
    });
  });
}

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/**
 * Grava o .cube composto (correção básica + LUT do usuário) ao lado da saída.
 * Devolve o nome do arquivo (relativo, p/ evitar escapar ':' no Windows) ou null se cor neutra.
 */
function writeColorCube(color: ColorSettings, userLutPath: string | null, outputPath: string): string | null {
  if (isColorNeutral(color)) return null;
  let userLut = null;
  if (color.lut?.file) {
    if (!userLutPath || !fs.existsSync(userLutPath)) {
      throw new Error(`LUT .cube não encontrada no servidor (${color.lut.file}). Reenvie a LUT.`);
    }
    userLut = parseCube(fs.readFileSync(userLutPath, "utf8"));
  }
  const cubePath = outputPath + ".cube";
  fs.writeFileSync(cubePath, composeColorCubeText(color, userLut, 65));
  return cubePath;
}

/** Cadeia GLSL→ffmpeg do keying: chromakey (limiares × √2) + clip do alpha (lut). */
function keyingChain(ch: ChromaSettings): string {
  const k = ch.keyColor;
  const keyHex = `0x${hex2(k.r)}${hex2(k.g)}${hex2(k.b)}`;
  // O chromakey do ffmpeg já normaliza a distância UV por 255·√2, igual ao shader
  // (que divide por √2 em UV 0..1) → limiares vão COMO ESTÃO (validado por chroma-parity).
  // RAMPA CENTRADA (igual ao shader): a borda fica CENTRADA em similarity, com largura
  // smoothness. lo = similarity - smoothness/2 (clamp 0..1); ffmpeg ramp = [lo, lo+blend].
  const blend = Math.max(1e-4, ch.smoothness);
  // PISO 0.01: o chromakey do ffmpeg exige similarity ∈ [0.01, 1]. Abaixo disso ele retorna
  // AVERROR(ERANGE) = "Numerical result out of range" e o render QUEBRA. A rampa centrada
  // (similarity − smoothness/2) zera com tolerância baixa → travava a exportação. O shader
  // usa o MESMO piso (paridade). 0.01 é imperceptível (~3 níveis de 8-bit só na borda extrema).
  const sim = Math.max(0.01, Math.min(1, ch.similarity - ch.smoothness * 0.5));
  const bgClip = (ch.bgClip ?? 0).toFixed(4);
  const span = Math.max((ch.fgClip ?? 1) - (ch.bgClip ?? 0), 0.0001).toFixed(4);
  // clip: remapeia o alpha [bgClip..fgClip] → [0..1] (mesma matemática do shader).
  // Dentro de aspas simples do filtergraph as vírgulas são literais (sem escape).
  let chain = `format=rgba,chromakey=${keyHex}:${sim.toFixed(4)}:${blend.toFixed(4)}`;
  chain += `,lut=a='clip((val/255-${bgClip})/${span},0,1)*255'`;
  if (ch.despill > 0) {
    const keyChan = k.g >= k.r && k.g >= k.b ? "green" : k.b >= k.r ? "blue" : "red";
    chain += `,despill=type=${keyChan}:mix=${ch.despill.toFixed(3)}:expand=0`;
  }
  return chain;
}

/** scale+crop (cover) ou scale+pad (contain) p/ preencher WxH. */
function scaleFit(W: number, H: number, cover: boolean): string {
  return cover
    ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
    : `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`;
}

/** scale+crop (cover/contain) e depois o TRANSFORM do usuário (zoom + deslocamento). Igual ao
 * shader: zoom ao redor do centro, off em fração do frame. Só entra quando não-neutro.
 * Usa pad (zoom-out) / crop (zoom-in) — SEM `color=s=WxH` (aquele token quebrava o ffmpeg). */
function bgFit(ch: ChromaSettings, W: number, H: number): string {
  const cover = (ch.fit ?? "cover") === "cover";
  const base = `[1:v]${scaleFit(W, H, cover)},setsar=1`;
  const s = ch.bgScale && ch.bgScale > 0 ? ch.bgScale : 1;
  const x = ch.bgX ?? 0, y = ch.bgY ?? 0;
  if (s === 1 && x === 0 && y === 0) return `${base}[bg]`;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const bw = Math.max(2, Math.round(W * s)), bh = Math.max(2, Math.round(H * s));
  if (bw <= W && bh <= H) {
    // fundo MENOR que o frame → posiciona num canvas preto via pad (bordas pretas).
    const px = clamp(Math.round((W - bw) / 2 + x * W), 0, W - bw);
    const py = clamp(Math.round((H - bh) / 2 + y * H), 0, H - bh);
    return `${base},scale=${bw}:${bh},pad=${W}:${H}:${px}:${py}:color=black[bg]`;
  }
  // fundo MAIOR que o frame (zoom-in) → recorta a janela W×H, centrada + deslocada.
  const cx = clamp(Math.round((bw - W) / 2 - x * W), 0, bw - W);
  const cy = clamp(Math.round((bh - H) / 2 - y * H), 0, bh - H);
  return `${base},scale=${bw}:${bh},crop=${W}:${H}:${cx}:${cy}[bg]`;
}

/** Entradas extras (fundo imagem/vídeo) + label do fundo p/ o filtergraph. */
function bgInputs(ch: ChromaSettings, bgPath: string | null, W: number, H: number): { inputs: string[]; graph: string } {
  const bg = ch.background;
  if (bg?.type === "video" && bgPath) {
    return { inputs: ["-stream_loop", bg.loop ? "-1" : "0", "-i", bgPath], graph: bgFit(ch, W, H) };
  }
  if (bg?.type === "image" && bgPath) {
    return { inputs: ["-loop", "1", "-i", bgPath], graph: bgFit(ch, W, H) };
  }
  const col = bg?.type === "color" ? bg.value.replace("#", "0x") : "0x000000";
  return { inputs: [], graph: `color=c=${col}:s=${W}x${H}[bg]` };
}

const OUT_H264 = [
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
  // MESMAS tags do colorPrePass/matting (BT.709 tv) → decode idêntico no Chromium.
  "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
  "-movflags", "+faststart",
];

export interface ChromaPassInput {
  inputPath: string;
  chroma: ChromaSettings;
  color: ColorSettings;
  userLutPath: string | null;
  bgPath: string | null;
  outputPath: string;
  width: number;
  height: number;
  durationSec?: number; // limita o fundo infinito (cor/imagem/loop) ao tamanho do vídeo
  fps?: number;         // framerate de SAÍDA (CFR). Normaliza entradas VFR (celular) — sem isto o
                        // x264 podia falhar ao abrir ("incorrect parameters such as rate"). Default 30.
  signal?: AbortSignal;
}

/** Dimensão par e ≥ 2 (yuv420p/H.264 exigem par; ímpar quebra o filtergraph e o encoder). */
const par = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * MODO ASSADO (1 passe, caminho comum): keying→despill→composição sobre o fundo→cor.
 * Produz um MP4 OPACO (plano de vídeo já composto e colorido). O Remotion sobrepõe
 * popups/legendas SEM cor — igual ao preview.
 */
export async function chromaPrePass(input: ChromaPassInput): Promise<string> {
  if (fs.existsSync(input.outputPath)) return input.outputPath;
  const { chroma: ch } = input;
  const W = par(input.width), H = par(input.height);
  const fps = input.fps && input.fps > 0 ? input.fps : 30;

  const parts: string[] = [`[0:v]scale=${W}:${H},format=yuv420p,setsar=1[src]`];
  parts.push(`[src]${keyingChain(ch)}[keyed]`);
  const { inputs, graph } = bgInputs(ch, input.bgPath, W, H);
  parts.push(graph);
  parts.push(`[bg][keyed]overlay=shortest=1:format=auto,format=yuv420p[comp]`);

  let last = "[comp]";
  const cube = writeColorCube(input.color, input.userLutPath, input.outputPath);
  if (cube) { parts.push(`[comp]lut3d=file='${path.basename(cube)}':interp=trilinear[out]`); last = "[out]"; }

  await runFfmpeg([
    "-y", "-i", input.inputPath, ...inputs,
    "-filter_complex", parts.join(";"),
    "-map", last, "-map", "0:a?",
    ...OUT_H264, "-r", String(fps), "-c:a", "aac", "-b:a", "192k", "-shortest", input.outputPath,
  ], path.dirname(input.outputPath), input.signal, "chroma");

  if (cube) fs.rm(cube, () => {});
  return input.outputPath;
}

/**
 * MODO PESSOA (camadas): keying→despill→cor → WebM VP9 com ALPHA (yuva420p).
 * A pessoa recortada e colorida fica TRANSPARENTE p/ o Remotion empilhar por cima
 * de um popup "atrás da pessoa".
 */
export async function chromaPersonPass(input: ChromaPassInput): Promise<string> {
  if (fs.existsSync(input.outputPath)) return input.outputPath;
  const { chroma: ch } = input;
  const W = par(input.width), H = par(input.height);
  const fps = input.fps && input.fps > 0 ? input.fps : 30;

  const parts: string[] = [`[0:v]scale=${W}:${H},format=yuv420p,setsar=1[src]`];
  let chain = `[src]${keyingChain(ch)}`;
  const cube = writeColorCube(input.color, input.userLutPath, input.outputPath);
  if (cube) chain += `,lut3d=file='${path.basename(cube)}':interp=trilinear`; // cor preserva o alpha
  chain += `,format=yuva420p[out]`;
  parts.push(chain);

  await runFfmpeg([
    "-y", "-i", input.inputPath,
    "-filter_complex", parts.join(";"),
    "-map", "[out]",
    // WebM VP9 com alpha. -auto-alt-ref 0 é obrigatório p/ preservar o alpha.
    "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-b:v", "0", "-crf", "20",
    "-r", String(fps),
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-an", input.outputPath,
  ], path.dirname(input.outputPath), input.signal, "chroma-pessoa");

  if (cube) fs.rm(cube, () => {});
  return input.outputPath;
}

/**
 * MODO FUNDO (camadas): fundo (cor/imagem/vídeo) → cor → MP4 OPACO, com o áudio do
 * vídeo original (a base temporal do Remotion). Usado como o "plano de vídeo" que
 * recebe cortes/zoom; a pessoa transparente entra por cima.
 */
export async function chromaBackgroundPass(input: ChromaPassInput): Promise<string> {
  if (fs.existsSync(input.outputPath)) return input.outputPath;
  const { chroma: ch } = input;
  const W = par(input.width), H = par(input.height);
  const fps = input.fps && input.fps > 0 ? input.fps : 30;

  const { inputs, graph } = bgInputs(ch, input.bgPath, W, H);
  const parts: string[] = [graph];
  let last = "[bg]";
  const cube = writeColorCube(input.color, input.userLutPath, input.outputPath);
  if (cube) { parts.push(`[bg]lut3d=file='${path.basename(cube)}':interp=trilinear[out]`); last = "[out]"; }

  // o áudio vem do vídeo original (input 0); o fundo é a imagem/cor/vídeo. Como o
  // fundo pode ser infinito (cor/imagem/loop), limita a duração ao tamanho do vídeo
  // (-shortest não basta se o vídeo não tiver faixa de áudio).
  const durArg = input.durationSec && input.durationSec > 0 ? ["-t", input.durationSec.toFixed(3)] : [];
  await runFfmpeg([
    "-y", "-i", input.inputPath, ...inputs,
    "-filter_complex", parts.join(";"),
    "-map", last, "-map", "0:a?",
    ...durArg,
    ...OUT_H264, "-r", String(fps), "-c:a", "aac", "-b:a", "192k", "-shortest", input.outputPath,
  ], path.dirname(input.outputPath), input.signal, "chroma-fundo");

  if (cube) fs.rm(cube, () => {});
  return input.outputPath;
}
