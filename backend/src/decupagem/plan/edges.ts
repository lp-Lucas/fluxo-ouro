import type { CutInterval } from "../semantic/types.js";
import type { Word } from "../../../../shared/timeline.js";

/**
 * REGRA DE BORDA (fecha a CLASSE, não o caso): nenhuma camada corta a primeira/última
 * palavra do que a IA decidiu MANTER. Se a IA disse "mantém take 3", as bordas do take 3
 * são invioláveis para TODAS as camadas, em qualquer ordem.
 *
 * keeperEdges: os intervalos das PALAVRAS mantidas dentro de zonas (zona menos o que a IA
 * cortou) — word-based, não ms: o silêncio antes do keeper é dead-air e deve morrer; só a
 * primeira PALAVRA do keeper é inviolável. `shrinkAtEdges` roda depois do merge, antes do
 * snap: um corte que invade um keeper é ENCOLHIDO até a borda (não descartado — a maior
 * parte do silêncio é real e deve sumir), preservando reason e confidence.
 */

export interface MsRange { startMs: number; endMs: number; }

const wStart = (w: Word) => w.vadStartMs ?? Math.round(w.start * 1000);
const wEnd = (w: Word) => w.vadEndMs ?? Math.round(w.end * 1000);

/** Intervalos (ms) das palavras MANTIDAS dentro das zonas (não tocadas por nenhum aiCut). */
export function keeperEdges(words: Word[], zones: { from: number; to: number }[], aiCuts: CutInterval[]): MsRange[] {
  const removed = (i: number) => aiCuts.some((c) => wEnd(words[i]) > c.startMs && wStart(words[i]) < c.endMs);
  const out: MsRange[] = [];
  for (const z of zones) {
    let i = z.from;
    while (i <= z.to && i < words.length) {
      if (removed(i)) { i++; continue; }
      let j = i;
      while (j <= z.to && j < words.length && !removed(j)) j++;
      out.push({ startMs: wStart(words[i]), endMs: wEnd(words[j - 1]) });
      i = j;
    }
  }
  return out;
}

/** Encolhe cada corte para NÃO entrar em nenhum keeper. Preserva reason/confidence. */
export function shrinkAtEdges(cuts: CutInterval[], keepers: MsRange[]): CutInterval[] {
  if (keepers.length === 0) return cuts;
  const out: CutInterval[] = [];
  for (const c of cuts) {
    let s = c.startMs, e = c.endMs, alive = true;
    for (const k of keepers) {
      if (e <= k.startMs || s >= k.endMs) continue;           // sem sobreposição
      if (s >= k.startMs && e <= k.endMs) { alive = false; break; } // inteiro dentro do keeper → some
      if (s < k.startMs && e > k.startMs && e <= k.endMs) e = k.startMs;       // invade pela esquerda
      else if (s >= k.startMs && s < k.endMs && e > k.endMs) s = k.endMs;      // invade pela direita
      else if (s < k.startMs && e > k.endMs) e = k.startMs;   // engloba o keeper → fica a parte esquerda
    }
    if (alive && e > s) out.push({ ...c, startMs: Math.round(s), endMs: Math.round(e) });
  }
  return out;
}
