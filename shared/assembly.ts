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

/**
 * TRANSFORMAÇÃO de um clipe (estilo "Effect Controls" do Premiere). Aplicada por cima do
 * enquadramento base (principal = contido/letterbox; b-roll = cobrir/crop). Os defaults
 * são NEUTROS: um clipe com o transform padrão sai idêntico ao comportamento antigo.
 *
 *  - `scale`   1 = 100% (multiplica o tamanho base).
 *  - `x`,`y`   deslocamento, em FRAÇÃO do frame (0 = centrado; 0.5 = meia tela). x>0 → direita, y>0 → baixo.
 *  - `opacity` 0..1.
 *  - `speed`   1 = normal. Muda a DURAÇÃO do clipe na timeline (dur = aparo/velocidade) e o áudio acelera junto.
 */
export interface ClipTransform {
  scale: number;
  x: number;
  y: number;
  opacity: number;
  speed: number;
}

export const DEFAULT_TRANSFORM: ClipTransform = { scale: 1, x: 0, y: 0, opacity: 1, speed: 1 };

/** Transform efetivo de um clipe (preenche defaults p/ clipes antigos sem o campo). */
export function getTransform(c: { transform?: Partial<ClipTransform> }): ClipTransform {
  const t = c.transform ?? {};
  return {
    scale: t.scale != null && t.scale > 0 ? t.scale : 1,
    x: t.x ?? 0,
    y: t.y ?? 0,
    opacity: t.opacity != null ? t.opacity : 1,
    speed: t.speed != null && t.speed > 0 ? t.speed : 1,
  };
}

/** true se o transform é neutro (nada a aplicar) — habilita o caminho rápido do flatten. */
export function isIdentityTransform(t: ClipTransform): boolean {
  return t.scale === 1 && t.x === 0 && t.y === 0 && t.opacity === 1 && t.speed === 1;
}

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
  /** transformação estilo Premiere (escala/posição/opacidade/velocidade). Ausente = neutro. */
  transform?: ClipTransform;
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

/** Duração do aparo no clipe FONTE (s), sem velocidade. */
export function sourceDuration(c: ClipBase): Seconds {
  return Math.max(0, c.outPoint - c.inPoint);
}

