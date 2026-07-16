/**
 * Estilo da legenda — totalmente editável em tempo real.
 * Serializável (vai pra timeline JSON) e usado tanto no preview quanto no
 * render final (Remotion).
 */
export interface CaptionStyle {
  fontFamily: string;
  fontSize: number; // px
  fontWeight: number;
  letterSpacing: number; // px — espaçamento entre letras
  wordSpacing: number; // px — espaçamento entre palavras
  maxWords: number; // palavras por linha
  posX: number; // 0..100 — posição horizontal do centro da legenda (%)
  posY: number; // 0..100 — posição vertical do centro da legenda (%)
  // karaokê: pinta a palavra; estático: linha inteira numa cor;
  // destaque: caixa de fundo colorida atrás da palavra falada
  mode: "karaoke" | "static" | "highlight";
  colorActive: string; // palavra sendo falada (só no karaokê)
  colorSpoken: string; // palavra já falada / cor base no estático/destaque
  colorUpcoming: string; // palavra ainda não falada
  opacity: number; // 0..1 — opacidade geral da legenda
  shadow: {
    enabled: boolean;
    color: string;
    intensity: number; // blur em px
    opacity: number; // 0..1 — opacidade da sombra
  };
  outline: {
    enabled: boolean;
    color: string;
    width: number; // px
  };
  wordBg: {
    enabled: boolean; // fundo atrás de cada palavra
    color: string;
    opacity: number; // 0..1
    paddingX: number; // px
    paddingY: number; // px
    radius: number; // px
  };
  highlight: {
    // caixa de destaque atrás da palavra ativa (modo "highlight")
    color: string;
    opacity: number; // 0..1
    paddingX: number; // px
    paddingY: number; // px
    radius: number; // px
  };
  entrance: {
    type: "none" | "fade" | "pop" | "slide-up-blur" | "bounce" | "zoom-blur" | "typewriter";
    duration: number; // segundos
  };
  loop: {
    // animação contínua (cíclica) aplicada o tempo todo
    type: "none" | "float" | "turbulence" | "pulse" | "wobble" | "glow";
    intensity: number; // 0..1 — amplitude do efeito
    speed: number; // 0.2..3 — velocidade do ciclo
  };
}

export const DEFAULT_STYLE: CaptionStyle = {
  fontFamily: "system-ui",
  fontSize: 72, // px na resolução de export (1080p) — legível por padrão
  fontWeight: 700,
  letterSpacing: 0,
  wordSpacing: 8, // 8 = espaçamento "normal" (equivale à margem base antiga)
  maxWords: 7,
  posX: 50, // centralizado
  posY: 85, // perto da base
  mode: "karaoke",
  colorActive: "#ffd400",
  colorSpoken: "#ffffff",
  colorUpcoming: "#ffffff80",
  opacity: 1,
  shadow: { enabled: true, color: "#000000", intensity: 6, opacity: 0.9 },
  outline: { enabled: false, color: "#000000", width: 2 },
  wordBg: { enabled: false, color: "#000000", opacity: 0.6, paddingX: 8, paddingY: 2, radius: 6 },
  highlight: { color: "#1a7f37", opacity: 1, paddingX: 8, paddingY: 2, radius: 6 },
  entrance: { type: "none", duration: 0.25 },
  loop: { type: "none", intensity: 0.5, speed: 1 },
};

