/**
 * Timeline JSON — fonte única e versionável do projeto.
 *
 * Todas as etapas (transcrição, correção, legenda, editor, flow) leem e escrevem
 * AQUI. Cada artefato é inspecionável e corrigível manualmente (princípio do FLOW
 * editável ponta a ponta). Nunca é "caixa-preta".
 *
 * (import de tipo só; não cria acoplamento em runtime)
 */

import type { CaptionStyle } from "./captionStyle.js";
import type { ColorSettings } from "./color.js";
import { DEFAULT_COLOR } from "./color.js";
import type { ChromaSettings } from "./chroma.js";
import { DEFAULT_CHROMA } from "./chroma.js";
import type { FlowState } from "./flow.js";

export type Seconds = number;

/**
 * Palavra com timestamp — saída da transcrição (faster-whisper).
 * `start`/`end` (segundos) passam a ser HINT do Whisper (não mais a verdade de tempo).
 * A verdade vem da ancoragem ao VAD: `vadStartMs`/`vadEndMs`/`vadSegmentIdx`.
 * Os campos extras são OPCIONAIS (o app antigo ignora; a decupagem preenche).
 */
export interface Word {
  text: string;
  start: Seconds;
  end: Seconds;
  // confiança do reconhecimento (transcribe.py) — sinal da guarda de mishear, nunca de tempo.
  probability?: number;      // per-word (0..1)
  avgLogprob?: number;       // herdado do segmento pai
  noSpeechProb?: number;     // herdado do segmento pai
  compressionRatio?: number; // herdado do segmento pai
  // ancoragem ao VAD (anchor.ts) — a borda REAL medida por energia/fala.
  vadStartMs?: number;
  vadEndMs?: number;
  vadSegmentIdx?: number;    // índice do trecho de fala do VAD; -1 = whisper_hallucination (sem fala a <100ms)
  vadHallGapMs?: number;     // só p/ órfã (idx -1): duração do segmento NÃO-fala que a contém (item 3)
}

/** Segmento de fala. `source` indica se foi corrigido manualmente. */
export interface TranscriptSegment {
  id: string;
  start: Seconds;
  end: Seconds;
  text: string;
  words: Word[];
  source: "whisper" | "corrected";
}

/** Corte do AUTOCUT (decupagem automática), editável manualmente. */
export interface Cut {
  id: string;
  start: Seconds;
  end: Seconds;
  reason: "silence" | "error" | "manual";
  enabled: boolean;
  /**
   * Se true, a legenda das palavras dentro do corte NÃO é removida — ela é
   * deslocada para logo depois do corte (onde está o take que ficou). Útil
   * quando a frase foi transcrita uma vez só e o take errado foi cortado.
   */
  shiftCaption?: boolean;
}

export interface Zoom {
  id: string;
  at: Seconds;
  duration: Seconds;
  scale: number;
}

/**
 * POPUPS — elementos integrados à cena (renderizados nativamente no Remotion).
 * Dois tipos que NUNCA coexistem no mesmo ponto:
 *  - "support": pessoa continua em cena; elemento sobe suavemente por cima.
 *  - "fullscreen": pessoa sai; corta para tela animada (referencia um MotionPoint do FLOW).
 * Sugeridos pela transcrição, mas 100% editáveis.
 */
export type PopupSource = "auto" | "manual";

export type PopupTriggerReason = "marca" | "dado" | "nome" | "conceito" | "demo-visual";

export interface PopupTrigger {
  segmentId: string;
  reason: PopupTriggerReason;
  matchedText: string;
}

export type PopupInAnim =
  | "none"
  | "fade"
  | "slide"
  | "scale"
  | "spring"
  | "pop-bounce"
  | "slide-up-blur"
  | "slide-left"
  | "slide-right"
  | "zoom-blur"
  | "rotate";

export type PopupOutAnim = "none" | "fade" | "slide" | "scale" | "zoom-blur" | "slide-blur";

export interface PopupTransition {
  inType: PopupInAnim;
  outType: PopupOutAnim;
  inDuration: Seconds;
  outDuration: Seconds;
  easing: "ease" | "spring";
}

export interface PopupBase {
  id: string;
  at: Seconds; // entrada
  duration: Seconds; // tempo em cena
  source: PopupSource;
  trigger?: PopupTrigger; // por que foi sugerido (ausente se manual)
  transition: PopupTransition;
}

export type SupportPreset =
  | "balloon"
  | "textbox"
  | "logo-card"
  | "photo-card"
  | "photo-plain"
  | "highlight-number"
  | "keyword"
  | "typography";

/** Uma linha da tipografia (destaque): texto com tamanho/peso/cor próprios. */
export interface TypoLine {
  text: string;
  size: number; // px
  weight?: number;
  color?: string;
  /** Estilo avançado próprio desta linha (sobrepõe o estilo geral da tipografia). */
  style?: CaptionStyle;
}

