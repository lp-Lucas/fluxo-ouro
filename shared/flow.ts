/**
 * Módulo FLOW — motion design assistido por IA.
 *
 * A IA (Claude) lê a transcrição e identifica MOMENTOS onde motion design agrega
 * (números, listas, perguntas retóricas, marcas, CTAs). Cada momento é segmentado
 * em FRASES (por índice de palavra). Cada frase vira UM vídeo de motion, gerado a
 * partir de uma imagem (OpenAI) animada (Google image-to-video) e ajustado no tempo
 * (time-fit) pra caber exatamente na duração da frase falada. Os vídeos entram na
 * timeline como popups fullscreen (Tipo 2).
 *
 * REGRA DE OURO (herdada do autocut): a IA DECIDE por índice de palavra; os TEMPOS
 * são sempre dos TranscriptWord.start/end — a IA nunca inventa timestamp.
 */

export type FlowPhraseStatus =
  | "detected"      // frase identificada, sem design ainda
  | "designing"     // gerando imagem
  | "design_ready"  // imagem gerada, aguardando aprovação
  | "approved"      // imagem aprovada
  | "animating"     // gerando vídeo
  | "video_ready"   // vídeo gerado + time-fit ok
  | "placed"        // popup criado na timeline
  | "error";

/** Estratégia do time-fit (ver backend/src/flow/timeFit.ts). */
export type FitStrategy = "speed" | "trim" | "hold";

/** Proporção da tela de design/motion. Default vertical (reels). */
export type FlowAspect = "9:16" | "16:9" | "1:1";

/** Dimensões + tamanho aceito pelo gpt-image para cada proporção. */
export function aspectDims(a: FlowAspect = "9:16"): { w: number; h: number; gptSize: string } {
  if (a === "16:9") return { w: 1920, h: 1080, gptSize: "1536x1024" };
  if (a === "1:1") return { w: 1080, h: 1080, gptSize: "1024x1024" };
  return { w: 1080, h: 1920, gptSize: "1024x1536" }; // 9:16 (default)
}

/**
 * Tag de uma imagem de referência. "serie" é INTERNA (não aparece na UI): é uma tela
 * já APROVADA deste mesmo vídeo, anexada automaticamente às próximas gerações pra
 * manter a COESÃO (mesma fonte/cor/estilo em todas as telas do vídeo).
 */
export type DesignRefTag = "logo" | "estilo" | "referencia" | "esboco" | "serie";
export const DESIGN_REF_TAGS: { id: DesignRefTag; label: string; hint: string }[] = [
  { id: "logo", label: "logo do cliente", hint: "a logo que deve estar presente na tela (sem alterar)" },
  { id: "estilo", label: "estilo de design", hint: "replica o estilo visual desta tela (look & feel)" },
  { id: "referencia", label: "elemento (replicar na cena)", hint: "este elemento é REPLICADO fielmente na tela (não é reimaginado) — muda só se você pedir" },
  { id: "esboco", label: "esboço (layout)", hint: "define onde ficam o texto, os elementos e a logo; cores/estilo vêm da identidade" },
];

// ───────────────────────── IDENTIDADE DO PROJETO ─────────────────────────
// Escolhida UMA vez, PESO MÁXIMO em todos os designs: cores, fonte, botões e
// ícones + imagens de estilo/logo. Os passos seguintes só APLICAM essa identidade.

export interface IdentityOption { id: string; nome: string; prompt: string; css?: string }

