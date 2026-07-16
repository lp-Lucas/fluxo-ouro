import type { CutInterval, CutSource } from "../semantic/types.js";

/**
 * FASE 4 — FUSÃO. Recebe os CutIntervals de todas as camadas (copy, alucinação,
 * ai_retake e, quando existirem, silêncio/respiração/vício) e funde em cortes finais:
 *
 *  - UNIÃO + DILATAÇÃO 250ms: intervalos cuja folga ≤ 250ms viram UM corte só. Remove
 *    lascas mantidas curtas demais entre dois cortes (um flash de 100ms de vídeo entre
 *    dois cortes é pior que juntar).
 *  - reason[] PRESERVADO: a união acumula as razões (várias camadas podem concordar).
 *  - CONFIANÇA: se as bordas dos membros concordam (≤300ms) → max das confianças; se
 *    fontes DIVERGEM > 300ms numa borda → penaliza (fontes discordam de onde cortar).
 *
 * Puro e determinístico (não olha áudio — isso é o snap). Não emite Cut do timeline;
 * continua em CutInterval (a Fase 5 decide `applied`).
 */

export const DILATION_MS = 250;
export const EDGE_DISAGREE_MS = 300;
const PENALTY = 0.8; // fator quando as fontes divergem numa borda

/** Confiança-base por fonte quando o CutInterval não trouxe uma. */
const BASE_CONFIDENCE: Record<CutSource, number> = {
  copy: 0.9,            // determinístico, a copy é a verdade
  hallucination: 0.9,   // fala isolada em silêncio → alucinação do whisper
  vad_silence: 0.97,    // dead-air do VAD (silenceLayer)
  vad_breath: 0.92,     // alta, mas a Fase 5 força applied:false enquanto a vogal→breath persiste
  ai_retake: 0.9,       // sem copy, a IA é a ÚNICA camada de conteúdo → precisa APLICAR (>0.85)
  filler: 0.7,          // muletas
};

const baseOf = (c: CutInterval): number => c.confidence ?? BASE_CONFIDENCE[c.source];

/** Une razões preservando ordem de 1ª aparição (sem duplicar). */
function unionReasons(members: CutInterval[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of members) for (const r of m.reason) if (!seen.has(r)) { seen.add(r); out.push(r); }
  return out;
}

/** Fonte representante do grupo = a do membro de maior confiança-base. */
function dominantSource(members: CutInterval[]): CutSource {
  return members.reduce((a, b) => (baseOf(b) > baseOf(a) ? b : a)).source;
}

const overlaps = (a: CutInterval, b: CutInterval) => a.startMs < b.endMs && b.startMs < a.endMs;

/** Combina um grupo de intervalos sobrepostos/dilatados num corte só. */
function combine(members: CutInterval[]): CutInterval {
  const startMs = Math.min(...members.map((m) => m.startMs));
  const endMs = Math.max(...members.map((m) => m.endMs));
  const maxBase = Math.max(...members.map(baseOf));

  // Divergência: duas fontes DIFERENTES marcam a MESMA região (sobrepõem) mas discordam
  // de onde é a borda em > 300ms. Adjacência dilatada (sem sobreposição) NÃO é conflito.
  let disagree = false;
  for (let i = 0; i < members.length && !disagree; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i], b = members[j];
      if (a.source === b.source || !overlaps(a, b)) continue;
      if (Math.abs(a.startMs - b.startMs) > EDGE_DISAGREE_MS || Math.abs(a.endMs - b.endMs) > EDGE_DISAGREE_MS) {
        disagree = true; break;
      }
    }
  }
  const confidence = disagree ? +(maxBase * PENALTY).toFixed(4) : maxBase;
  const blocked_by = members.find((m) => m.blocked_by)?.blocked_by; // preserva o bloqueio (ex.: falso começo)

  return { startMs, endMs, source: dominantSource(members), reason: unionReasons(members), confidence, ...(blocked_by ? { blocked_by } : {}) };
}

/** Funde CutIntervals com dilatação de 250ms. Entrada em qualquer ordem. */
export function mergeCuts(intervals: CutInterval[], dilationMs = DILATION_MS): CutInterval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const groups: CutInterval[][] = [];
  let cur: CutInterval[] = [sorted[0]];
  let curEnd = sorted[0].endMs;
  for (let i = 1; i < sorted.length; i++) {
    const iv = sorted[i];
    if (iv.startMs - curEnd <= dilationMs) {        // folga ≤ dilatação → mesmo grupo
      cur.push(iv);
      curEnd = Math.max(curEnd, iv.endMs);
    } else {
      groups.push(cur);
      cur = [iv];
      curEnd = iv.endMs;
    }
  }
  groups.push(cur);

  return groups.map(combine);
}
