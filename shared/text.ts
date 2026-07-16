/**
 * Utilitários de texto compartilhados (frontend + backend). Reunidos aqui para o
 * Levenshtein ser reaproveitado pela correção (align.ts) e pela guarda de mishear,
 * sem duplicar a implementação.
 */

/** Normaliza para comparação: minúsculas, sem acento, só letras/números. */
export function normalizeWord(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Distância de edição (Levenshtein) entre duas strings curtas. Array rolante. */
export function levenshtein(a: string, b: string): number {
  const n = a.length, m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev = new Array(m + 1);
  let curr = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m];
}
