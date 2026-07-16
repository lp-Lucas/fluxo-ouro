import type { TranscriptSegment, Word, Cut } from "../../../shared/timeline.js";
import { buildCutPlan, remapTime } from "../../../shared/cutplan.js";
import { stripCutsFromTranscript } from "../../../shared/captions.js";
import { runClaude, extractJson } from "./aiCut.js";

/**
 * Conferência de cobertura de legenda pós-corte.
 * Depois dos cortes, detecta trechos do vídeo FINAL onde você aparece falando mas
 * NÃO há legenda (as palavras caíram num corte ou a correção as tirou). A IA usa a
 * copy como verdade pra decidir o texto que falta; preenchemos com timestamps dentro
 * do trecho que ficou (a IA não inventa tempo — só o texto).
 */

const MIN_GAP = 0.7; // s — buraco mínimo p/ suspeitar de fala sem legenda

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]/gu, "");

export interface Gap { srcStart: number; srcEnd: number; outStart: number; outEnd: number; before: string; after: string; }

/** Acha buracos de legenda dentro dos segmentos que ficaram (em tempo de fonte). */
export function findCoverageGaps(transcript: TranscriptSegment[], durationSec: number, cuts: Cut[]): Gap[] {
  const plan = buildCutPlan(durationSec, cuts);
  const capWords = stripCutsFromTranscript(transcript, cuts).flatMap((s) => s.words).sort((a, b) => a.start - b.start);
  const gaps: Gap[] = [];

  for (const seg of plan.segments) {
    // palavras de legenda dentro deste segmento mantido
    const inside = capWords.filter((w) => w.end > seg.srcStart + 0.01 && w.start < seg.srcEnd - 0.01);
    // varre a linha do tempo do segmento procurando faixas sem palavra
    let cursor = seg.srcStart;
    const push = (a: number, b: number, beforeW?: Word, afterW?: Word) => {
      if (b - a >= MIN_GAP) {
        const os = remapTime(a, plan) ?? 0, oe = remapTime(b, plan) ?? 0;
        gaps.push({ srcStart: +a.toFixed(3), srcEnd: +b.toFixed(3), outStart: +os.toFixed(3), outEnd: +oe.toFixed(3),
          before: beforeW?.text ?? "(início)", after: afterW?.text ?? "(fim)" });
      }
    };
    for (let i = 0; i < inside.length; i++) {
      if (inside[i].start - cursor >= MIN_GAP) push(cursor, inside[i].start, inside[i - 1], inside[i]);
      cursor = Math.max(cursor, inside[i].end);
    }
    if (seg.srcEnd - cursor >= MIN_GAP) push(cursor, seg.srcEnd, inside[inside.length - 1], undefined);
  }
  return gaps;
}

/** Distribui um texto em palavras com timestamps proporcionais no intervalo [a,b]. */
function distribute(text: string, a: number, b: number): Word[] {
  const toks = text.split(/\s+/).filter(Boolean);
  if (toks.length === 0) return [];
  const total = toks.reduce((n, t) => n + t.length, 0) || 1;
  const span = Math.max(0.001, b - a);
  let t = a;
  return toks.map((tok) => {
    const d = (span * tok.length) / total;
    const w: Word = { text: tok, start: +t.toFixed(3), end: +(t + d).toFixed(3) };
    t += d;
    return w;
  });
}

interface Fill { gap: number; text: string; }

/** Monta o prompt: copy + legendas finais em ordem + buracos numerados. */
function buildPrompt(copy: string, capWords: Word[], gaps: Gap[], plan: ReturnType<typeof buildCutPlan>): string {
  const seq = capWords
    .map((w) => ({ w, o: remapTime(w.start, plan) }))
    .filter((x) => x.o != null)
    .sort((a, b) => (a.o! - b.o!))
    .map((x) => x.w.text)
    .join(" ");
  const gapList = gaps.map((g, i) =>
    `#${i}: entre "${g.before}" e "${g.after}", ${(g.srcEnd - g.srcStart).toFixed(1)}s de vídeo (tempo final ${g.outStart.toFixed(1)}s–${g.outEnd.toFixed(1)}s)`,
  ).join("\n");

  return [
    `Você confere a COBERTURA de legendas de um vídeo já editado (com cortes).`,
    `Existem BURACOS: momentos do vídeo final SEM legenda. Para cada buraco, decida se ali há FALA que deveria ter legenda (comparando com o ROTEIRO) ou se é só uma pausa/silêncio.`,
    `Se há fala faltando, devolva SOMENTE o TEXTO que aparece naquele buraco (tirado do roteiro, na ordem) — NÃO repita as palavras vizinhas mostradas ("entre X e Y"). Se for só pausa/silêncio, não inclua o buraco.`,
    `\nROTEIRO (copy, verdade do que é dito):\n"""\n${copy.trim()}\n"""`,
    `\nLEGENDA ATUAL do vídeo final (em ordem):\n"${seq}"`,
    `\nBURACOS (sem legenda):\n${gapList}`,
    `\nResponda SOMENTE JSON: {"fills":[{"gap":<indice>,"text":"palavras que faltam"}]}. Sem buracos a preencher → {"fills":[]}.`,
  ].join("\n");
}