/** FONTES REAIS — o prompt cita a fonte pelo NOME (o gpt-image conhece as populares). */
export const IDENTITY_FONTES: IdentityOption[] = [
  { id: "inter", nome: "Inter", prompt: 'the font "Inter" — clean modern geometric sans-serif', css: "'Inter', sans-serif" },
  { id: "sfpro", nome: "SF Pro (Apple)", prompt: 'the font "SF Pro Display" (Apple system font) — premium neutral sans-serif', css: "-apple-system, 'Segoe UI', sans-serif" },
  { id: "montserrat", nome: "Montserrat", prompt: 'the font "Montserrat" — geometric sans-serif with strong personality', css: "'Montserrat', sans-serif" },
  { id: "poppins", nome: "Poppins", prompt: 'the font "Poppins" — rounded geometric sans-serif, friendly and modern', css: "'Poppins', sans-serif" },
  { id: "roboto", nome: "Roboto", prompt: 'the font "Roboto" — neutral grotesque sans-serif', css: "'Roboto', sans-serif" },
  { id: "bebas", nome: "Bebas Neue", prompt: 'the font "Bebas Neue" — tall condensed uppercase display, high impact', css: "'Bebas Neue', sans-serif" },
  { id: "oswald", nome: "Oswald", prompt: 'the font "Oswald" — condensed sans-serif, editorial impact', css: "'Oswald', sans-serif" },
  { id: "anton", nome: "Anton", prompt: 'the font "Anton" — ultra-bold condensed display, maximum punch', css: "'Anton', sans-serif" },
  { id: "nunito", nome: "Nunito", prompt: 'the font "Nunito" — rounded friendly sans-serif', css: "'Nunito', sans-serif" },
  { id: "playfair", nome: "Playfair Display", prompt: 'the font "Playfair Display" — elegant editorial serif with contrast', css: "'Playfair Display', serif" },
  { id: "dmserif", nome: "DM Serif Display", prompt: 'the font "DM Serif Display" — refined modern serif for display', css: "'DM Serif Display', serif" },
];
export const IDENTITY_BOTOES: IdentityOption[] = [
  { id: "pill", nome: "Pill (100% arredondado)", prompt: "fully rounded pill-shaped buttons and badges" },
  { id: "arredondado", nome: "Cantos arredondados", prompt: "soft rounded-corner buttons (~12-16px radius)" },
  { id: "reto", nome: "Cantos retos", prompt: "sharp square-corner buttons, flat and minimal" },
  { id: "glass", nome: "Vidro (glassmorphism)", prompt: "frosted-glass buttons with subtle 1px light border" },
];
export const IDENTITY_ICONES: IdentityOption[] = [
  { id: "flat", nome: "Flat minimal", prompt: "flat minimal solid icons" },
  { id: "outline", nome: "Outline fino", prompt: "thin outline stroke icons" },
  { id: "3d", nome: "3D render", prompt: "soft photorealistic 3D rendered icons" },
  { id: "glass", nome: "Vidro/cristal", prompt: "glassy translucent crystal icons" },
];

/** Identidade fixa do projeto — escolhas estruturadas + imagens (estilo/logo). */
export interface FlowIdentity {
  cores?: string;      // descrição livre: "fundo azul-marinho escuro, acento azul elétrico #1a44ff, texto branco"
  fonteId?: string;    // IDENTITY_FONTES
  botoesId?: string;   // IDENTITY_BOTOES
  iconesId?: string;   // IDENTITY_ICONES
  refs: FlowDesignRef[]; // imagens: estilo (telas da marca) + logo
  /**
   * ESTILO EXTRAÍDO por visão (EN): descrição precisa do look da referência de estilo.
   * Com isso a imagem de estilo NÃO vai pro gpt-image (que copiaria o conteúdo dela) —
   * o estilo entra como texto e o modelo constrói uma tela NOVA com aquela cara.
   */
  styleDesc?: string;
  /** id da ref de ESTILO que gerou o `styleDesc` — chave de invalidação: se a imagem de
   *  estilo muda (id diferente), o styleDesc está velho e é re-derivado na próxima autoria. */
  styleDescRefId?: string;
}
export function emptyIdentity(): FlowIdentity { return { refs: [] }; }

const idOpt = (list: IdentityOption[], id?: string) => list.find((o) => o.id === id);

/**
 * Bloco (EN) da identidade p/ os prompts de design — SEMPRE no topo, PESO MÁXIMO.
 * Vazio se nada foi definido (aí valem só as referências visuais de estilo).
 */
