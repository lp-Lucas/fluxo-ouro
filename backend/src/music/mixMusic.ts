import fs from "node:fs";
import { runFfmpeg } from "../flow/ffmpeg.js";

/**
 * Mixa uma MÚSICA DE FUNDO no vídeo final (pós-render): usa o TRECHO escolhido
 * [start, end] da música, em loop, no volume escolhido, SOB o áudio original (fala),
 * cortado no tamanho do vídeo. Não re-encoda o vídeo (`-c:v copy`). `normalize=0`
 * mantém a fala em volume cheio (a música é que fica baixa).
 */
export async function mixBackgroundMusic(
  videoPath: string, musicPath: string,
  opts: { volume: number; start?: number; end?: number },
  outPath: string, signal?: AbortSignal,
): Promise<void> {
  const v = Math.max(0, Math.min(1, opts.volume)).toFixed(3);
  const start = Math.max(0, opts.start ?? 0);
  const hasEnd = typeof opts.end === "number" && opts.end > start;

  // Se há trecho definido, recorta primeiro (robusto p/ depois dar loop).
  let src = musicPath;
  let tmp: string | null = null;
  if (start > 0 || hasEnd) {
    tmp = outPath + ".seg.m4a";
    const args = ["-y"];
    if (start > 0) args.push("-ss", start.toFixed(3));
    if (hasEnd) args.push("-t", (opts.end! - start).toFixed(3));
    args.push("-i", musicPath, "-vn", "-c:a", "aac", "-b:a", "192k", tmp);
    await runFfmpeg(args, signal, "music-trim");
    src = tmp;
  }

  await runFfmpeg([
    "-y",
    "-i", videoPath,
    "-stream_loop", "-1", "-i", src, // trecho em loop (cobre todo o vídeo)
    "-filter_complex", `[1:a]volume=${v}[m];[0:a][m]amix=inputs=2:duration=first:normalize=0[a]`,
    "-map", "0:v", "-map", "[a]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-shortest",
    outPath,
  ], signal, "music-mix");

  if (tmp) fs.rm(tmp, () => {});
}
