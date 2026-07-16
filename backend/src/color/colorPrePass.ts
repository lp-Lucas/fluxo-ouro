import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { composeColorCubeText } from "../../../shared/colorLut.js";
import { parseCube } from "../../../shared/lut.js";
import type { ColorSettings } from "../../../shared/color.js";

/** Mata a árvore de processos (Windows: taskkill /T; Unix: SIGKILL). */
function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
    else process.kill(pid, "SIGKILL");
  } catch { /* já morreu */ }
}

export interface ColorPrePassInput {
  inputPath: string;         // vídeo fonte (local)
  color: ColorSettings;
  userLutPath: string | null; // caminho do .cube do usuário (se houver)
  outputPath: string;        // mp4 corrigido de saída (em uploads, servido)
  width: number;             // resolução de saída (capada em Full HD) — leve p/ o Remotion
  height: number;
  signal?: AbortSignal;      // cancelamento (timeout)
}

/**
 * Pré-passe de cor via ffmpeg: aplica a LUT composta (correção básica + LUT do
 * usuário + intensidade) no vídeo inteiro, ANTES do Remotion.
 * Ordem no pipeline: cor (vídeo todo) → depois cortes/zoom/popups no Remotion.
 * Cacheado por outputPath (nome inclui hash dos settings).
 */
export async function colorPrePass(input: ColorPrePassInput): Promise<string> {
  if (fs.existsSync(input.outputPath)) return input.outputPath; // cache

  // 1) LUT do usuário (se referenciada) — valida existência com erro legível.
  let userLut = null;
  if (input.color.lut?.file) {
    if (!input.userLutPath || !fs.existsSync(input.userLutPath)) {
      throw new Error(`LUT .cube não encontrada no servidor (${input.color.lut.file}). Reenvie a LUT.`);
    }
    userLut = parseCube(fs.readFileSync(input.userLutPath, "utf8"));
  }

  // 2) Compõe o .cube único e grava ao lado da saída.
  const cubePath = input.outputPath + ".cube";
  fs.writeFileSync(cubePath, composeColorCubeText(input.color, userLut, 65));
  const cubeDir = path.dirname(cubePath);
  const cubeName = path.basename(cubePath); // usado relativo (evita escapar ':' de path no Windows)

  // 3) ffmpeg: lut3d trilinear no vídeo todo (mantém áudio).
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-y", "-i", input.inputPath,
      // escala p/ Full HD (mesmo cap do export) ANTES do lut3d → leve p/ o Remotion buscar/decodar.
      // força BT.709 range limitado (tv) — MESMAS tags do alpha (matting), pra o
      // Chromium decodar fundo e recorte IDÊNTICOS (senão há pop de tonalidade).
      "-vf", `scale=${input.width}:${input.height},format=yuv420p,lut3d=file=${cubeName}:interp=trilinear`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
      "-movflags", "+faststart", // moov no início → seek rápido no Remotion
      "-c:a", "copy",
      input.outputPath,
    ], { cwd: cubeDir });

    const onAbort = () => { killTree(proc.pid); reject(new Error("pré-passe de cor cancelado (timeout)")); };
    if (input.signal) {
      if (input.signal.aborted) { onAbort(); return; }
      input.signal.addEventListener("abort", onAbort, { once: true });
    }
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      input.signal?.removeEventListener("abort", onAbort);
      code === 0 ? resolve() : reject(new Error(`ffmpeg (cor) saiu com código ${code}: ${stderr.slice(-500)}`));
    });
  });

  fs.rm(cubePath, () => {}); // limpa o .cube temporário
  return input.outputPath;
}