export function identityToPrompt(idt?: FlowIdentity): string {
  if (!idt) return "";
  const linhas: string[] = [];
  if (idt.styleDesc?.trim()) linhas.push(`DESIGN STYLE (extracted from the brand's style reference — the whole screen must look like this): ${idt.styleDesc.trim()}`);
  if (idt.cores?.trim()) linhas.push(`COLOR LAW (strict): the project colors are ${idt.cores.trim()}. These are the ONLY hues allowed anywhere on screen (background, text, banners, accents, glows). Any other color family (e.g. pink, purple, green, teal) is an ERROR — do not use it. ELEMENTO images keep their own colors, but they never change the screen's palette.`);
  const f = idOpt(IDENTITY_FONTES, idt.fonteId); if (f) linhas.push(`Typography: ${f.prompt}.`);
  const b = idOpt(IDENTITY_BOTOES, idt.botoesId); if (b) linhas.push(`Buttons/badges: ${b.prompt}.`);
  const i = idOpt(IDENTITY_ICONES, idt.iconesId); if (i) linhas.push(`Icons: ${i.prompt}.`);
  if (linhas.length === 0) return "";
  return [
    "PROJECT IDENTITY — MAXIMUM PRIORITY. These choices are FIXED and override everything else (references, layout and scene description). Every element on screen obeys them:",
    ...linhas.map((l) => `- ${l}`),
    "Everything CREATED for the scene (background, text, buttons, icons, cards) obeys this identity. EXCEPTION: attached ELEMENTO images are replicated faithfully as they are — never restyled unless the scene description explicitly asks.",
  ].join("\n");
}

/**
 * COLOR LAW a partir de UM campo (fluxo novo do FLOW): as cores principais viram a única regra
 * de cor. Mantém o marcador "PROJECT IDENTITY" (o guard/re-injeção do autor depende dele).
 * Substitui o `identityToPrompt` inteiro no fluxo novo — sem fontes/botões/ícones/estilo-de-projeto.
 * Vazio se não houver cores.
 */
export function colorLaw(cores?: string): string {
  if (!cores?.trim()) return "";
  return [
    "PROJECT IDENTITY — MAXIMUM PRIORITY.",
    `- COLOR LAW (strict): the ONLY colors allowed anywhere on screen (background, text, banners, accents, glows) are ${cores.trim()}. Any other color family is an ERROR — do not use it. Reference images keep their own colors but never change the screen's palette.`,
    "The style reference informs TYPOGRAPHY and MATERIAL, NEVER color.",
  ].join("\n");
}

/** Imagem de referência (data URL ou asset), com uma tag que diz o papel dela. */
export interface FlowDesignRef {
  id: string;
  tag: DesignRefTag;
  src: string;   // data URL (upload) ou URL de asset
  name?: string;
}

/** Mensagem do CHAT DE DESIGN (estilo ChatGPT): usuário manda texto+imagens; a IA devolve imagem. */
export interface FlowChatMsg {
  id: string;
  role: "user" | "assistant";
  text?: string;
  images?: string[]; // user: data URLs anexadas; assistant: URL do asset gerado
}

