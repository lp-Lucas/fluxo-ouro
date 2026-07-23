import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runFfmpeg, probeDuration } from "../flow/ffmpeg.js";
import { DEFAULT_TRANSFORM, isIdentityTransform, type ClipTransform } from "../../../shared/assembly.js";

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
 * TRANSFORMAÇÃO (estilo Premiere): cada clipe pode ter escala/posição/opacidade/velocidade.
 * Quando NENHUM clipe tem transform (tudo neutro), usa o caminho ORIGINAL (idêntico ao antigo).
 * Havendo transform, cada clipe é composto sobre a tela com escala/posição/opacidade e a
 * velocidade muda a duração (vídeo por setpts, áudio por atempo).
 *
 * Devolve a duração final medida (s). Não conhece projeto/asset — recebe caminhos já resolvidos.
 */

export interface FlatMainClip { path: string; in: number; out: number; transform?: ClipTransform; }
export interface FlatBrollClip { path: string; in: number; out: number; timelineStart: number; transform?: ClipTransform; }

/** true se o arquivo tem pelo menos uma faixa de áudio. */
async function hasAudio(p: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", p,
    ]);
    return stdout.trim().length > 0;
  } catch { return false; }
}

const tf = (t?: ClipTransform): ClipTransform => t ?? DEFAULT_TRANSFORM;

/**
 * atempo aceita 0.5–2.0 por instância — encadeia pra faixas maiores (ex.: 4× = atempo=2,atempo=2).
 * Preserva o tom (time-stretch), diferente de asetrate.
 */
function atempoChain(speed: number): string {
  let s = Math.max(0.01, speed);
  const parts: string[] = [];
  while (s > 2.0 + 1e-6) { parts.push("atempo=2.0"); s /= 2.0; }
  while (s < 0.5 - 1e-6) { parts.push("atempo=0.5"); s /= 0.5; }
  parts.push(`atempo=${s.toFixed(6)}`);
  return parts.join(",");
}

export async function flattenAssembly(
  main: FlatMainClip[], brolls: FlatBrollClip[], w: number, h: number, outPath: string, signal?: AbortSignal,
): Promise<{ durationSec: number }> {
  if (main.length === 0) throw new Error("A pista precisa de pelo menos um clipe.");

  const inputs: string[] = [];   // args -i (ordem = índice do input no filtergraph)
  const filters: string[] = [];
  const mainHasAudio = await Promise.all(main.map((c) => hasAudio(c.path)));

  // PRINCIPAL: normaliza cada clipe (v + a) na mesma grade (w×h, sar 1, 30fps, 48k stereo).
  let totalMain = 0;
  main.forEach((c, i) => {
    inputs.push("-i", c.path);
    const t = tf(c.transform);
    const durTl = Math.max(0.05, (c.out - c.in) / t.speed); // duração na timeline (pós-velocidade)
    totalMain += durTl;
    if (isIdentityTransform(t)) {
      // caminho ORIGINAL (inalterado): contido + pad centralizado.
      filters.push(
        `[${i}:v]trim=start=${c.in}:end=${c.out},setpts=PTS-STARTPTS,` +
        `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[mv${i}]`,
      );
    } else {
      // TRANSFORM: escala sobre o box contido (w·scale × h·scale), opacidade, e sobrepõe
      // sobre um fundo preto w×h na posição centrada + deslocamento.
      const sw = Math.max(2, Math.round(w * t.scale)), sh = Math.max(2, Math.round(h * t.scale));
      const xpx = Math.round(t.x * w), ypx = Math.round(t.y * h);
      filters.push(
        `[${i}:v]trim=start=${c.in}:end=${c.out},setpts=(PTS-STARTPTS)/${t.speed.toFixed(6)},` +
        `scale=${sw}:${sh}:force_original_aspect_ratio=decrease,setsar=1,fps=30,format=yuva420p,` +
        `colorchannelmixer=aa=${t.opacity.toFixed(4)}[fg${i}]`,
      );
      filters.push(`color=c=black:s=${w}x${h}:r=30:d=${durTl.toFixed(3)}[bgm${i}]`);
      filters.push(`[bgm${i}][fg${i}]overlay=x=(W-w)/2+${xpx}:y=(H-h)/2+${ypx}:shortest=1,format=yuv420p,setsar=1,fps=30[mv${i}]`);
    }
    if (mainHasAudio[i]) {
      const speedChain = t.speed !== 1 ? `,${atempoChain(t.speed)}` : "";
      filters.push(`[${i}:a]atrim=start=${c.in}:end=${c.out},asetpts=PTS-STARTPTS${speedChain},aformat=sample_rates=48000:channel_layouts=stereo[ma${i}]`);
    } else {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${durTl.toFixed(3)},asetpts=PTS-STARTPTS[ma${i}]`);
    }
  });
  const concatInputs = main.map((_, i) => `[mv${i}][ma${i}]`).join("");
  filters.push(`${concatInputs}concat=n=${main.length}:v=1:a=1[cv][ca]`);

  // B-ROLLS: overlay no tempo certo, cobrindo a tela (× escala), com opacidade/posição, mudo.
  let curV = "[cv]";
  brolls.forEach((b, j) => {
    const idx = main.length + j;
    inputs.push("-i", b.path);
    const t = tf(b.transform);
    const durTl = Math.max(0.05, (b.out - b.in) / t.speed);
    const start = Math.max(0, Math.min(b.timelineStart, totalMain));
    const end = Math.min(start + durTl, totalMain);
    const setpts = `setpts=(PTS-STARTPTS)/${t.speed.toFixed(6)}+${start}/TB`;
    if (isIdentityTransform(t)) {
      // caminho ORIGINAL: cobre a tela e sobrepõe.
      filters.push(
        `[${idx}:v]trim=start=${b.in}:end=${b.out},${setpts},` +
        `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=30[bv${j}]`,
      );
    } else {
      const bw = Math.max(2, Math.round(w * t.scale)), bh = Math.max(2, Math.round(h * t.scale));
      const xpx = Math.round(t.x * w), ypx = Math.round(t.y * h);
      filters.push(
        `[${idx}:v]trim=start=${b.in}:end=${b.out},${setpts},` +
        `scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},setsar=1,fps=30,` +
        `format=yuva420p,colorchannelmixer=aa=${t.opacity.toFixed(4)}[bv${j}]`,
      );
    }
    const nextV = `[ov${j}]`;
    const xy = isIdentityTransform(t) ? "" : `x=(W-w)/2+${Math.round(t.x * w)}:y=(H-h)/2+${Math.round(t.y * h)}:`;
    filters.push(`${curV}[bv${j}]overlay=${xy}enable='between(t,${start},${end})':eof_action=pass${nextV}`);
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
