import type { CSSProperties } from "react";
import { comBase } from "../../../os-session";
import type { SupportPopup, FullscreenPopup, PopupTransition, TypoLine } from "../../../../../shared/timeline";
import { shadowCss, wordFx } from "../../../../../shared/captionStyle";

/**
 * Deriva a tipografia a partir do texto quando não há uma explícita:
 * a 1ª palavra fica GRANDE e o resto pequeno embaixo (ex: "100 mil mês").
 */
export function deriveTypo(text = ""): { lines: TypoLine[]; align: "left" | "center" | "right"; lineGap?: number } {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const big = tokens[0] ?? "100";
  const small = tokens.slice(1).join(" ");
  const lines: TypoLine[] = [{ text: big, size: 64, weight: 900 }];
  if (small) lines.push({ text: small, size: 22, weight: 600 });
  return { lines, align: "center" };
}

/** easeOutBack — overshoot (spring). `amt` controla a força do bounce. */
function easeBack(p: number, amt = 1.70158): number {
  const c3 = amt + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + amt * Math.pow(p - 1, 2);
}
/** easeOutElastic — bounce viral (vai além e volta oscilando). */
function easeElastic(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const c4 = (2 * Math.PI) / 3;
  return Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * c4) + 1;
}
function easeOut(p: number): number {
  return 1 - Math.pow(1 - p, 3);
}
const clamp = (n: number) => Math.max(0, Math.min(1, n));

/** Opacidade + progresso de entrada/saída de um popup no tempo. */
export function popupPhase(t: PopupTransition, at: number, duration: number, time: number) {
  // JANELA DURA: fora de [at, at+duration] o popup NÃO existe — independente da
  // transição. (Sem isso, transição "none" forçava opacidade 1 pra sempre.)
  if (time < at || time > at + duration) return { opacity: 0, pIn: 0, pOut: 0 };
  const pIn = clamp((time - at) / Math.max(t.inDuration, 0.001));
  const pOut = clamp((at + duration - time) / Math.max(t.outDuration, 0.001));
  // "none" = sem fade próprio (aparece/some na hora, cravado na janela) — deixa
  // as animações internas (ex: das linhas da tipografia) mandarem.
  const opIn = t.inType === "none" ? 1 : pIn;
  const opOut = t.outType === "none" ? 1 : pOut;
  return { opacity: Math.min(opIn, opOut), pIn, pOut };
}

/**
 * Estilo de animação conforme o tipo escolhido (entrada + saída).
 * Retorna transform + blur, combinando entrada (pIn: 0→1) e saída (pOut: 1→0).
 */
export function animStyle(t: PopupTransition, pIn: number, pOut: number, baseScale: number): { transform: string; blur: number } {
  let tx = 0, ty = 0, sc = 1, rot = 0, blur = 0;
  const eIn = easeOut(pIn), eOut = easeOut(pOut);

  switch (t.inType) {
    case "fade": break;
    case "slide": ty += (1 - eIn) * 26; break;
    case "scale": sc *= 0.6 + 0.4 * eIn; break;
    case "spring": ty += (1 - easeBack(pIn)) * 22; sc *= 0.85 + 0.15 * eIn; break;
    case "pop-bounce": sc *= 0.3 + 0.7 * easeElastic(pIn); break;
    case "slide-up-blur": ty += (1 - eIn) * 44; blur += (1 - pIn) * 10; break;
    case "slide-left": tx += -(1 - easeBack(pIn)) * 60; break;
    case "slide-right": tx += (1 - easeBack(pIn)) * 60; break;
    case "zoom-blur": sc *= 1.6 - 0.6 * eIn; blur += (1 - pIn) * 12; break;
    case "rotate": rot += (1 - easeBack(pIn)) * -18; sc *= 0.8 + 0.2 * eIn; break;
  }
  switch (t.outType) {
    case "fade": break;
    case "slide": ty += (1 - eOut) * 26; break;
    case "scale": sc *= 0.6 + 0.4 * eOut; break;
    case "zoom-blur": sc *= 1.4 - 0.4 * eOut; blur += (1 - pOut) * 12; break;
    case "slide-blur": ty += (1 - eOut) * 26; blur += (1 - pOut) * 8; break;
  }
  const transform =
    `translate(calc(-50% + ${tx.toFixed(1)}px), calc(-50% + ${ty.toFixed(1)}px)) ` +
    `scale(${(sc * baseScale).toFixed(3)}) rotate(${rot.toFixed(1)}deg)`;
  return { transform, blur };
}