/** Uma frase dentro de um momento — cada frase vira UM vídeo de motion. */
export interface FlowPhrase {
  id: string;
  wordStart: number;       // índice de palavra na transcrição (verdade de tempo)
  wordEnd: number;
  text: string;            // texto da frase (derivado das palavras, cacheado p/ UI)
  aspect?: FlowAspect;     // proporção da tela (default 9:16)
  layoutTemplateId?: string; // layout de rascunho padrão escolhido (FLOW_LAYOUT_TEMPLATES)
  designUserPrompt?: string; // como o usuário quer a tela (linguagem natural, PT-BR)
  designRefs?: FlowDesignRef[]; // imagens de referência com tags (logo/estilo/etc)
  designPresetId?: string; // preset de design (opcional, atalho de estilo)
  designPrompt?: string;   // prompt final (IA) usado na imagem (editável)
  designSeed?: number;     // "semente" p/ forçar variação nova (fura o cache do backend)
  imagePath?: string;      // asset escolhido (ref por nome de arquivo em assets/flow/)
  imageOptions?: string[]; // variações geradas na mesma chamada — o usuário escolhe uma
  designChat?: FlowChatMsg[]; // conversa do design (estilo ChatGPT) desta frase
  esboco?: string;            // snapshot do canvas de esboço (tldraw JSON) — blueprint da tela
  imageApproved?: boolean;
  motionUserPrompt?: string;  // o que o usuário pediu, em linguagem natural
  motionModelPrompt?: string; // prompt técnico gerado pelo Claude p/ o modelo de vídeo
  videoPath?: string;         // vídeo gerado (bruto, antes do time-fit)
  overrideDuration?: number;  // tempo de tela manual (s) — o usuário força; senão = fala
  fittedVideoPath?: string;   // vídeo pós time-fit (o que entra na timeline)
  fitInfo?: { rawDuration: number; targetDuration: number; speed: number; strategy: FitStrategy };
  /**
   * SEM MOTION: a frase é EXCLUÍDA do vídeo final — nesse trecho o vídeo base aparece
   * (o motion abre um "buraco" e volta na próxima frase ligada). O design/vídeo já feito
   * é preservado (só não entra na timeline); reativar traz tudo de volta.
   */
  skipMotion?: boolean;
  /** Motion PRONTO subido pelo usuário (sem IA): pula design/animação, cai em video_ready. */
  motionUploaded?: boolean;
  status: FlowPhraseStatus;
  error?: string;
}

/**
 * Modo de animação de um momento:
 * - "solta": cada frase é um clipe independente (fundo vazio → design). Método atual.
 * - "continua": clipes ENCADEADOS (método MotionIA §4.1) — o design da frase N é o
 *   START frame do clipe N+1 e o design N+1 é o END frame. A emenda some por
 *   construção: um movimento contínuo atravessa todas as telas do momento.
 */
// "solta" = entrada independente (IA se FLOW_AI_ENTRANCE, senão local). "continua" =
// transição encadeada A→B (IA por visão). "texto" = animação LOCAL por ffmpeg (design
// sobe + fade, texto perfeito, sem IA) — ideal pra telas só de texto.
export type FlowAnimMode = "solta" | "continua" | "texto";

/** Um momento de motion detectado pela IA (agrupa 1..n frases). */
export interface FlowMoment {
  id: string;
  wordStart: number;  // índices de palavra na transcrição (fonte da verdade de tempo)
  wordEnd: number;
  reason: string;     // justificativa curta da IA (PT-BR), mostrada ao usuário
  animMode?: FlowAnimMode; // default "solta"
  phrases: FlowPhrase[];
}

export interface FlowState {
  moments: FlowMoment[];
  /** ids dos popups criados na timeline a partir do FLOW (p/ re-sync e limpeza). */
  placedPopupIds: string[];
  /**
   * IDENTIDADE do projeto — definida PRIMEIRO, peso máximo em todos os designs:
   * cores, fonte, botões, ícones + imagens de estilo/logo. Por frase a pessoa só
   * mostra COMO aplicar essa identidade num layout (elementos + esboço + cena).
   */
  identity?: FlowIdentity;
  /** @deprecated migrado para identity.refs (mantido p/ docs antigos). */
  brandRefs?: FlowDesignRef[];
}

export function emptyFlow(): FlowState {
  return { moments: [], placedPopupIds: [], identity: emptyIdentity() };
}

/** Identidade efetiva (migra brandRefs antigos p/ identity.refs na leitura). */
export function getIdentity(f?: FlowState): FlowIdentity {
  if (!f) return emptyIdentity();
  if (f.identity) return { ...f.identity, refs: f.identity.refs?.length ? f.identity.refs : (f.brandRefs ?? []) };
  return { refs: f.brandRefs ?? [] };
}

