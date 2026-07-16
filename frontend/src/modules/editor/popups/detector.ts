import type {
  Popup,
  SupportPopup,
  FullscreenPopup,
  TranscriptSegment,
  PopupTriggerReason,
} from "../../../../../shared/timeline";
import { DEFAULT_POPUP_TRANSITION } from "../../../../../shared/timeline";

/**
 * Abstração de detecção de popups (mesma ideia do ImageProvider).
 * Hoje: heurística grátis. Amanhã: trocar por um detector de IA sem mexer no FLOW.
 */
export interface PopupDetector {
  readonly name: string;
  detect(transcript: TranscriptSegment[]): Popup[];
}

/** Marcas/produtos conhecidos → sugerem logo-card (Tipo 1). Fácil de estender. */
const BRANDS = [
  "chatgpt", "openai", "google", "gemini", "youtube", "instagram", "tiktok",
  "facebook", "meta", "whatsapp", "apple", "microsoft", "amazon", "nvidia",
  "netflix", "spotify", "canva", "notion", "figma",
];

/** Palavras que indicam demonstração visual total → Tipo 2 (tela cheia). */
const DEMO_HINTS = ["olha", "veja", "repara", "imagina", "imagine", "por exemplo", "assim ó", "presta atenção"];

function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function makeSupport(
  id: string,
  at: number,
  duration: number,
  preset: SupportPopup["preset"],
  content: SupportPopup["content"],
  trigger: { segmentId: string; reason: PopupTriggerReason; matchedText: string },
): SupportPopup {
  return {
    id,
    type: "support",
    at: +at.toFixed(3),
    duration,
    source: "auto",
    trigger,
    transition: { ...DEFAULT_POPUP_TRANSITION },
    preset,
    content,
    layout: { x: 70, y: 30, scale: 1 },
  };
}

function makeFullscreen(
  id: string,
  at: number,
  duration: number,
  trigger: { segmentId: string; reason: PopupTriggerReason; matchedText: string },
): FullscreenPopup {
  return {
    id,
    type: "fullscreen",
    at: +at.toFixed(3),
    duration,
    source: "auto",
    trigger,
    transition: { ...DEFAULT_POPUP_TRANSITION },
    placeholder: { label: trigger.matchedText },
  };
}

/**
 * Detector heurístico (gratuito). Varre a transcrição e sugere popups:
 *  - marca citada  → logo-card (Tipo 1)
 *  - número/dado (%, R$, milhões) → highlight-number (Tipo 1)
 *  - nome próprio (Maiúscula) → keyword/textbox (Tipo 1)
 *  - frase de demonstração ("olha", "veja"...) → tela cheia (Tipo 2)
 * Garante que Tipo 1 e Tipo 2 nunca ocupem o mesmo ponto.
 */
export class HeuristicPopupDetector implements PopupDetector {
  readonly name = "heuristic";

  detect(transcript: TranscriptSegment[]): Popup[] {
    const popups: Popup[] = [];
    let n = 0;
    const occupied: { start: number; end: number }[] = [];
    const overlaps = (at: number, dur: number) =>
      occupied.some((o) => at < o.end && at + dur > o.start);
    const push = (p: Popup) => {
      if (overlaps(p.at, p.duration)) return;
      occupied.push({ start: p.at, end: p.at + p.duration });
      popups.push(p);
    };

    for (const seg of transcript) {
      const segNorm = norm(seg.text);

      // Tipo 2 primeiro (mais "forte"): frase de demonstração visual.
      const demo = DEMO_HINTS.find((h) => segNorm.includes(norm(h)));
      if (demo) {
        push(makeFullscreen(`popup-${n++}`, seg.start, Math.min(4, seg.end - seg.start || 3), {
          segmentId: seg.id, reason: "demo-visual", matchedText: demo,
        }));
        continue; // não colocar Tipo 1 no mesmo segmento
      }

      // Tipo 1: varre as palavras (limpa pontuação colada antes de casar).
      seg.words.forEach((w, wi) => {
        const clean = w.text.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu, ""); // tira pontuação nas pontas
        const wn = norm(clean);
        if (!clean) return;

        if (BRANDS.includes(wn)) {
          push(makeSupport(`popup-${n++}`, w.start, 2.5, "logo-card",
            { logoUrl: "", text: clean },
            { segmentId: seg.id, reason: "marca", matchedText: clean }));
        } else if (/\d/.test(clean) || /%|r\$/i.test(clean)) {
          // número / porcentagem / valor em R$
          push(makeSupport(`popup-${n++}`, w.start, 2, "highlight-number",
            { value: clean },
            { segmentId: seg.id, reason: "dado", matchedText: clean }));
        } else if (wi > 0 && /^[A-ZÀ-Ú][\p{L}]{2,}$/u.test(clean)) {
          // nome próprio: maiúsculo no MEIO da fala (wi>0 evita início de frase)
          push(makeSupport(`popup-${n++}`, w.start, 2, "keyword",
            { text: clean },
            { segmentId: seg.id, reason: "nome", matchedText: clean }));
        }
      });
    }

    return popups.sort((a, b) => a.at - b.at);
  }
}

/** Seleção do detector (trocável no futuro para um provider de IA). */
export function getPopupDetector(): PopupDetector {
  return new HeuristicPopupDetector();
}
