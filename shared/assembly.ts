/**
 * MONTAGEM DE ORIGEM (Montador) — a "timeline estilo Premiere" que produz o vídeo unificado
 * que vira o `sourceVideo` do projeto.
 *
 * Por que existe: o resto do app é SINGLE-SOURCE (transcrição, cortes, legendas, flow e cor são
 * cronometrados em UM vídeo). O Montador é o estágio ANTES disso: junta várias filmagens na
 * pista principal (em sequência) e b-rolls por cima (overlay), e ao "Concluir" o backend ACHATA
 * tudo num MP4 único. Esse MP4 passa a ser o `sourceVideo` e o projeto re-transcreve.
 *
 * MODELO (MVP montagem + b-roll):
 *  - `main`: a pista principal. A ORDEM no array = a ordem de reprodução; os clipes tocam
 *    back-to-back (sem buracos). Cada clipe é aparado por [inPoint, outPoint].
 *  - `brolls`: overlays. Cada um tem `timelineStart` (onde entra na timeline FINAL, já achatada),
 *    fica numa `trackIndex` (0/1) e é MUDO por padrão (só imagem por cima; o áudio é o da
 *    principal). O tempo da timeline final é a soma das durações aparadas da principal.
 *
 * Tudo em SEGUNDOS. Serializável/versionável (mora no EditorDocument.assembly).
 */

export type Seconds = number;

/** Base comum: referência do asset de vídeo + aparo [in, out] dentro do clipe fonte. */
export interface ClipBase {
  id: string;
  /** nome do arquivo do clipe em projects/<id>/assets/ (bare em disco; URL ao hidratar). */
  asset: string;
  /** aparo: início usado dentro do clipe fonte (s). */
  inPoint: Seconds;
  /** aparo: fim usado dentro do clipe fonte (s). `outPoint > inPoint`. */
  outPoint: Seconds;
  /** duração TOTAL do clipe fonte (s) — limite do aparo na UI. */
  sourceDurationSec: Seconds;
}

/** Clipe da pista principal. A posição na timeline é IMPLÍCITA (ordem no array = sequência). */
export type MainClip = ClipBase;

/** Clipe de b-roll (overlay). Posicionado por tempo, numa pista de overlay, mudo por padrão. */
export interface BrollClip extends ClipBase {
  /** pista de overlay: 0 (superior) ou 1. */
  trackIndex: number;
  /** onde o overlay ENTRA na timeline final já achatada (s). */
  timelineStart: Seconds;
  /** true = sem áudio (padrão do b-roll). false = mistura o áudio do b-roll (v2). */
  muted: boolean;
}

/** Número de pistas de overlay (b-roll) no MVP. */
export const BROLL_TRACKS = 2;

/** O documento da montagem. */
export interface Assembly {
  version: number;
  main: MainClip[];
  brolls: BrollClip[];
}

/** Duração aparada de um clipe (s). */
export function clipDuration(c: ClipBase): Seconds {
  return Math.max(0, c.outPoint - c.inPoint);
}

/** Duração total da timeline final = soma da pista principal (os b-rolls não estendem). */
export function assemblyDuration(a: Assembly): Seconds {
  return a.main.reduce((t, c) => t + clipDuration(c), 0);
}

/** Início de cada clipe da principal na timeline final (offsets acumulados). */
export function mainClipOffsets(a: Assembly): Seconds[] {
  const offs: Seconds[] = [];
  let t = 0;
  for (const c of a.main) { offs.push(t); t += clipDuration(c); }
  return offs;
}

/** Montagem vazia. */
export function emptyAssembly(): Assembly {
  return { version: 1, main: [], brolls: [] };
}

/** Todos os assets de vídeo referenciados (pra hidratar/dehidratar/limpar). */
export function assemblyAssets(a: Assembly): string[] {
  return [...a.main, ...a.brolls].map((c) => c.asset);
}
