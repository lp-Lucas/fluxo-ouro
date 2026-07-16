import type { Word } from "../../../../shared/timeline.js";
import { simNorm } from "./verificaRetake.js";

/**
 * REPETIÇÃO FINA — recupera o retake que o Whisper CANÔNICO achatou. A transcrição do arquivo
 * inteiro cola tomadas repetidas numa palavra arrastada (ex.: "sabe" 2s engole a 2ª "com a crux
 * você"); a periodicidade textual não vê o que no texto não existe. Mas a disfluência já apontou
 * ONDE olhar (colapso de ancoragem). Aqui re-transcrevemos FINO essa região e procuramos uma
 * repetição IMEDIATA de frase — a mesma técnica da cabeça-de-bloco, agora dentro da região.
 *
 * Entrada: as palavras da transcrição FINA da região (com timestamps absolutos, já deslocados).
 * Saída: o corte que remove as k-1 primeiras tomadas e mantém a ÚLTIMA — `[1ª onset, última onset]`
 * — ou null se não há repetição limpa. NÃO aplica: vira chip de revisão (o editor ouve e corta).
 */

export interface RepeticaoFina {
  cutStartMs: number;  // onset da 1ª tomada (início do que se remove)
  cutEndMs: number;    // onset da ÚLTIMA tomada (início do que se mantém)
  frase: string;       // a frase repetida (para o rótulo)
  vezes: number;       // quantas tomadas (k)
}

const MIN_PALAVRAS = 3;    // frase repetida ≥ 3 palavras (senão é coincidência: "a", "de a")
const SIM = 0.8;           // as tomadas têm de ser quase idênticas no texto

const norm = (w: Word) => (w.text ?? "").trim().toLowerCase();
const onset = (w: Word) => Math.round((w.start ?? 0) * 1000);

/**
 * Acha a MAIOR repetição imediata: uma frase de comprimento L que se repete k≥2 vezes seguidas a
 * partir de alguma posição p. Prefere a que cobre mais palavras (frase mais longa, mais tomadas).
 */
export function detectaRepeticaoFina(words: Word[]): RepeticaoFina | null {
  const n = words.length;
  if (n < MIN_PALAVRAS * 2) return null;
  let melhor: RepeticaoFina | null = null;
  let melhorCobertura = 0;

  for (let L = Math.floor(n / 2); L >= MIN_PALAVRAS; L--) {
    for (let p = 0; p + 2 * L <= n; p++) {
      // conta quantas tomadas consecutivas de comprimento L batem com a 1ª a partir de p
      const base = words.slice(p, p + L).map(norm).join(" ");
      let k = 1;
      while (p + (k + 1) * L <= n) {
        const seg = words.slice(p + k * L, p + (k + 1) * L).map(norm).join(" ");
        if (simNorm(base, seg) >= SIM) k++;
        else break;
      }
      if (k < 2) continue;
      const cobertura = k * L;
      if (cobertura <= melhorCobertura) continue;
      melhorCobertura = cobertura;
      const ultima = p + (k - 1) * L; // índice da 1ª palavra da ÚLTIMA tomada
      melhor = {
        cutStartMs: onset(words[p]),
        cutEndMs: onset(words[ultima]),
        frase: words.slice(p, p + L).map((w) => (w.text ?? "").trim()).join(" "),
        vezes: k,
      };
    }
  }
  return melhor;
}
