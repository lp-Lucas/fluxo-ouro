import type { Word } from "../../../../shared/timeline.js";
import { computeAlignment, tokenizeCopy } from "../../../../shared/gotoh.js";
import { eMishear, copyTokensNormalizados } from "./misheardGuard.js";
import { detectaZonas, unirZonas, zoneIndexSet, type RetakeZone } from "./retakeZones.js";
import type { CutInterval, SemanticResult } from "./types.js";

/**
 * CAMADA DETERMINÍSTICA (precedência copy > IA). Roda na hora, sem IA:
 *  - COPY manda no conteúdo: alinhamento Gotoh → palavras `del` (fora do roteiro) = corte.
 *  - GUARDA DE MISHEAR freia: palavra del que é garble de uma palavra do roteiro NUNCA
 *    é cortada (freada), reason ['mishear_provavel'].
 *  - ALUCINAÇÃO: palavra ancorada com vadSegmentIdx = -1 (fala isolada em silêncio) = corte.
 *  - RETAKE ambíguo: palavra del cujo CONTEÚDO bate com o roteiro (tomada duplicada) →
 *    o alinhamento não sabe qual manter; marca como candidata e pede IA.
 *
 * As bordas do corte saem em ms a partir da ancoragem VAD (vadStartMs/vadEndMs), com
 * fusão de índices contíguos num corte só. Silêncio/vícios NÃO entram aqui (Fase 4, só
 * adicionam em regiões já não-mantidas).
 */

/** Limiar de fala periférica: palavra fora da copy com probability baixa (Fase 5). */
const PERIPHERAL_PROB = 0.15;
/** Órfã só é alucinação REAL se o segmento não-fala que a contém tiver ≥ isto (item 3). */
const HALLUC_MIN_NONSPEECH_MS = 400;

/**
 * Constrói CutIntervals fundindo índices de palavra contíguos marcados. `tagPeripheral`
 * (só cortes de copy): marca "fala_periferica" quando ALGUMA palavra do intervalo tem
 * probability < 0.15 — fala fora do roteiro que o transcritor ouviu mal é muleta/enrolação
 * de verdade (a Fase 5 dá +0.05 de confiança). Único uso sobrevivente do `probability`.
 */
function wordsToCuts(words: Word[], marked: boolean[], source: CutInterval["source"], reason: string, tagPeripheral = false): CutInterval[] {
  const cuts: CutInterval[] = [];
  let i = 0;
  while (i < words.length) {
    if (!marked[i]) { i++; continue; }
    let j = i;
    while (j < words.length && marked[j]) j++;
    const startMs = words[i].vadStartMs ?? Math.round(words[i].start * 1000);
    const endMs = words[j - 1].vadEndMs ?? Math.round(words[j - 1].end * 1000);
    if (endMs > startMs) {
      const reasons = [reason];
      if (tagPeripheral) {
        for (let k = i; k < j; k++) {
          if (words[k].probability != null && (words[k].probability as number) < PERIPHERAL_PROB) { reasons.push("fala_periferica"); break; }
        }
      }
      cuts.push({ startMs, endMs, source, reason: reasons });
    }
    i = j;
  }
  return cuts;
}

export function runCopyLayer(words: Word[], copy: string, headZones: RetakeZone[] = []): SemanticResult {
  const copyTokens = copyTokensNormalizados(copy);
  const hasCopy = copyTokens.length > 0;

  // 0) ZONAS DE RETAKE (antes do Gotoh, sobre a fala): dois métodos unidos —
  //    PERIODICIDADE (texto se repete) + CABEÇA-DE-BLOCO (começos de bloco parecidos, vindos
  //    do VAD de zona, passados aqui). Dentro de qualquer zona o copyLayer se cala.
  const retakeZones = unirZonas(detectaZonas(words), headZones);
  const inZone = zoneIndexSet(retakeZones);

  // 1) alinhamento (só com copy): kept = match/sub; del = fora do roteiro
  const kept = new Array(words.length).fill(false);
  if (hasCopy) {
    for (const s of computeAlignment(words, tokenizeCopy(copy))) {
      if (s.aIndex >= 0 && s.op !== "del") kept[s.aIndex] = true;
      if (s.aIndex2 != null) kept[s.aIndex2] = true;
    }
  } else {
    kept.fill(true); // sem copy, o conteúdo não é julgado aqui — fica pra IA
  }

  const braked: number[] = [];
  const retakeCandidates: number[] = [];
  const cutByCopy = new Array(words.length).fill(false);
  const cutByHallucination = new Array(words.length).fill(false);
  const cutByUncertain = new Array(words.length).fill(false);

  for (let i = 0; i < words.length; i++) {
    // DENTRO DE ZONA DE RETAKE: o copyLayer não decide nada (nem alucinação/fronteira, que
    // dentro de fala repetida é misclassificação). A zona inteira vai livre para a IA.
    if (inZone.has(i)) continue;

    // órfã (idx -1): só é alucinação REAL se o segmento não-fala que a contém for longo
    // (≥400ms). Órfã em fala densa (gap curto) = fronteira VAD incerta → marca, não corta.
    if (words[i].vadSegmentIdx === -1) {
      if ((words[i].vadHallGapMs ?? Infinity) >= HALLUC_MIN_NONSPEECH_MS) cutByHallucination[i] = true;
      else cutByUncertain[i] = true;
      continue;
    }
    if (kept[i]) continue; // dentro do roteiro → mantém

    // palavra `del` (fora do roteiro):
    if (hasCopy && eMishear(words[i].text, copyTokens)) {
      braked.push(i);           // FREIO: garble de palavra do roteiro → nunca corta
      continue;
    }
    if (hasCopy && copyTokens.includes(normalized(words[i].text))) {
      // O texto bate com o roteiro mas foi del → é REPETIÇÃO (curta demais p/ virar zona,
      // mas ainda repetição). O copyLayer NÃO tem autoridade sobre span que se repete: não
      // corta, não vira candidato, fica fora de restrictTo. INTOCADO → a IA decide no
      // contexto (ela distingue retake de ênfase retórica; o Gotoh, por posição, não).
      continue;
    }
    cutByCopy[i] = true;        // fora do roteiro de verdade (não bate com a copy) → corta
  }

  const cuts = [
    ...wordsToCuts(words, cutByCopy, "copy", "fora_do_roteiro", true),
    ...wordsToCuts(words, cutByHallucination, "hallucination", "whisper_hallucination"),
    ...wordsToCuts(words, cutByUncertain, "hallucination", "fronteira_vad_incerta"),
  ].sort((a, b) => a.startMs - b.startMs);

  return {
    cuts, braked, retakeCandidates, retakeZones,
    needsAi: !hasCopy || retakeCandidates.length > 0 || retakeZones.length > 0,
  };
}

const normalized = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]/gu, "");
