import type { CSSProperties, ReactNode } from "react";

/**
 * Set de ícones do editor (SVG stroke, herda currentColor). Mesma linguagem do mockup:
 * traço fino, cantos arredondados, 24×24. Uso: <Icon name="script" size={15} />.
 */
export type IconName =
  | "script" | "cut" | "color" | "chroma" | "music" | "motion" | "export" | "popup"
  | "undo" | "redo" | "save" | "folder" | "assembly"
  | "target" | "scissor" | "warn" | "sync" | "text";

const GLYPHS: Record<IconName, ReactNode> = {
  script: (<>
    <path d="M5 3h9l5 5v13H5z" /><path d="M14 3v5h5" /><path d="M8 12h8M8 16h8M8 8.5h4" />
  </>),
  cut: (<>
    <circle cx="6" cy="6" r="2.3" /><circle cx="6" cy="18" r="2.3" /><path d="M8 7l12 10M8 17L20 7" />
  </>),
  color: (<>
    <circle cx="12" cy="12" r="8.5" /><path d="M12 3.5v17M3.5 12h17" opacity="0.55" />
  </>),
  chroma: (<>
    <rect x="3.2" y="4.5" width="17.6" height="15" rx="2.2" /><path d="M4 15l5-6 4 4 3-3 4 5" />
  </>),
  music: (<>
    <path d="M9 18V6l10-2v12" /><circle cx="6.5" cy="18" r="2.4" /><circle cx="16.5" cy="16" r="2.4" />
  </>),
  // círculo + dois rastros em crescente (ícone de motion/echo) — PREENCHIDO, não traço
  motion: (<>
    <circle cx="6" cy="12" r="5.2" fill="currentColor" stroke="none" />
    <path d="M12 6.8A5.2 5.2 0 0 1 12 17.2A7 7 0 0 0 12 6.8Z" fill="currentColor" stroke="none" />
    <path d="M16.4 6.8A5.2 5.2 0 0 1 16.4 17.2A7 7 0 0 0 16.4 6.8Z" fill="currentColor" stroke="none" />
  </>),
  popup: (<>
    <path d="M4 5h16v10H10l-4 4v-4H4z" /><path d="M8 10h8M8 7.5h5" opacity="0.75" />
  </>),
  export: (<>
    <path d="M12 15V4M8 8l4-4 4 4" /><path d="M5 15v4h14v-4" />
  </>),
  undo: (<>
    <path d="M8 6L3 11l5 5" /><path d="M3 11h11a6 6 0 016 6v0" />
  </>),
  redo: (<>
    <path d="M16 6l5 5-5 5" /><path d="M21 11H10a6 6 0 00-6 6v0" />
  </>),
  save: (<>
    <path d="M5 4h11l3 3v13H5z" /><path d="M8 4v5h7V4M8 20v-6h8v6" />
  </>),
  folder: (<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />),
  assembly: (<>
    <rect x="3" y="6" width="7" height="12" rx="1.6" /><rect x="14" y="6" width="7" height="12" rx="1.6" /><path d="M10 12h4" />
  </>),
  target: (<>
    <circle cx="12" cy="12" r="7.5" /><circle cx="12" cy="12" r="2.3" fill="currentColor" stroke="none" />
  </>),
  scissor: (<>
    <circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><path d="M8 7l12 10M8 17L20 7" />
  </>),
  warn: (<>
    <path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17h.01" />
  </>),
  sync: (<>
    <path d="M4 12a8 8 0 0113-6l3 1" /><path d="M20 12a8 8 0 01-13 6l-3-1" />
  </>),
  text: (<path d="M5 6h14M12 6v13M8.5 19h7" />),
};

export function Icon({ name, size = 16, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"
      style={{ display: "block", flex: "0 0 auto", ...style }} aria-hidden>
      {GLYPHS[name]}
    </svg>
  );
}