/** Fontes virais/famosas disponíveis para a legenda (via Google Fonts). */
export const VIRAL_FONTS: { label: string; value: string }[] = [
  { label: "System UI", value: "system-ui" },
  { label: "Anton", value: "'Anton', sans-serif" },
  { label: "Bebas Neue", value: "'Bebas Neue', sans-serif" },
  { label: "Bangers", value: "'Bangers', system-ui" },
  { label: "Luckiest Guy", value: "'Luckiest Guy', system-ui" },
  { label: "Montserrat Black", value: "'Montserrat', sans-serif" },
  { label: "Poppins", value: "'Poppins', sans-serif" },
  { label: "Oswald", value: "'Oswald', sans-serif" },
  { label: "Archivo Black", value: "'Archivo Black', sans-serif" },
  { label: "Fredoka", value: "'Fredoka', system-ui" },
  { label: "Impact", value: "Impact, system-ui" },
  { label: "Permanent Marker", value: "'Permanent Marker', cursive" },
  { label: "Bungee", value: "'Bungee', system-ui" },
  { label: "Titan One", value: "'Titan One', system-ui" },
  { label: "Alfa Slab One", value: "'Alfa Slab One', serif" },
  { label: "Russo One", value: "'Russo One', sans-serif" },
  { label: "Kanit", value: "'Kanit', sans-serif" },
  { label: "Teko", value: "'Teko', sans-serif" },
  { label: "Black Ops One", value: "'Black Ops One', system-ui" },
  { label: "Pacifico", value: "'Pacifico', cursive" },
  { label: "Lobster", value: "'Lobster', cursive" },
  { label: "Caveat", value: "'Caveat', cursive" },
  { label: "Righteous", value: "'Righteous', sans-serif" },
  { label: "Abril Fatface", value: "'Abril Fatface', serif" },
  { label: "Passion One", value: "'Passion One', sans-serif" },
  { label: "Fjalla One", value: "'Fjalla One', sans-serif" },
  { label: "Rubik Mono", value: "'Rubik Mono One', monospace" },
  // — Sans modernas —
  { label: "Inter", value: "'Inter', sans-serif" },
  { label: "Roboto", value: "'Roboto', sans-serif" },
  { label: "Open Sans", value: "'Open Sans', sans-serif" },
  { label: "Lato", value: "'Lato', sans-serif" },
  { label: "Raleway", value: "'Raleway', sans-serif" },
  { label: "Nunito", value: "'Nunito', sans-serif" },
  { label: "Work Sans", value: "'Work Sans', sans-serif" },
  { label: "DM Sans", value: "'DM Sans', sans-serif" },
  { label: "Space Grotesk", value: "'Space Grotesk', sans-serif" },
  { label: "Manrope", value: "'Manrope', sans-serif" },
  { label: "Outfit", value: "'Outfit', sans-serif" },
  { label: "Plus Jakarta Sans", value: "'Plus Jakarta Sans', sans-serif" },
  { label: "Sora", value: "'Sora', sans-serif" },
  { label: "Figtree", value: "'Figtree', sans-serif" },
  { label: "Josefin Sans", value: "'Josefin Sans', sans-serif" },
  { label: "Quicksand", value: "'Quicksand', sans-serif" },
  { label: "Barlow", value: "'Barlow', sans-serif" },
  { label: "Rubik", value: "'Rubik', sans-serif" },
  { label: "Syne", value: "'Syne', sans-serif" },
  // — Display / impacto (virais) —
  { label: "Staatliches", value: "'Staatliches', sans-serif" },
  { label: "Paytone One", value: "'Paytone One', sans-serif" },
  { label: "Bowlby One", value: "'Bowlby One', sans-serif" },
  { label: "Sigmar One", value: "'Sigmar One', sans-serif" },
  { label: "Ultra", value: "'Ultra', serif" },
  { label: "Rowdies", value: "'Rowdies', sans-serif" },
  { label: "Concert One", value: "'Concert One', sans-serif" },
  { label: "Chewy", value: "'Chewy', system-ui" },
  { label: "Baloo 2", value: "'Baloo 2', system-ui" },
  { label: "Unbounded", value: "'Unbounded', system-ui" },
  { label: "Shrikhand", value: "'Shrikhand', system-ui" },
  { label: "Monoton", value: "'Monoton', system-ui" },
  { label: "Orbitron", value: "'Orbitron', sans-serif" },
  { label: "Audiowide", value: "'Audiowide', system-ui" },
  { label: "Press Start 2P", value: "'Press Start 2P', system-ui" },
  // — Serif elegantes —
  { label: "Playfair Display", value: "'Playfair Display', serif" },
  { label: "Merriweather", value: "'Merriweather', serif" },
  { label: "Cormorant Garamond", value: "'Cormorant Garamond', serif" },
  { label: "Libre Baskerville", value: "'Libre Baskerville', serif" },
  { label: "DM Serif Display", value: "'DM Serif Display', serif" },
  { label: "Yeseva One", value: "'Yeseva One', serif" },
  // — Script / manuscritas —
  { label: "Dancing Script", value: "'Dancing Script', cursive" },
  { label: "Great Vibes", value: "'Great Vibes', cursive" },
  { label: "Satisfy", value: "'Satisfy', cursive" },
  { label: "Sacramento", value: "'Sacramento', cursive" },
  { label: "Kaushan Script", value: "'Kaushan Script', cursive" },
  { label: "Yellowtail", value: "'Yellowtail', cursive" },
];