const ACCENT = "#ff2e63";
const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

/**
 * Tipo 1 — apoio. Design refinado por preset + animação suave (spring):
 * entra deslizando de baixo com leve escala/overshoot e sai por fade.
 */
export function SupportPopupView({ p, time }: { p: SupportPopup; time: number }) {
  const { opacity, pIn, pOut } = popupPhase(p.transition, p.at, p.duration, time);
  if (opacity <= 0) return null;

  const { transform, blur } = animStyle(p.transition, pIn, pOut, p.layout.scale);
  const shadow = p.preset === "photo-plain" ? "" : "drop-shadow(0 10px 24px rgba(0,0,0,0.35))";
  const filter = [blur > 0.1 ? `blur(${blur.toFixed(1)}px)` : "", shadow].filter(Boolean).join(" ");

  const wrap: CSSProperties = {
    position: "absolute",
    left: `${p.layout.x}%`,
    top: `${p.layout.y}%`,
    transform,
    opacity,
    pointerEvents: "none",
    fontFamily: FONT,
    filter: filter || undefined,
  };

  return <div style={wrap}>{renderPreset(p, time)}</div>;
}

function renderPreset(p: SupportPopup, time: number): React.ReactNode {
  const text = p.content.text ?? "";
  // CORES do "botão"/card — o usuário pode escolher; ausente = padrão do preset.
  const c = p.content.colors ?? {};
  const accent = c.accent || ACCENT;
  switch (p.preset) {
    case "balloon": {
      const bg = c.bg || "#fff";
      return (
        <div style={{ position: "relative", background: bg, color: c.text || "#111", padding: "12px 16px", borderRadius: 16, font: "600 17px/1.35 " + FONT, maxWidth: 320 }}>
          {text}
          <div style={{ position: "absolute", bottom: -7, left: 24, width: 16, height: 16, background: bg, transform: "rotate(45deg)" }} />
        </div>
      );
    }

    case "textbox":
      return (
        <div style={{ display: "flex", alignItems: "stretch", background: c.bg || "rgba(20,20,28,0.92)", color: c.text || "#fff", borderRadius: 12, overflow: "hidden", maxWidth: 340 }}>
          <div style={{ width: 5, background: accent }} />
          <div style={{ padding: "12px 16px", font: "600 16px/1.4 " + FONT }}>{text}</div>
        </div>
      );

    case "logo-card":
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 12, background: c.bg || "#fff", color: c.text || "#111", padding: "12px 16px", borderRadius: 16 }}>
          {p.content.logoUrl
            ? <img src={comBase(p.content.logoUrl)} alt="" style={{ height: 40, width: 40, objectFit: "contain", borderRadius: 8 }} />
            : <div style={{ height: 40, width: 40, borderRadius: 8, background: "#eee", display: "grid", placeItems: "center", fontSize: 11, color: "#999" }}>logo</div>}
          <span style={{ font: "700 17px/1.2 " + FONT }}>{text || "Marca"}</span>
        </div>
      );

    case "photo-card":
      return (
        <div style={{ background: c.bg || "#fff", padding: 8, borderRadius: 16, maxWidth: 260 }}>
          {p.content.imageUrl
            ? <img src={comBase(p.content.imageUrl)} alt="" style={{ display: "block", width: "100%", borderRadius: 12, maxHeight: 200, objectFit: "cover" }} />
            : <div style={{ width: 240, height: 150, borderRadius: 12, background: "#eee", display: "grid", placeItems: "center", color: "#999", font: "13px " + FONT }}>foto</div>}
          {text && <div style={{ padding: "8px 8px 4px", color: c.text || "#111", font: "600 14px/1.3 " + FONT }}>{text}</div>}
        </div>
      );

    case "photo-plain":
      return p.content.imageUrl
        ? <img src={comBase(p.content.imageUrl)} alt="" style={{ display: "block", maxWidth: 320, maxHeight: 320, borderRadius: 8 }} />
        : <div style={{ width: 240, height: 150, borderRadius: 8, background: "rgba(0,0,0,0.4)", display: "grid", placeItems: "center", color: "#fff", font: "13px " + FONT }}>foto pura</div>;

    case "highlight-number":
      return (
        <div style={{ background: c.bg || `linear-gradient(135deg, ${accent}, #ff6b3d)`, color: c.text || "#fff", padding: "12px 24px", borderRadius: 999, font: "800 30px/1 " + FONT, letterSpacing: -0.5 }}>
          {p.content.value || text || "0"}
        </div>
      );

    case "keyword":
      return (
        <div style={{ background: c.bg || accent, color: c.text || "#fff", padding: "8px 20px", borderRadius: 12, font: "800 22px/1.1 " + FONT, textTransform: "uppercase", letterSpacing: 0.5 }}>
          {text || "palavra"}
        </div>
      );

    case "typography": {
      const typo = p.content.typo ?? deriveTypo(text);
      const base = p.content.typoStyle; // estilo geral (fallback)
      return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: alignItems(typo.align), lineHeight: 1.05, textAlign: typo.align ?? "center" }}>
          {typo.lines.map((ln, i) => {
            const st = ln.style ?? base; // estilo por linha tem prioridade
            // animações de entrada/loop do estilo (disparam no tempo do popup)
            const fx = st ? wordFx(st, p.at, i, time) : {};
            return (
              <span key={i} style={{
                display: "inline-block",
                marginTop: i === 0 ? 0 : (typo.lineGap ?? 0),
                color: ln.color ?? st?.colorSpoken ?? "#fff",
                fontSize: ln.size,
                fontWeight: ln.weight ?? st?.fontWeight ?? 800,
                fontFamily: st?.fontFamily ?? FONT,
                letterSpacing: st?.letterSpacing ?? -0.5,
                textShadow: st ? shadowCss(st) : "0 3px 10px rgba(0,0,0,0.5)",
                WebkitTextStroke: st?.outline.enabled ? `${st.outline.width}px ${st.outline.color}` : undefined,
                ...fx,
              }}>
                {ln.text}
              </span>
            );
          })}
        </div>
      );
    }
  }
}

