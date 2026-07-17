import { AbsoluteFill, OffthreadVideo, Audio, Sequence, useCurrentFrame, useVideoConfig, delayRender, continueRender } from "remotion";
import type { TranscriptSegment, Cut, Zoom, Popup, Caption } from "../../shared/timeline";
import type { CaptionStyle } from "../../shared/captionStyle";
import { wordFx, hexToRgba, shadowCss } from "../../shared/captionStyle";
import { activeLine, resolveCaptionLines, remapLineToOutput, type CaptionLine } from "../../shared/captions";
import { buildCutPlan, remapTime, remapTimeClamped, type CutPlan } from "../../shared/cutplan";
import { easedZoomScale, type ZoomLike } from "../../shared/zoom";
import { SupportPopupView, FullscreenPopupView } from "../../frontend/src/modules/editor/popups/PopupViews";

export interface CaptionedVideoProps {
  videoSrc: string;
  /** Chroma em camadas: pessoa recortada (WebM alpha) por cima do popup "atrás". */
  personSrc?: string;
  transcript: TranscriptSegment[];
  style: CaptionStyle;
  cuts: Cut[];
  zooms: Zoom[];
  popups: Popup[];
  /**
   * Legendas com tempo manual (camada da timeline). Quando vem preenchido, MANDA sobre
   * a derivação da transcrição — mesma regra do preview (resolveCaptionLines).
   */
  captions?: Caption[];
  durationSec: number;
  /**
   * Áudio decupado (WAV único, cortes já emendados com crossfade equal-power — Fase 4).
   * Quando presente: o áudio vem DAQUI e os OffthreadVideo ficam mudos (fonte única,
   * idêntica ao preview). Ausente: fallback ao áudio dos próprios segmentos de vídeo.
   */
  audioSrc?: string;
}

// Mesmas fontes do site (para a legenda sair idêntica ao preview).
const FONT_LINKS = [
  "https://fonts.googleapis.com/css2?family=Anton&family=Archivo+Black&family=Bangers&family=Bebas+Neue&family=Fredoka:wght@600;700&family=Luckiest+Guy&family=Montserrat:wght@700;900&family=Oswald:wght@600;700&family=Poppins:wght@600;800&display=swap",
  "https://fonts.googleapis.com/css2?family=Abril+Fatface&family=Alfa+Slab+One&family=Bungee&family=Black+Ops+One&family=Caveat:wght@700&family=Fjalla+One&family=Kanit:wght@600;800&family=Lobster&family=Pacifico&family=Passion+One:wght@700;900&family=Permanent+Marker&family=Righteous&family=Rubik+Mono+One&family=Russo+One&family=Teko:wght@600;700&family=Titan+One&family=Inter:wght@400;700;900&family=Roboto:wght@400;700;900&family=Lato:wght@400;700;900&family=Raleway:wght@400;700;900&family=Nunito:wght@400;700;900&family=Work+Sans:wght@400;700;900&family=DM+Sans:wght@400;700&family=Space+Grotesk:wght@400;700&family=Manrope:wght@400;700;800&family=Outfit:wght@400;700;900&family=Plus+Jakarta+Sans:wght@400;700;800&family=Sora:wght@400;700;800&family=Josefin+Sans:wght@400;700&family=Quicksand:wght@400;700&family=Barlow:wght@400;700;900&family=Rubik:wght@400;700;900&family=Syne:wght@700;800&family=Staatliches&family=Paytone+One&family=Bowlby+One&family=Sigmar+One&family=Ultra&family=Rowdies:wght@400;700&family=Concert+One&family=Chewy&family=Baloo+2:wght@700;800&family=Unbounded:wght@700;900&family=Shrikhand&family=Monoton&family=Orbitron:wght@700;900&family=Audiowide&family=Press+Start+2P&family=Playfair+Display:wght@400;700;900&family=Merriweather:wght@400;700;900&family=Cormorant+Garamond:wght@400;700&family=Libre+Baskerville:wght@400;700&family=DM+Serif+Display&family=Yeseva+One&family=Dancing+Script:wght@700&family=Great+Vibes&family=Satisfy&family=Sacramento&family=Kaushan+Script&family=Yellowtail&display=swap",
];