export interface CoverageResult { transcript: TranscriptSegment[]; gaps: number; filled: number; needsCopy: boolean; }

/** Detecta buracos e (com copy) preenche via IA. Devolve a transcrição atualizada. */
export async function fillCaptionGaps(
  transcript: TranscriptSegment[], durationSec: number, cuts: Cut[], copy: string, signal?: AbortSignal,
): Promise<CoverageResult> {
  const gaps = findCoverageGaps(transcript, durationSec, cuts);
  if (gaps.length === 0) return { transcript, gaps: 0, filled: 0, needsCopy: false };
  if (copy.trim().length === 0) return { transcript, gaps: gaps.length, filled: 0, needsCopy: true };

  const plan = buildCutPlan(durationSec, cuts);
  const capWords = stripCutsFromTranscript(transcript, cuts).flatMap((s) => s.words);
  const text = await runClaude(buildPrompt(copy, capWords, gaps, plan), signal);
  const parsed = extractJson(text) as { fills?: Fill[] };
  const fills = Array.isArray(parsed.fills) ? parsed.fills : [];

  // Insere as palavras que faltam DENTRO do segmento que contém o buraco (na ordem
  // do tempo) — não como segmento separado, senão o karaokê/linha original sobrepõe.
  const segs = transcript.map((s) => ({ ...s, words: [...s.words] }));
  let filled = 0;
  for (const f of fills) {
    const g = gaps[f.gap];
    if (!g || !f.text?.trim()) continue;
    // remove tokens que repetem a palavra vizinha (a IA às vezes inclui o contexto).
    let toks = f.text.trim().split(/\s+/).filter(Boolean);
    const nb = norm(g.before), na = norm(g.after);
    while (toks.length && norm(toks[0]) === nb) toks.shift();
    while (toks.length && norm(toks[toks.length - 1]) === na) toks.pop();
    if (toks.length === 0) continue;
    const pad = (g.srcEnd - g.srcStart) * 0.05; // margem p/ não colar na borda
    const words = distribute(toks.join(" "), g.srcStart + pad, g.srcEnd - pad);
    if (words.length === 0) continue;

    // segmento que contém o meio do buraco (ou o mais próximo por tempo).
    const mid = (g.srcStart + g.srcEnd) / 2;
    let host = segs.find((s) => mid >= s.start - 0.01 && mid <= s.end + 0.01);
    if (!host) {
      host = segs.reduce((a, b) => (Math.abs((a.start + a.end) / 2 - mid) <= Math.abs((b.start + b.end) / 2 - mid) ? a : b), segs[0]);
    }
    if (!host) {
      segs.push({ id: `gapfill-${g.srcStart.toFixed(2)}`, start: words[0].start, end: words[words.length - 1].end,
        text: words.map((w) => w.text).join(" "), words, source: "corrected" });
    } else {
      host.words = [...host.words, ...words].sort((a, b) => a.start - b.start);
      host.start = Math.min(host.start, words[0].start);
      host.end = Math.max(host.end, words[words.length - 1].end);
      host.text = host.words.map((w) => w.text).join(" ");
      host.source = "corrected";
    }
    filled++;
  }
  if (filled === 0) return { transcript, gaps: gaps.length, filled: 0, needsCopy: false };

  segs.sort((a, b) => a.start - b.start);
  return { transcript: segs, gaps: gaps.length, filled, needsCopy: false };
}
