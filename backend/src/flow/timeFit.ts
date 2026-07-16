import fs from "node:fs";
import type { FitStrategy } from "../../../shared/flow.js";
import { runFfmpeg, probeDuration } from "./ffmpeg.js";

/**
 * Time-fit: ajusta a duração do vídeo de motion (bruto) p/ caber EXATAMENTE na
 * duração da frase falada (targetDuration, já em tempo FINAL, pós-cortes).
 *
 *   speed = rawDuration / targetDuration
 *   - speed ≥ 0.5 → SPEED: setpts=PTS/speed (acelera o quanto for preciso —
 *     NUNCA cortamos frame: a animação inteira sempre aparece, só que mais rápida).
 *   - speed < 0.5 → HOLD: desacelera 0.5x e congela o último frame até completar.
 *
 * Saída: MP4 H.264 1920×1080, mudo (o áudio é o da fala), BT.709 (mesmas tags do
 * color pre-pass, sem pop de tonalidade), faststart. Cache pelo outputPath.
 */
export interface TimeFitResult {
  fittedVideoPath: string;
  fitInfo: { rawDuration: number; targetDuration: number; speed: number; strategy: FitStrategy };
}

const OUT = [
  "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
  "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
  "-movflags", "+faststart",
];
const scaleTo = (w: number, h: number) =>
  `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;

export async function timeFit(
  rawVideoPath: string, targetDuration: number, outputPath: string,
  dims: { w: number; h: number } = { w: 1080, h: 1920 }, signal?: AbortSignal,
  opts: { reverse?: boolean; minDuration?: number } = {},
): Promise<TimeFitResult> {
  const SCALE = scaleTo(dims.w, dims.h);
  const rawDuration = await probeDuration(rawVideoPath);
  // piso CONDICIONAL (minDuration, decidido pelo chamador): frase curta que precisa de
  // ar deixa a tela "sobrando" (design parado no fim). Sem piso = duração natural da fala.
  const target = Math.max(0.1, opts.minDuration ?? 0, targetDuration);
  const speed = rawDuration > 0 ? rawDuration / target : 1;

  // O Veo entrega uma SAÍDA (imagem → tela vazia). `reverse` inverte no tempo → vira
  // ENTRADA que TERMINA cravada na imagem aprovada (1º frame do Veo = a imagem).
  const REV = opts.reverse ? "reverse," : "";

  let strategy: FitStrategy;
  let vf: string;
  if (speed < 0.5) {
    // HOLD: desacelera até 0.5x e congela o último frame (a imagem final) até completar.
    strategy = "hold";
    const hold = Math.max(0, target - rawDuration / 0.5);
    vf = `${REV}setpts=PTS/0.5,tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)},${SCALE}`;
  } else {
    // SPEED: ajuste direto, sem teto — acelerar nunca corta conteúdo.
    strategy = "speed";
    vf = `${REV}setpts=PTS/${speed.toFixed(6)},${SCALE}`;
  }

  if (!fs.existsSync(outputPath)) {
    await runFfmpeg([
      "-y", "-i", rawVideoPath, "-vf", vf, "-t", target.toFixed(3), ...OUT, outputPath,
    ], signal, "flow-timefit");
  }

  const effSpeed = strategy === "hold" ? 0.5 : speed;
  return { fittedVideoPath: outputPath, fitInfo: { rawDuration: +rawDuration.toFixed(3), targetDuration: +target.toFixed(3), speed: +effSpeed.toFixed(3), strategy } };
}
