import { Composition } from "remotion";
import { CaptionedVideo, type CaptionedVideoProps } from "./CaptionedVideo";
import { DEFAULT_STYLE } from "../../shared/captionStyle";
import { buildCutPlan } from "../../shared/cutplan";

/**
 * Registro da composição. Dimensões vêm por inputProps; a DURAÇÃO final é
 * calculada aplicando os cortes (vídeo emendado) sobre a duração bruta.
 */
export function RemotionRoot() {
  return (
    <Composition
      id="FluxoOuro"
      component={CaptionedVideo}
      durationInFrames={300}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{
        videoSrc: "", transcript: [], style: DEFAULT_STYLE,
        cuts: [], zooms: [], popups: [], durationSec: 10,
      } as CaptionedVideoProps}
      calculateMetadata={({ props }: { props: CaptionedVideoProps & { fps?: number; width?: number; height?: number } }) => {
        const fps = props.fps ?? 30;
        const plan = buildCutPlan(props.durationSec ?? 10, props.cuts ?? []);
        return {
          durationInFrames: Math.max(1, Math.round(plan.outDuration * fps)),
          fps,
          width: props.width ?? 1080,
          height: props.height ?? 1920,
        };
      }}
    />
  );
}