/**
 * Preset de design: template de estilo. O `promptBase` recebe o texto da frase e
 * as instruções de composição (1920×1080, área segura, contraste alto, o TEXTO da
 * frase é o elemento central). `{TEXTO}` é substituído pelo texto da frase.
 */
export interface FlowDesignPreset {
  id: string;
  nome: string;
  descricao: string;
  promptBase: string;
  thumb?: string;
}

const COMPOSICAO =
  "Composition: 1920x1080 (16:9), the phrase text is the CENTRAL hero element, large and perfectly legible, " +
  "high contrast, generous safe margins (text never cropped or touching edges), no watermark, no UI, no extra paragraphs. " +
  "Phrase: \"{TEXTO}\".";

export const FLOW_DESIGN_PRESETS: FlowDesignPreset[] = [
  {
    id: "bold-dark",
    nome: "Bold tipográfico escuro",
    descricao: "Fundo escuro, tipografia pesada e enorme, um respingo de cor de destaque.",
    promptBase: `Bold typographic poster, very dark background (near-black), massive heavy sans-serif type, a single vivid accent color highlight. ${COMPOSICAO}`,
  },
  {
    id: "glass-light",
    nome: "Glassmorphism claro",
    descricao: "Cartão de vidro fosco sobre gradiente claro e suave.",
    promptBase: `Modern glassmorphism card, frosted translucent panel with soft blur, light pastel gradient background, subtle shadows, clean rounded type. ${COMPOSICAO}`,
  },
  {
    id: "neon-tech",
    nome: "Neon / tech",
    descricao: "Estética tech escura com neon, grid e brilho.",
    promptBase: `Dark tech aesthetic, neon glow (cyan/magenta), subtle grid lines, futuristic HUD vibe, glowing edges around the type. ${COMPOSICAO}`,
  },
  {
    id: "minimal-editorial",
    nome: "Minimal editorial",
    descricao: "Muito espaço em branco, tipografia serifada elegante, editorial.",
    promptBase: `Minimal editorial layout, lots of white space, elegant refined serif typography, restrained palette, magazine-like composition. ${COMPOSICAO}`,
  },
  {
    id: "infographic-flat",
    nome: "Infográfico flat",
    descricao: "Ilustração flat colorida com ícones simples de apoio.",
    promptBase: `Flat colorful infographic style, simple supporting flat icons/shapes, bright friendly palette, clear hierarchy with the phrase as headline. ${COMPOSICAO}`,
  },
];

export function getFlowPreset(id: string | undefined): FlowDesignPreset | undefined {
  return FLOW_DESIGN_PRESETS.find((p) => p.id === id);
}

/**
 * Layouts de rascunho PADRÃO (esboços) — a pessoa escolhe um por frase e a IA usa
 * só o LAYOUT dele (posições/estrutura); cores/estilo vêm da identidade + descrição.
 * As imagens ficam em frontend/public/flow-layouts/ (soltas por quem monta o app).
 */
export interface FlowLayoutTemplate { id: string; nome: string; url: string; }
export const FLOW_LAYOUT_TEMPLATES: FlowLayoutTemplate[] = [
  { id: "layout-1", nome: "Layout 1", url: "/flow-layouts/layout-1.png" },
  { id: "layout-2", nome: "Layout 2", url: "/flow-layouts/layout-2.png" },
  { id: "layout-3", nome: "Layout 3", url: "/flow-layouts/layout-3.png" },
];
export function getLayoutTemplate(id: string | undefined): FlowLayoutTemplate | undefined {
  return FLOW_LAYOUT_TEMPLATES.find((t) => t.id === id);
}

/** Monta o prompt de imagem a partir do preset + texto da frase (editável depois). */
export function buildDesignPrompt(presetId: string | undefined, texto: string): string {
  const preset = getFlowPreset(presetId) ?? FLOW_DESIGN_PRESETS[0];
  return preset.promptBase.replace("{TEXTO}", texto.trim());
}
