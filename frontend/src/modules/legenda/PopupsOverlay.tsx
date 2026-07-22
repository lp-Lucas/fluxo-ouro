import { useEffect, useRef } from "react";
import type { Popup } from "../../../../shared/timeline";
import type { CutPlan } from "../../../../shared/cutplan";
import { SupportPopupView, FullscreenPopupView } from "../editor/popups/PopupViews";
import { useFrameTime, type FrameClockLike } from "../../workspace/frameClock";
import { comBase } from "../../os-session";

/**
 * Renderiza os popups ativos por cima do vídeo (preview em tempo real),
 * com design refinado e animação suave por preset. O popup fullscreen de VÍDEO
 * (motion do FLOW) usa um <video> sincronizado ao tempo da timeline (o export usa
 * <OffthreadVideo> — mesma composição via FullscreenPopupView).
 *
 * FOLHA do FrameClock (P1): assina o clock e re-renderiza por frame SOZINHA (subtree
 * pequena — só os popups), sem acordar o preview inteiro.
 */
export function PopupsOverlay({ popups, clock, playing = false, plan }: {
  popups: Popup[]; clock: FrameClockLike; playing?: boolean; plan?: CutPlan;
}) {
  const time = useFrameTime(clock);
  return (
    <>
      {popups.map((p) =>
        p.type === "support"
          ? <SupportPopupView key={p.id} p={p} time={time} />
          : <FullscreenPopupView key={p.id} p={p} time={time}
              videoSlot={(src, fp) => <PreviewFullscreenVideo src={src} at={fp.at} duration={fp.duration} time={time} playing={playing} plan={plan} />} />,
      )}
    </>
  );
}

/**
 * <video> mudo sincronizado ao tempo do preview. O offset é medido em TEMPO DE
 * SAÍDA (pós-cortes): o popup IGNORA os cortes — só o início é reposicionado, e o
 * vídeo toca contínuo por toda a sua duração, igual ao export.
 *
 * FLUIDEZ: o vídeo TOCA NATIVAMENTE junto com o principal (play/pause espelhado) e o
 * seek vira só CORREÇÃO DE DRIFT esparsa (>0.2s). Antes, sem play, ele avançava SÓ por
 * seeks (~10+/s) — a tempestade de seeks era o travamento do preview com popup de vídeo.
 */
function PreviewFullscreenVideo({ src, at, duration, time, playing, plan }: {
  src: string; at: number; duration: number; time: number; playing: boolean; plan?: CutPlan;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  // alvo em tempo de SAÍDA (função pura do tempo atual)
  let target = time - at;
  if (plan) {
    const remapStart = (t: number) => {
      for (const s of plan.segments) if (t <= s.srcEnd) return s.outStart + Math.max(0, t - s.srcStart);
      return plan.outDuration;
    };
    target = remapStart(time) - remapStart(at);
  }
  target = Math.max(0, Math.min(duration, target));
  const ativo = playing && target > 0 && target < duration; // dentro da janela do popup

  // play/pause nativo espelhando o principal (só dentro da janela)
  useEffect(() => {
    const v = ref.current; if (!v) return;
    if (ativo) v.play().catch(() => { /* autoplay/buffer */ });
    else v.pause();
  }, [ativo]);

  // correção de DRIFT esparsa: tocando nativo, o desvio fica ~0 — seek só quando
  // desgarra de verdade (seek do usuário, cut-jump com remap, buffer).
  useEffect(() => {
    const v = ref.current; if (!v) return;
    const drift = Math.abs(v.currentTime - target);
    if (drift > (ativo ? 0.2 : 0.05)) { try { v.currentTime = target; } catch { /* buffering */ } }
  }, [time, target, ativo]);

  return (
    <video ref={ref} src={comBase(src)} muted playsInline preload="auto"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
  );
}
