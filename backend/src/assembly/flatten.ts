import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runFfmpeg, probeDuration } from "../flow/ffmpeg.js";

const execFileP = promisify(execFile);

/**
 * ACHATAMENTO da montagem (Montador de origem) num MP4 único w×h.
 *
 *  - PISTA PRINCIPAL (`main`): cada clipe é aparado [in,out], normalizado (scale contido +
 *    pad pra w×h, setsar=1, fps=30) e CONCATENADO em sequência (vídeo + áudio). Clipe SEM
 *    áudio recebe silêncio (anullsrc) pra não quebrar o `concat` (que exige N faixas de áudio).
 *  - B-ROLLS (`brolls`): cada um é aparado, escalado pra COBRIR a tela (increase+crop) e
 *    SOBREPOSTO no intervalo [timelineStart, +dur] via `overlay`+`enable`. Mudo — o áudio final
 *    é o da principal (v1). O `setpts=...+start/TB` desloca o clipe pro tempo certo da timeline.
 *
 * Devolve a duração final medida (s). Não conhece projeto/asset — recebe caminhos já resolvidos.
 */

export interface FlatMainClip { path: string; in: number; out: number; }
export interface FlatBrollClip { path: string; in: number; out: number; timelineStart: number; }

/** true se o arquivo tem pelo menos uma faixa de áudio. */
async function hasAudio(p: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", p,
    ]);
    return stdout.trim().length > 0;
  } catch { return false; }
}

export async function flattenAssembly(
  main: FlatMainClip[], brolls: FlatBrollClip[], w: number, h: number, outPath: string, signal?: AbortSignal,
): Promise<{ durationSec: number }> {
  if (main.length === 0) throw new Error("A pista principal precisa de pelo menos um clipe.");

  const inputs: string[] = [];   // args -i (ordem = índice do input no filtergraph)
  const filters: string[] = [];
  const mainHasAudio = await Promise.all(main.map((c) => hasAudio(c.path)));

  // PRINCIPAL: normaliza cada clipe (v + a) na mesma grade (w×h, sar 1, 30fps, 48k stereo).
  let totalMain = 0;
  main.forEach((c, i) => {
    inputs.push("-i", c.path);
    const dur = Math.max(0.05, c.out - c.in);
    totalMain += dur;
    filters.push(
      `[${i}:v]trim=start=${c.in}:end=${c.out},setpts=PTS-STARTPTS,` +
      `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[mv${i}]`,
    );
    if (mainHasAudio[i]) {
      filters.push(`[${i}:a]atrim=start=${c.in}:end=${c.out},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[ma${i}]`);
    } else {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${dur.toFixed(3)},asetpts=PTS-STARTPTS[ma${i}]`);
    }
  });
  const concatInputs = main.map((_, i) => `[mv${i}][ma${i}]`).join("");
  filters.push(`${concatInputs}concat=n=${main.length}:v=1:a=1[cv][ca]`);

  // B-ROLLS: overlay no tempo certo, cobrindo a tela, mudo.
  let curV = "[cv]";
  brolls.forEach((b, j) => {
    const idx = main.length + j;
    inputs.push("-i", b.path);
    const dur = Math.max(0.05, b.out - b.in);
    const start = Math.max(0, Math.min(b.timelineStart, totalMain));
    const end = Math.min(start + dur, totalMain);
    filters.push(
      `[${idx}:v]trim=start=${b.in}:end=${b.out},setpts=PTS-STARTPTS+${start}/TB,` +
      `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=30[bv${j}]`,
    );
    const nextV = `[ov${j}]`;
    filters.push(`${curV}[bv${j}]overlay=enable='between(t,${start},${end})':eof_action=pass${nextV}`);
    curV = nextV;
  });

  await runFfmpeg([
    "-y", ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", curV, "-map", "[ca]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    outPath,
  ], signal, "assembly-flatten");

  const durationSec = await probeDuration(outPath).catch(() => totalMain);
  return { durationSec };
}