/** Presets prontos embutidos (não apagáveis). */
export const BUILTIN_PRESETS: { name: string; style: CaptionStyle }[] = [
  { name: "Karaokê Amarelo", style: DEFAULT_STYLE },
  {
    name: "Estático Branco",
    style: {
      ...DEFAULT_STYLE,
      mode: "static",
      colorSpoken: "#ffffff",
      shadow: { enabled: true, color: "#000000", intensity: 4, opacity: 1 },
    },
  },
  {
    name: "TikTok Bold",
    style: {
      ...DEFAULT_STYLE,
      fontFamily: "'Montserrat', sans-serif",
      fontSize: 34,
      fontWeight: 900,
      maxWords: 4,
      colorActive: "#00e5ff",
      colorUpcoming: "#ffffffaa",
      shadow: { enabled: true, color: "#000000", intensity: 10, opacity: 1 },
      outline: { enabled: true, color: "#000000", width: 3 },
      entrance: { type: "pop", duration: 0.2 },
    },
  },
  {
    name: "Destaque (caixa)",
    style: {
      ...DEFAULT_STYLE,
      mode: "highlight",
      fontFamily: "'Anton', sans-serif",
      fontSize: 32,
      maxWords: 4,
      colorSpoken: "#ffffff",
      highlight: { color: "#ff2e63", opacity: 1, paddingX: 10, paddingY: 2, radius: 8 },
      entrance: { type: "slide-up-blur", duration: 0.25 },
    },
  },
  {
    name: "Flutuante",
    style: {
      ...DEFAULT_STYLE,
      fontFamily: "'Fredoka', system-ui",
      colorActive: "#ffd400",
      entrance: { type: "pop", duration: 0.2 },
      loop: { type: "float", intensity: 0.6, speed: 1 },
    },
  },
  {
    name: "Turbulento",
    style: {
      ...DEFAULT_STYLE,
      fontFamily: "'Bangers', system-ui",
      fontSize: 32,
      maxWords: 4,
      outline: { enabled: true, color: "#000000", width: 2 },
      entrance: { type: "bounce", duration: 0.3 },
      loop: { type: "turbulence", intensity: 0.7, speed: 1.2 },
    },
  },
  {
    name: "Minimal Sem Sombra",
    style: {
      ...DEFAULT_STYLE,
      mode: "static",
      fontSize: 24,
      fontWeight: 600,
      colorSpoken: "#ffffff",
      shadow: { enabled: false, color: "#000000", intensity: 0, opacity: 0 },
    },
  },
];

const LS_KEY = "fluxo-ouro:caption-presets";

export interface SavedPreset {
  name: string;
  style: CaptionStyle;
}