/** Duração do clipe na TIMELINE (s) — o aparo dividido pela velocidade. */
export function clipDuration(c: ClipBase): Seconds {
  const speed = getTransform(c).speed;
  return Math.max(0, (c.outPoint - c.inPoint) / speed);
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

// ─────────────────────── REALOCAÇÃO DE TEMPO ENTRE MONTAGENS ───────────────────────
// O Montador refaz o vídeo de origem, mas o projeto (cortes, legendas, zooms, popups,
// FLOW) está cronometrado no vídeo ANTIGO. Em vez de RESETAR, a gente REALOCA: cada
// clipe diz de onde veio — (asset, [inPoint,outPoint]) — então o MATERIAL é a identidade
// estável entre as duas montagens:
//
//     tempo ANTIGO ──▶ (asset, tempo no material) ──▶ tempo NOVO
//
// Trecho que continua na montagem nova → o tempo é deslocado/comprimido junto.
// Trecho REMOVIDO → não tem destino (null) e só o que estava nele é descartado.
// Se nada mudou, o mapa é a identidade e o projeto inteiro fica intocado.

/** Um trecho da timeline achatada e o material de onde ele veio. */
export interface TimelineSpan {
  tStart: Seconds; tEnd: Seconds;  // na timeline achatada (pós-velocidade)
  asset: string;                    // identidade do material (nome do arquivo)
  srcIn: Seconds;                   // tempo no material no início do span
  speed: number;
}

/** Nome "bare" do asset — aceita URL hidratada ou nome puro (mesma identidade). */
export function assetKey(asset: string): string {
  return String(asset).replace(/.*\//, "");
}

/** Spans da pista PRINCIPAL — é ela que define o tempo do vídeo achatado. */
export function mainSpans(a: Assembly): TimelineSpan[] {
  const spans: TimelineSpan[] = [];
  let t = 0;
  for (const c of a.main) {
    const d = clipDuration(c); // já considera a velocidade
    if (d <= 0) continue;
    spans.push({ tStart: t, tEnd: t + d, asset: assetKey(c.asset), srcIn: c.inPoint, speed: getTransform(c).speed });
    t += d;
  }
  return spans;
}

/** Fim do trecho no MATERIAL coberto por um span. */
const spanSrcOut = (s: TimelineSpan) => s.srcIn + (s.tEnd - s.tStart) * s.speed;

// NAS EMENDAS, o mesmo instante pertence ao FIM de um trecho e ao COMEÇO do seguinte.
// Buscamos primeiro uma correspondência ESTRITA (dentro do trecho, fim exclusivo) e só
// depois aceitamos o limite. Sem isso, um instante de emenda casaria com o fim do trecho
// anterior e uma palavra que começa ali seria esticada por cima do material inserido.

/** timeline → material (asset + tempo dentro do material). */
function toMaterial(spans: TimelineSpan[], t: Seconds): { asset: string; src: Seconds } | null {
  const hit = (s: TimelineSpan) => ({ asset: s.asset, src: s.srcIn + (t - s.tStart) * s.speed });
  for (const s of spans) if (t >= s.tStart - 1e-6 && t < s.tEnd - 1e-6) return hit(s);
  for (const s of spans) if (t >= s.tStart - 1e-6 && t <= s.tEnd + 1e-6) return hit(s);
  return null;
}

/** material → timeline (trecho que contém aquele pedaço do material). */
function toTimeline(spans: TimelineSpan[], asset: string, src: Seconds): Seconds | null {
  const hit = (s: TimelineSpan) => s.tStart + (src - s.srcIn) / s.speed;
  for (const s of spans) {
    if (s.asset !== asset) continue;
    if (src >= s.srcIn - 1e-6 && src < spanSrcOut(s) - 1e-6) return hit(s);
  }
  for (const s of spans) {
    if (s.asset !== asset) continue;
    if (src >= s.srcIn - 1e-6 && src <= spanSrcOut(s) + 1e-6) return hit(s);
  }
  return null;
}

/**
 * Tempo na montagem ANTIGA → tempo na montagem NOVA.
 * `null` = aquele material não está mais na montagem (o trecho foi removido).
 */
export function remapTimeBetween(oldSpans: TimelineSpan[], newSpans: TimelineSpan[], t: Seconds): Seconds | null {
  const m = toMaterial(oldSpans, t);
  if (!m) return null;
  return toTimeline(newSpans, m.asset, m.src);
}

/** Subtrai intervalos de um intervalo base (aritmética de intervalos, em segundos). */
function subtractIntervals(base: [number, number], subs: Array<[number, number]>): Array<[number, number]> {
  let parts: Array<[number, number]> = [base];
  for (const [a, b] of subs) {
    const next: Array<[number, number]> = [];
    for (const [s, e] of parts) {
      if (b <= s || a >= e) { next.push([s, e]); continue; }  // sem interseção
      if (a > s) next.push([s, Math.min(a, e)]);
      if (b < e) next.push([Math.max(b, s), e]);
    }
    parts = next;
  }
  return parts.filter(([s, e]) => e - s > 0.05);
}

/**
 * Trechos da timeline NOVA cujo material NÃO existia na montagem antiga — é o material
 * novo, o único que precisa ser transcrito (o resto é realocado do que já existe).
 */
export function newMaterialRegions(oldSpans: TimelineSpan[], newSpans: TimelineSpan[]): Array<{ start: Seconds; end: Seconds }> {
  const out: Array<{ start: Seconds; end: Seconds }> = [];
  for (const s of newSpans) {
    const subs = oldSpans.filter((o) => o.asset === s.asset).map((o) => [o.srcIn, spanSrcOut(o)] as [number, number]);
    for (const [a, b] of subtractIntervals([s.srcIn, spanSrcOut(s)], subs)) {
      out.push({ start: s.tStart + (a - s.srcIn) / s.speed, end: s.tStart + (b - s.srcIn) / s.speed });
    }
  }
  // funde regiões coladas (evita fatiar a transcrição em pedacinhos)
  out.sort((x, y) => x.start - y.start);
  const merged: Array<{ start: Seconds; end: Seconds }> = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < 0.05) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged.filter((r) => r.end - r.start > 0.15);
}
