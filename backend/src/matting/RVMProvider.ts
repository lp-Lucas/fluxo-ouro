import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { MattingProvider, MattingRequest } from "./MattingProvider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RVM_SCRIPT = path.resolve(__dirname, "../../matting/rvm_matte.py");

/** Mata a árvore de processos (Windows: taskkill /T; Unix: SIGKILL no grupo). */
function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
    else process.kill(pid, "SIGKILL");
  } catch {
    /* processo já pode ter morrido */
  }
}

/**
 * Provider padrão de matting (export): RobustVideoMatting (RVM).
 * - Melhor coerência temporal pra vídeo, bom em cabelo/borda, leve.
 * - Roda no backend Python (mesmo ambiente do faster-whisper), GPU quando disponível.
 *
 * Pipeline SEM PNGs: o script Python roda o RVM sobre o TRECHO recortado e
 * escreve frames RGBA crus no stdin do ffmpeg, que grava direto um WebM VP9 alpha.
 *
 * Comando ffmpeg (ver item 3) roda DENTRO do rvm_matte.py, recebendo rawvideo rgba
 * pelo pipe. Aqui só orquestramos e cacheamos por outputPath.
 */
export class RVMProvider implements MattingProvider {
  readonly name = "rvm";

  async generateAlphaVideo(req: MattingRequest, signal?: AbortSignal): Promise<string> {
    // Cache: se o WebM alpha já existe (mesmo popup/trecho), não reprocessa.
    if (fs.existsSync(req.outputPath)) return req.outputPath;
    fs.mkdirSync(path.dirname(req.outputPath), { recursive: true });

    const python = process.env.PYTHON ?? "python";
    const device = process.env.MATTING_DEVICE ?? "cuda"; // GPU por padrão; "cpu" = fallback lento

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(python, [
        RVM_SCRIPT,
        "--input", req.videoPath,
        "--start-frame", String(req.startFrame),
        "--end-frame", String(req.endFrame),
        "--fps", String(req.fps),
        "--width", String(req.width),
        "--height", String(req.height),
        "--output", req.outputPath,
        "--device", device,
      ]);

      // Cancelamento (timeout): mata a árvore inteira (python + ffmpeg filhos).
      const onAbort = () => { killTree(proc.pid); reject(new Error("matting cancelado (timeout)")); };
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      let stderr = "";
      proc.stderr.on("data", (d) => (stderr += d));
      proc.on("error", reject);
      proc.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        code === 0 ? resolve() : reject(new Error(`rvm_matte.py saiu com código ${code}: ${stderr}`));
      });
    });

    return req.outputPath;
  }
}

/** Seleção do provider de matting (trocável). RVM é o padrão. */
export function getMattingProvider(_model: string = "rvm"): MattingProvider {
  // TODO: adicionar BiRefNetProvider / SAM2Provider aqui quando existir.
  return new RVMProvider();
}