export function loadUserPresets(): SavedPreset[] {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveUserPresets(presets: SavedPreset[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(presets));
}

/** Converte hex (#rrggbb) + alpha 0..1 em rgba() para a sombra. */
export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Monta o text-shadow CSS a partir do estilo. */
export function shadowCss(style: CaptionStyle): string {
  if (!style.shadow.enabled) return "none";
  const c = hexToRgba(style.shadow.color, style.shadow.opacity);
  return `0 2px ${style.shadow.intensity}px ${c}, 0 0 2px ${c}`;
}

function easeOut(p: number): number {
  return 1 - Math.pow(1 - p, 3);
}

/** easeOutBack — overshoot, dá o "bounce". */
function easeBack(p: number): number {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
}

/** Ruído suave (soma de senos incomensuráveis) ~ wiggle do After Effects. */
function smoothNoise(t: number, seed: number): number {
  return (
    Math.sin(t * 1.3 + seed) * 0.5 +
    Math.sin(t * 2.7 + seed * 1.7) * 0.3 +
    Math.sin(t * 0.7 + seed * 0.3) * 0.2
  );
}

interface Fx {
  opacity?: number;
  filter?: string;
  transform: string; // sempre presente (pode ser vazio)
}

/** Parte da ENTRADA: anima quando a palavra começa a ser falada. */
function entrancePart(style: CaptionStyle, wordStart: number, time: number): Fx {
  if (style.entrance.type === "none") return { transform: "" };
  const p = Math.max(0, Math.min(1, (time - wordStart) / Math.max(style.entrance.duration, 0.001)));
  const e = easeOut(p);
  switch (style.entrance.type) {
    case "fade":
      return { opacity: p, transform: "" };
    case "pop":
      return { opacity: p, transform: `scale(${0.5 + 0.5 * e})` };
    case "slide-up-blur":
      return { opacity: p, transform: `translateY(${(1 - e) * 24}px)`, filter: `blur(${(1 - p) * 8}px)` };
    case "bounce":
      return { opacity: Math.min(1, p * 2), transform: `scale(${0.3 + 0.7 * easeBack(p)})` };
    case "zoom-blur":
      return { opacity: p, transform: `scale(${1.6 - 0.6 * e})`, filter: `blur(${(1 - p) * 12}px)` };
    case "typewriter":
      // aparece "de uma vez" quando atinge o start (efeito de digitação por palavra)
      return { opacity: p < 1 ? 0 : 1, transform: "" };
  }
}

/** Parte do LOOP: animação contínua/cíclica enquanto a palavra está visível. */
function loopPart(style: CaptionStyle, index: number, time: number): Fx {
  const { type, intensity, speed } = style.loop;
  if (type === "none") return { transform: "" };
  const t = time * speed;
  const A = intensity;
  switch (type) {
    case "float": {
      const ty = Math.sin(t * 2 + index * 0.7) * 6 * A;
      return { transform: `translateY(${ty}px)` };
    }
    case "turbulence": {
      const nx = smoothNoise(t * 2, index * 12.9) * 5 * A;
      const ny = smoothNoise(t * 2, index * 7.3 + 50) * 5 * A;
      const nr = smoothNoise(t * 2, index * 3.1 + 99) * 4 * A;
      return { transform: `translate(${nx}px, ${ny}px) rotate(${nr}deg)` };
    }
    case "pulse": {
      const s = 1 + Math.sin(t * 4 + index * 0.5) * 0.08 * A;
      return { transform: `scale(${s})` };
    }
    case "wobble": {
      const r = Math.sin(t * 4 + index * 0.6) * 6 * A;
      return { transform: `rotate(${r}deg)` };
    }
    case "glow": {
      const g = (Math.sin(t * 3 + index * 0.4) * 0.5 + 0.5) * A;
      return { transform: "", filter: `drop-shadow(0 0 ${4 + g * 12}px rgba(255,255,255,${0.4 + g * 0.6}))` };
    }
  }
}

/**
 * Estilo dinâmico final de uma palavra: combina ENTRADA + LOOP.
 * Recalculado a cada frame (driven por `time`).
 */
/** Estilo dinâmico (subconjunto de CSS) — evita depender de React no shared. */
export interface WordFxStyle {
  opacity?: number;
  transform?: string;
  filter?: string;
}

export function wordFx(
  style: CaptionStyle,
  wordStart: number,
  index: number,
  time: number,
): WordFxStyle {
  const ent = entrancePart(style, wordStart, time);
  const lp = loopPart(style, index, time);
  const transform = `${ent.transform} ${lp.transform}`.trim();
  const filters = [ent.filter, lp.filter].filter(Boolean).join(" ");
  return {
    ...(ent.opacity !== undefined ? { opacity: ent.opacity } : {}),
    ...(transform ? { transform } : {}),
    ...(filters ? { filter: filters } : {}),
  };
}
