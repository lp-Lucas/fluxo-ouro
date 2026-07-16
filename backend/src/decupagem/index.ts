import type { Word } from "../../../shared/timeline.js";
import type { VadSegment } from "./signal/vad.js";
import type { EnergyTrack } from "./signal/energy.js";
import type { CutInterval } from "./semantic/types.js";
import { runCopyLayer } from "./semantic/copyLayer.js";
import { silenceLayer, type SilenceOpts } from "./plan/silenceLayer.js";
import { planCuts, type MsRange } from "./plan/index.js";
import { reasonSummary } from "./reasons.js";

const wStart = (w: Word) => w.vadStartMs ?? Math.round(w.start * 1000);
const wEnd = (w: Word) => w.vadEndMs ?? Math.round(w.end * 1000);

/** Zonas de retake (índices de palavra) → intervalos em ms. */
export function zonesToMs(words: Word[], zones: { from: number; to: number }[]): MsRange[] {
  return zones.map((z) => ({ startMs: wStart(words[z.from]), endMs: wEnd(words[z.to]) }));
}

/**
 * FASE 5 — DECUPAGEM: UM BOTÃO. Camada DETERMINÍSTICA (retorno imediato do botão):
 *  copy (Gotoh + guarda de mishear + alucinação apertada) + SILÊNCIO (dead-air do VAD)
 *  → merge/snap/score (threshold 0.85) → rótulo PT-BR.
 *
 * A camada de IA (retakes/falsos começos) roda DEPOIS, em job, e volta como patch que
 * re-planeja tudo junto (`planWithAi`). Sem copy, a IA é a ÚNICA camada de conteúdo — não
 * é opcional (ver server /api/decupagem + polling).
 *
 * NUNCA FALHA EM SILÊNCIO: qualquer erro vira `error` com `cuts: []`.
 */

export interface DecupagemResult {
  cuts: CutInterval[];          // applied && ≥0.85, com label PT-BR (retorno imediato)
  all: CutInterval[];           // todos avaliados (applied setado) — revisão manual
  needsAi: boolean;
  retakeCandidates: number[];
  retakeZones: { from: number; to: number; via?: "periodicidade" | "cabeca" | "bloco" | "ambos"; cut?: { startMs: number; endMs: number } }[]; // a IA decide livre dentro delas
  rawIntervals: CutInterval[];  // pré-plano (conteúdo + silêncio) — o patch de IA re-planeja com isto
  error?: string;
}

/**
 * Constrói o restrictTo da IA (item das zonas). Dentro de uma zona de retake, a IA decide
 * SEM restrição (como no caminho sem copy); fora, fica restrita aos candidatos (a copy
 * mantém precedência). Sem copy → undefined. Só candidatos-fora-de-zona (nenhum, no caso
 * de zona pura) → undefined (a zona já libera tudo). Reaproveitado pelo endpoint e cascade.
 */
export function buildRestrictTo(
  retakeCandidates: number[], retakeZones: { from: number; to: number }[], hasCopy: boolean,
): Set<number> | undefined {
  if (!hasCopy) return undefined;
  if (retakeCandidates.length === 0) return undefined; // só zonas (ou nada) → IA livre
  const allowed = new Set<number>(retakeCandidates);
  for (const z of retakeZones) for (let i = z.from; i <= z.to; i++) allowed.add(i);
  return allowed;
}

export interface DecupagemOpts {
  track?: EnergyTrack;
  vadSegments?: VadSegment[];   // p/ o corte de silêncio (dead-air)
  silence?: SilenceOpts;
  headZones?: { from: number; to: number; via?: "periodicidade" | "cabeca" | "bloco" | "ambos"; cut?: { startMs: number; endMs: number } }[]; // zonas por cabeça-de-bloco (VAD de zona + heads)
}

const label = (cuts: CutInterval[]) => cuts.map((c) => ({ ...c, label: reasonSummary(c) }));
const EMPTY = (error?: string): DecupagemResult => ({ cuts: [], all: [], needsAi: false, retakeCandidates: [], retakeZones: [], rawIntervals: [], error });

export function runDecupagem(words: Word[], copy: string, opts: DecupagemOpts = {}): DecupagemResult {
  try {
    if (!words || words.length === 0) return EMPTY();

    const det = runCopyLayer(words, copy, opts.headZones ?? []);
    const zonesMs = zonesToMs(words, det.retakeZones); // silêncio respeita zonas de retake
    const silence = opts.vadSegments ? silenceLayer(opts.vadSegments, zonesMs, opts.silence) : [];
    // FALSO COMEÇO (zona-cabeça pura): corte ACÚSTICO por bloco — o abandonado não tem palavras
    // canônicas próprias, então a IA (que lê texto) não o corta; a estrutura de bloco corta.
    // GATE (o corte acústico só é seguro onde a estrutura textual concorda): se QUALQUER palavra
    // canônica ATRAVESSA a borda do corte, a palavra é partida e a legenda quebra (o Whisper colou
    // as duas tentativas nessa palavra). Detecção é confiável → marca (blocked_by), NÃO aplica.
    const crossesBorder = (startMs: number, endMs: number) => words.some((w) => {
      const ws = (w.start ?? 0) * 1000, we = (w.end ?? 0) * 1000;
      return (ws < startMs && we > startMs) || (ws < endMs && we > endMs);
    });
    const hasCopy = copy.trim().length > 0;
    const falsoComeco: CutInterval[] = det.retakeZones
      .filter((z) => z.via === "cabeca" && z.cut && z.cut.endMs > z.cut.startMs)
      .map((z) => {
        const base: CutInterval = { startMs: z.cut!.startMs, endMs: z.cut!.endMs, source: "ai_retake", reason: ["falso_comeco"], confidence: 0.9 };
        if (!crossesBorder(z.cut!.startMs, z.cut!.endMs)) return base; // fronteira limpa → aplica
        // parte palavra: COM copy, aplica e marca p/ caption-coverage reparar; SEM copy, bloqueia
        return hasCopy
          ? { ...base, reason: ["falso_comeco", "needs_caption_repair"] }
          : { ...base, blocked_by: "caption_timestamp_collapse" };
      });
    const rawIntervals = [...det.cuts, ...silence, ...falsoComeco];
    const planned = label(planCuts(rawIntervals, opts.track));

    return {
      cuts: planned.filter((c) => c.applied),
      all: planned,
      needsAi: det.needsAi,
      retakeCandidates: det.retakeCandidates,
      retakeZones: det.retakeZones,
      rawIntervals,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[DECUPAGEM] falha no passo determinístico:", msg);
    return EMPTY(`Falha ao decupar: ${msg}`);
  }
}

/**
 * PATCH DE IA: junta os cortes da IA (retakes) com os intervalos brutos do determinístico
 * e RE-PLANEJA tudo (merge/snap/score/rótulo). Devolve o conjunto final completo. Nunca lança.
 */
export function planWithAi(
  rawIntervals: CutInterval[], aiCuts: CutInterval[], track?: EnergyTrack, protect?: MsRange[],
): CutInterval[] {
  try {
    return label(planCuts([...rawIntervals, ...aiCuts], track, protect));
  } catch (e) {
    console.error("[DECUPAGEM] falha no patch de IA:", e instanceof Error ? e.message : e);
    return label(planCuts(rawIntervals, track, protect)); // degrada pro determinístico
  }
}

export { keeperEdges, type MsRange } from "./plan/index.js";
export { reasonLabel, reasonSummary } from "./reasons.js";
export type { CutInterval } from "./semantic/types.js";
