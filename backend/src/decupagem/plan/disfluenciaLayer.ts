import type { Word } from "../../../../shared/timeline.js";
import type { CutInterval } from "../semantic/types.js";
import type { SpeechBlock } from "../semantic/retakeZones.js";

/**
 * DISFLUÊNCIA — o MECANISMO, não o caso. Detecta COLAPSO DE ANCORAGEM: a assinatura de que
 * houve uma disfluência (falso começo, reformulação, gagueira) que o Whisper ACHATOU. O
 * engine não sabe qual e não deve chutar — só diz ONDE OLHAR.
 *
 * Sinais (todos do CANÔNICO, nunca do garble por-bloco):
 *   - palavra canônica ATRAVESSA fronteira de bloco do VAD de zona (timestamp colado)
 *   - palavra órfã em silêncio VAD (vadSegmentIdx === -1)
 *   - duração da palavra ≤ 0.05s ou ≥ 1.5s (degenerada ou arrastada)
 *
 * Região = o COLAPSO, não o bloco: `[colapso.start - 500ms, colapso.end + 500ms]`. Palavras
 * colapsadas a < 1s fundem num evento só. Para palavra que ATRAVESSA fronteira, o colapso é a
 * própria palavra (a extensão anômala é o sinal) → usa whisperStart/End; senão (órfã/duração)
 * usa vadStart/End. Emite `disfluencia_provavel`, confidence 0.5, applied:false, copyIndependent.
 * NÃO propõe corte — diz onde OLHAR ("ouça aqui", navegável).
 *
 * SUPRIME só onde ai_retake_detection/falso_comeco CORTOU aquele span (o colapso cai DENTRO do
 * corte). A cauda do retake ([124-125] em silêncio VAD = alucinação do Whisper) está no take
 * MANTIDO, fora do corte → NÃO é suprimida: é a única evidência visível dessa alucinação.
 */

export const DISFLU_MIN_DUR = 0.05, DISFLU_MAX_DUR = 1.5;
const PAD_MS = 500, MERGE_GAP_MS = 1000;

export function disfluenciaLayer(words: Word[], zblocks: SpeechBlock[], existing: CutInterval[] = []): CutInterval[] {
  if (zblocks.length === 0) return [];
  const blockAt = (tMs: number) => zblocks.findIndex((b) => tMs >= b.startMs && tMs < b.endMs);
  const cutHere = (mid: number) => existing.some((c) =>
    (c.reason.includes("falso_comeco") || c.reason.includes("ai_retake_detection")) && c.startMs <= mid && mid < c.endMs);

  // 1) spans de COLAPSO (não a região ainda) das palavras com sinal, não suprimidas
  const cols: { startMs: number; endMs: number }[] = [];
  for (const w of words) {
    const ws = (w.start ?? 0) * 1000, we = (w.end ?? 0) * 1000, dur = (w.end ?? 0) - (w.start ?? 0);
    const crossesBoundary = blockAt(ws) !== blockAt(we) && (blockAt(ws) >= 0 || blockAt(we) >= 0);
    const orphan = w.vadSegmentIdx === -1;
    const durAnomaly = dur <= DISFLU_MIN_DUR || dur >= DISFLU_MAX_DUR;
    if (!(crossesBoundary || orphan || durAnomaly)) continue;
    // atravessa fronteira → o colapso É a palavra (whisper); senão → a âncora VAD
    const vs = w.vadStartMs ?? ws, ve = w.vadEndMs ?? we;
    const cs = crossesBoundary ? ws : vs, ce = crossesBoundary ? we : ve;
    if (cutHere((cs + ce) / 2)) continue; // o corte já removeu aquele span → não marca
    cols.push({ startMs: cs, endMs: ce });
  }

  // 2) funde colapsos a < 1s (mesmo evento), depois pad ±500ms
  cols.sort((a, b) => a.startMs - b.startMs);
  const merged: { startMs: number; endMs: number }[] = [];
  for (const c of cols) {
    const last = merged[merged.length - 1];
    if (last && c.startMs - last.endMs < MERGE_GAP_MS) last.endMs = Math.max(last.endMs, c.endMs);
    else merged.push({ ...c });
  }
  return merged.map((r) => ({
    startMs: Math.max(0, Math.round(r.startMs - PAD_MS)), endMs: Math.round(r.endMs + PAD_MS),
    source: "ai_retake", reason: ["disfluencia_provavel"], confidence: 0.5, applied: false, copyIndependent: true,
  }));
}