function alignItems(a?: "left" | "center" | "right"): CSSProperties["alignItems"] {
  return a === "left" ? "flex-start" : a === "right" ? "flex-end" : "center";
}

/**
 * Tipo 2 — tela cheia. Renderiza a MÍDIA em tela cheia (motion do FLOW = vídeo;
 * ou imagem estática); sem mídia, mostra um placeholder elegante.
 * O elemento de VÍDEO vem do chamador via `videoSlot` (paridade): o preview passa
 * um <video> sincronizado; o Remotion passa um <OffthreadVideo>. Mesma composição.
 */
export function FullscreenPopupView({ p, time, videoSlot }: {
  p: FullscreenPopup;
  time: number;
  videoSlot?: (src: string, popup: FullscreenPopup) => React.ReactNode;
}) {
  const { opacity, pIn } = popupPhase(p.transition, p.at, p.duration, time);
  if (opacity <= 0) return null;
  const scale = 1.06 - 0.06 * easeOut(pIn);
  const fill: CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" };

  let content: React.ReactNode;
  let hasMedia = true;
  if (p.media?.kind === "video" && videoSlot) content = videoSlot(p.media.src, p);
  else if (p.media?.kind === "image") content = <img src={comBase(p.media.src)} alt="" style={fill} />;
  else if (p.placeholder?.imageUrl) content = <img src={comBase(p.placeholder.imageUrl)} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />;
  else { hasMedia = false; content = p.placeholder?.label || "Tela animada (FLOW)"; }

  return (
    <div style={{ position: "absolute", inset: 0, opacity, pointerEvents: "none", overflow: "hidden" }}>
      <div style={{
        position: "absolute", inset: 0, transform: `scale(${scale})`,
        background: hasMedia ? "#000" : "radial-gradient(circle at 30% 30%, #24243e, #0f0f1a)",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: "#fff", font: "700 24px/1.3 " + FONT, textAlign: "center", padding: hasMedia ? 0 : 24,
      }}>
        {content}
      </div>
    </div>
  );
}
