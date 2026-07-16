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
      code === 0 ? resolve() : reject(new Error(`ffmpeg (${label}) saiu com código ${code}: ${stderr.slice(-600)}`));
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
  const sim = Math.min(1, ch.similarity);
  const blend = Math.max(1e-4, ch.smoothness);
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

/** Entradas extras (fundo imagem/vídeo) + label do fundo p/ o filtergraph. */
function bgInputs(ch: ChromaSettings, bgPath: string | null, W: number, H: number): { inputs: string[]; graph: string } {
  const cover = (ch.fit ?? "cover") === "cover";
  const bg = ch.background;
  if (bg?.type === "video" && bgPath) {
    return { inputs: ["-stream_loop", bg.loop ? "-1" : "0", "-i", bgPath], graph: `[1:v]${scaleFit(W, H, cover)},setsar=1[bg]` };
  }
  if (bg?.type === "image" && bgPath) {
    return { inputs: ["-loop", "1", "-i", bgPath], graph: `[1:v]${scaleFit(W, H, cover)},setsar=1[bg]` };
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
  signal?: AbortSignal;
}

/**
 * MODO ASSADO (1 passe, caminho comum): keying→despill→composição sobre o fundo→cor.
 * Produz um MP4 OPACO (plano de vídeo já composto e colorido). O Remotion sobrepõe
 * popups/legendas SEM cor — igual ao preview.
 */
export async function chromaPrePass(input: ChromaPassInput): Promise<string> {
  if (fs.existsSync(input.outputPath)) return input.outputPath;
  const { chroma: ch, width: W, height: H } = input;

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
    ...OUT_H264, "-c:a", "aac", "-b:a", "192k", "-shortest", input.outputPath,
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
  const { chroma: ch, width: W, height: H } = input;

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
  const { chroma: ch, width: W, height: H } = input;

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
    ...OUT_H264, "-c:a", "aac", "-b:a", "192k", "-shortest", input.outputPath,
  ], path.dirname(input.outputPath), input.signal, "chroma-fundo");

  if (cube) fs.rm(cube, () => {});
  return input.outputPath;
}