/** TIPO 1 — apoio (pessoa em cena). */
export interface SupportPopup extends PopupBase {
  type: "support";
  preset: SupportPreset;
  content: {
    text?: string;
    imageUrl?: string;
    logoUrl?: string;
    value?: string;
    /** Tipografia em destaque (preset "typography"): linhas empilhadas. */
    typo?: { lines: TypoLine[]; align?: "left" | "center" | "right"; lineGap?: number };
    /** Estilo avançado (mesmo das legendas) aplicado à tipografia — opcional. */
    typoStyle?: CaptionStyle;
  };
  layout: {
    x: number; // 0..100 (%)
    y: number; // 0..100 (%)
    scale: number;
    anchor?: "top" | "bottom" | "left" | "right";
  };
  styleId?: string; // preset visual/tipografia (biblioteca de estilos)

  /**
   * "Popup atrás da pessoa": compõe em 3 camadas (fundo → popup → pessoa recortada).
   * O matting (recorte alpha da pessoa) roda SÓ no trecho [at, at+duration] deste
   * popup — nunca no vídeo inteiro. Padrão desligado (popup na frente, custo zero).
   */
  behindSubject?: boolean;
  /** Modelo de matting (export). Padrão "rvm". Trocável sem mexer na composição. */
  mattingModel?: "rvm" | "birefnet" | "sam2";
  /** Caminho do WebM VP9 com alpha (yuva420p) gerado no render, cacheado por popup. */
  alphaVideoPath?: string;
}

/** TIPO 2 — tela cheia (pessoa sai; tela animada do FLOW ocupa o quadro). */
export interface FullscreenPopup extends PopupBase {
  type: "fullscreen";
  motionPointId?: string;
  placeholder?: { imageUrl?: string; label?: string };
  /**
   * Mídia em tela cheia. `video` = motion do FLOW (mudo, tocado 0→duração);
   * `image` = imagem estática. Compat: se ausente, cai no `placeholder`.
   */
  media?: { kind: "image" | "video"; src: string };
  /** Origem no FLOW (p/ re-sync do time-fit e limpeza). */
  flowPhraseId?: string;
  /** Se true, a pessoa recortada fica POR CIMA da tela cheia (mesma ideia do Tipo 1). */
  behindSubject?: boolean;
}

export type Popup = SupportPopup | FullscreenPopup;

/** Transição padrão suave (spring/ease). */
export const DEFAULT_POPUP_TRANSITION: PopupTransition = {
  inType: "spring",
  outType: "fade",
  inDuration: 0.4,
  outDuration: 0.3,
  easing: "spring",
};

/**
 * LEGENDA MATERIALIZADA — uma linha de legenda como DADO editável.
 *
 * Por padrão as linhas são DERIVADAS da transcrição (buildCaptionLines): o tempo é
 * só "início da 1ª palavra → fim da última". Isso não dá controle manual — não há
 * onde guardar um ajuste. Quando o usuário mexe na camada de legendas da timeline,
 * as linhas são materializadas AQUI (copy-on-write) e passam a mandar: a partir daí
 * preview e render leem `captions`, não a derivação.
 *
 * Tempo de FONTE (igual a cuts/words/popups). Os cortes continuam sendo aplicados
 * na exibição — materializar não congela os cortes, só a linha.
 */
export interface Caption {
  id: string;
  start: Seconds;
  end: Seconds;
  /** Palavras com timestamp — o karaokê destaca a partir daqui. Nunca vazio. */
  words: Word[];
  /**
   * true = a janela foi ajustada à mão. A exibição respeita `start`/`end` mesmo que
   * os cortes removam palavras; sem isso, a janela acompanha as palavras que sobraram.
   */
  locked?: boolean;
}

/** Ponto de motion detectado pela transcrição (3 por padrão), editável. */
export interface MotionPoint {
  id: string;
  at: Seconds;
  /** Tela de design gerada pela API de imagem (Gemini→OpenAI). */
  design?: { provider: string; prompt: string; imageUrl: string };
  /** Animação do Seedance + estado de aprovação humana (obrigatória). */
  motion?: { videoUrl: string; approved: boolean };
}

/** Música de fundo (global): toca sob a fala, com volume ajustável. */
export interface Music {
  file: string;    // referência do asset (nome de arquivo ou URL servida)
  volume: number;  // 0..1 — volume da música sob o áudio original
  start?: number;  // s — início do trecho da música (default 0)
  end?: number;    // s — fim do trecho (default = fim da faixa). O trecho toca em loop.
}

/** O documento inteiro do projeto. Serializável, versionável. */
export interface Timeline {
  version: number;
  source: { fileName: string; durationSec: Seconds };
  transcript: TranscriptSegment[];
  cuts: Cut[];
  zooms: Zoom[];
  popups: Popup[];
  captions: Caption[];
  motionPoints: MotionPoint[];
  /** Correção de cor + LUT, global para o vídeo (v1). Documentos antigos → DEFAULT_COLOR. */
  color: ColorSettings;
  /** Chromakey (fundo verde/azul → cor/imagem/vídeo), global (v1). Antigos → DEFAULT_CHROMA. */
  chroma: ChromaSettings;
  /** FLOW — motion design por IA (momentos → frases → vídeos). Opcional. */
  flow?: FlowState;
  /** Música de fundo (opcional). */
  music?: Music;
}

export function emptyTimeline(fileName: string, durationSec: Seconds): Timeline {
  return {
    version: 1,
    source: { fileName, durationSec },
    transcript: [],
    cuts: [],
    zooms: [],
    popups: [],
    captions: [],
    motionPoints: [],
    color: DEFAULT_COLOR,
    chroma: DEFAULT_CHROMA,
  };
}