// Carrega as Google Fonts UMA vez por worker do render (escopo de módulo, não
// por frame) e segura o início até estarem prontas. Timeout generoso.
/** Extrai o nome da família de um valor CSS ("'Anton', sans-serif" → "Anton"). */
function familyName(css?: string): string | null {
  if (!css) return null;
  const m = css.match(/^\s*['"]?([^'",]+)/);
  const name = m?.[1].trim();
  if (!name || /^(system-ui|-apple-system|sans-serif|serif|monospace|cursive|Impact|Arial)/i.test(name)) return null;
  return name;
}

/** Coleta as fontes realmente usadas (legenda + tipografias). */
function usedFamilies(style: CaptionStyle, popups: Popup[]): string[] {
  const set = new Set<string>();
  const add = (css?: string) => { const n = familyName(css); if (n) set.add(n); };
  add(style?.fontFamily);
  for (const p of popups ?? []) {
    if (p?.type === "support" && p?.preset === "typography") {
      add(p.content?.typoStyle?.fontFamily);
      for (const ln of p.content?.typo?.lines ?? []) add(ln?.style?.fontFamily);
    }
  }
  return [...set];
}

// Carrega as fontes UMA vez por worker, dentro do componente (props já existem).
// Libera por eventos reais (onload/onerror/fonts.load) — nunca depende de timer.
let fontsRequested = false;
function ensureFonts(style: CaptionStyle, popups: Popup[]) {
  if (fontsRequested || typeof document === "undefined") return;
  fontsRequested = true;
  const handle = delayRender("carregando fontes");
  let done = false;
  const clear = () => { if (!done) { done = true; continueRender(handle); } };
  try {
    const families = usedFamilies(style, popups);
    if (families.length === 0) { clear(); return; }
    const links = FONT_LINKS.map((href) => new Promise<void>((res) => {
      const l = document.createElement("link");
      l.rel = "stylesheet"; l.href = href;
      l.onload = () => res(); l.onerror = () => res();
      document.head.appendChild(l);
    }));
    Promise.all(links)
      .then(() => Promise.all(families.map((f) => document.fonts.load(`900 16px "${f}"`).catch(() => []))))
      .then(clear)
      .catch(clear);
  } catch {
    clear();
  }
}

/** URLs de imagem usadas nos popups (logo/foto/placeholder). */
function usedImages(popups: Popup[]): string[] {
  const urls = new Set<string>();
  for (const p of popups ?? []) {
    if (p.type === "support") {
      if (p.content?.imageUrl) urls.add(p.content.imageUrl);
      if (p.content?.logoUrl) urls.add(p.content.logoUrl);
    } else if (p.type === "fullscreen" && p.placeholder?.imageUrl) {
      urls.add(p.placeholder.imageUrl);
    }
  }
  return [...urls].filter((u) => /^https?:|^data:/.test(u));
}

// Pré-carrega as imagens dos popups UMA vez e segura o frame até prontas — senão
// o <img> pode não ter carregado quando o Remotion captura o frame (imagem vazia).
let imagesRequested = false;
function ensureImages(popups: Popup[]) {
  if (imagesRequested || typeof document === "undefined") return;
  imagesRequested = true;
  const urls = usedImages(popups);
  if (urls.length === 0) return;
  const handle = delayRender("carregando imagens");
  let done = false;
  const clear = () => { if (!done) { done = true; continueRender(handle); } };
  Promise.all(urls.map((u) => new Promise<void>((res) => {
    const im = new Image();
    im.onload = () => res(); im.onerror = () => res();
    im.src = u;
  }))).then(clear).catch(clear);
}

/** Zoom SUAVE (em tempo de SAÍDA), remapeando o at de cada zoom. */
function zoomScaleAt(zooms: Zoom[], plan: CutPlan, outTime: number): number {
  const remapped: ZoomLike[] = [];
  for (const z of zooms) {
    const o = remapTime(z.at, plan);
    if (o != null) remapped.push({ at: o, duration: z.duration, scale: z.scale });
  }
  return easedZoomScale(remapped, outTime);
}

/**
 * Composição final: aplica CORTES (emenda os trechos mantidos), ZOOMS, POPUPS e
 * LEGENDAS — tudo com os tempos remapeados do vídeo bruto para o vídeo final.
 * Reproduz o que o preview mostra.
 */
export function CaptionedVideo({ videoSrc, personSrc, transcript, style, cuts, zooms, popups, captions, durationSec, audioSrc }: CaptionedVideoProps) {
  ensureFonts(style, popups ?? []);
  ensureImages(popups ?? []);
  const frame = useCurrentFrame();
  // Evidência: o que a composição REALMENTE recebeu (aparece no output do render via onBrowserLog).
  if (frame === 0) {
    console.log(`[COMPO] popups=${popups?.length ?? 0} cuts=${cuts?.length ?? 0} zooms=${zooms?.length ?? 0} ` +
      `captions=${captions?.length ?? 0}${captions?.length ? " (tempo manual)" : " (derivadas)"} ` +
      `font=${style?.fontFamily} mode=${style?.mode} durationSec=${durationSec} ` +
      `img0=${(popups?.[0] as { content?: { imageUrl?: string } })?.content?.imageUrl?.slice(0, 40)}`);
  }
  const { fps } = useVideoConfig();
  const outTime = frame / fps;
  const plan = buildCutPlan(durationSec, cuts ?? []);

  // Legendas: resolve as linhas (manuais mandam; senão deriva) em tempo de FONTE, e
  // remapeia cada uma p/ o tempo de saída. MESMA função do preview — se divergir aqui,
  // o vídeo final sai diferente do que o usuário ajustou na timeline.
  const outLines: CaptionLine[] = resolveCaptionLines(transcript, cuts ?? [], captions, style.maxWords)
    .map((l) => remapLineToOutput(l, plan))
    .filter((l): l is CaptionLine => l !== null);

  const line = activeLine(outLines, outTime);
  const zoom = zoomScaleAt(zooms ?? [], plan, outTime);

  // POPUPS IGNORAM OS CORTES: só o INÍCIO (at) é reposicionado pro tempo de saída;
  // a DURAÇÃO é tempo real de tela e passa intacta (o corte não encurta nem descarta
  // o popup). Se o at cai dentro de um corte, encosta no início do próximo trecho
  // mantido (nunca some). Vale pros motions do FLOW e pros popups de apoio.
  const outPopups = (popups ?? []).map((p) => ({ ...p, at: remapTimeClamped(p.at, plan) }));

  // Com áudio decupado (fonte única), os segmentos de vídeo ficam MUDOS — o som vem do
  // <Audio> global. Sem ele, cada segmento carrega o próprio áudio (fallback).
  const muteVideo = !!audioSrc;

  // Camadas do vídeo (segmentos emendados, com zoom). Reutilizado p/ fundo e pessoa.
  const videoLayer = (src: string, transparent: boolean) => (
    <AbsoluteFill style={{ transform: `scale(${zoom})`, transformOrigin: "center center" }}>
      {plan.segments.map((s, i) => (
        <Sequence key={i} from={Math.round(s.outStart * fps)} durationInFrames={Math.max(1, Math.round((s.srcEnd - s.srcStart) * fps))}>
          <OffthreadVideo src={src} startFrom={Math.round(s.srcStart * fps)} transparent={transparent} muted={muteVideo}
            style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
  const renderPopups = (list: Popup[]) => (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {list.map((p) =>
        p.type === "support"
          ? <SupportPopupView key={p.id} p={p} time={outTime} />
          : <FullscreenPopupView key={p.id} p={p} time={outTime}
              videoSlot={(src, fp) => (
                // vídeo do motion (FLOW): OffthreadVideo mudo, do frame 0, no Sequence do popup
                <Sequence from={Math.round(fp.at * fps)} durationInFrames={Math.max(1, Math.round(fp.duration * fps))}>
                  <OffthreadVideo src={src} startFrom={0} muted
                    style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
                </Sequence>
              )} />,
      )}
    </AbsoluteFill>
  );

  // Chroma em camadas: fundo → popups "atrás" → pessoa (transparente) → popups da frente.
  const layered = !!personSrc;
  const behindPopups = layered ? outPopups.filter((p) => p.behindSubject) : [];
  const frontPopups = layered ? outPopups.filter((p) => !p.behindSubject) : outPopups;
  // FULLSCREEN fica NA FRENTE das legendas (cobre tudo); os demais ficam atrás delas.
  const fullscreenTop = frontPopups.filter((p) => p.type === "fullscreen");
  const frontBelowCaptions = frontPopups.filter((p) => p.type !== "fullscreen");

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {/* ÁUDIO DECUPADO (fonte única, Fase 4): cortes já emendados com crossfade. Toca do
          frame 0 pela saída inteira; os vídeos ficam mudos. Idêntico ao <audio> do preview. */}
      {audioSrc && <Audio src={audioSrc} />}

      {/* VÍDEO / FUNDO: segmentos mantidos, emendados, com zoom */}
      {videoLayer(videoSrc, false)}

      {/* POPUPS "ATRÁS DA PESSOA" (só no modo camadas) */}
      {layered && renderPopups(behindPopups)}

      {/* PESSOA RECORTADA */}
      {layered ? (
        // chroma em camadas: pessoa transparente (WebM alpha) por cima do popup "atrás"
        videoLayer(personSrc!, true)
      ) : (
        // RVM (sem chroma): alpha por popup behindSubject, por cima do popup, mesmo zoom
        <AbsoluteFill style={{ transform: `scale(${zoom})`, transformOrigin: "center center" }}>
          {outPopups.map((p) =>
            p.type === "support" && p.behindSubject && p.alphaVideoPath ? (
              <Sequence key={`m-${p.id}`} from={Math.round(p.at * fps)} durationInFrames={Math.max(1, Math.round(p.duration * fps))}>
                <OffthreadVideo src={p.alphaVideoPath} transparent style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              </Sequence>
            ) : null,
          )}
        </AbsoluteFill>
      )}

      {/* POPUPS de apoio (abaixo das legendas) */}
      {renderPopups(frontBelowCaptions)}

      {/* LEGENDAS */}
      {line && (
        <AbsoluteFill style={{ pointerEvents: "none", opacity: style.opacity }}>
          <div style={{
            position: "absolute", left: `${style.posX}%`, top: `${style.posY}%`,
            transform: "translate(-50%, -50%)", width: "90%", textAlign: "center",
          }}>
            <span style={{
              display: "inline-block", fontFamily: style.fontFamily, fontSize: style.fontSize,
              fontWeight: style.fontWeight, letterSpacing: style.letterSpacing, lineHeight: 1.3,
              textShadow: shadowCss(style),
            }}>
              {line.words.map((w, i) => {
                const isActive = outTime >= w.start && outTime <= w.end;
                const isSpoken = outTime >= w.start;
                const color =
                  style.mode === "static" ? style.colorSpoken
                    : style.mode === "highlight" ? (isSpoken ? style.colorSpoken : style.colorUpcoming)
                      : isActive ? style.colorActive : isSpoken ? style.colorSpoken : style.colorUpcoming;
                let background = "transparent";
                if (style.mode === "highlight" && isActive) background = hexToRgba(style.highlight.color, style.highlight.opacity);
                else if (style.wordBg.enabled) background = hexToRgba(style.wordBg.color, style.wordBg.opacity);
                const box = style.mode === "highlight" && isActive ? style.highlight : style.wordBg;
                return (
                  <span key={i} style={{
                    display: "inline-block", color, background,
                    padding: `${box.paddingY}px ${box.paddingX}px`, borderRadius: box.radius,
                    margin: `0 ${style.wordSpacing / 2}px`,
                    WebkitTextStroke: style.outline.enabled ? `${style.outline.width}px ${style.outline.color}` : undefined,
                    ...wordFx(style, w.start, i, outTime),
                  }}>
                    {w.text}
                  </span>
                );
              })}
            </span>
          </div>
        </AbsoluteFill>
      )}

      {/* POPUPS FULLSCREEN — NA FRENTE das legendas (cobrem a tela toda) */}
      {renderPopups(fullscreenTop)}
    </AbsoluteFill>
  );
}
