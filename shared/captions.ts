import type { TranscriptSegment, Word, Cut, Seconds } from "./timeline";

/**
 * Remove das legendas as palavras que caem dentro de cortes ativos.
 * Assim, um trecho cortado (ex: take errado repetido) não gera legenda duplicada.
 * Uma palavra é descartada se sobrepõe qualquer corte ativo.
 */
export function stripCutsFromTranscript(
  transcript: TranscriptSegment[],
  cuts: Cut[],
): TranscriptSegment[] {
  const active = cuts.filter((c) => c.enabled);
  if (active.length === 0) return transcript;

  const removeCuts = active.filter((c) => !c.shiftCaption);
  const shiftCuts = active.filter((c) => c.shiftCaption);
  const overlaps = (w: Word, c: Cut) => w.start < c.end && w.end > c.start;

  return transcript
    .map((seg) => {
      const words = seg.words
        .filter((w) => !removeCuts.some((c) => overlaps(w, c))) // corte normal: remove
        .map((w) => {
          // corte "manter legenda": desloca a palavra para depois do corte
          const c = shiftCuts.find((c) => overlaps(w, c));
          if (!c) return w;
          const d = c.end - c.start;
          return { ...w, start: w.start + d, end: w.end + d };
        });
      return { ...seg, words, text: words.map((w) => w.text).join(" ") };
    })
    .filter((seg) => seg.words.length > 0);
}

/**
 * REPARO DE TIMING das legendas: acha palavras BUGADAS — duração ~zero, início empilhado
 * no da anterior ou começando antes do fim da anterior (o bug antigo do editWord: palavras
 * adicionadas nasciam todas com o mesmo timestamp) — e re-distribui cada corrida bugada na
 * JANELA real disponível: do fim da última palavra saudável até o começo da próxima
 * saudável (absorvendo a pausa), proporcional ao tamanho, com piso de 50ms. Palavras
 * saudáveis NÃO se movem (o karaokê continua cravado na fala). Usado pelo "conferir
 * legendas" para ATUALIZAR projetos legendados antes do conserto do editWord.
 */
export function repairWordTimings(transcript: TranscriptSegment[]): { transcript: TranscriptSegment[]; fixed: number } {
  let fixed = 0;
  const MIN = 0.04; // duração mínima "saudável"
  const out = transcript.map((seg) => {
    if (seg.words.length === 0) return seg;

    // PASSO 1 — PALAVRA GIGANTE (o "trava numa palavra"): fim que INVADE o início da
    // próxima (colapso do Whisper estica o end) deixa a palavra ativa o tempo todo e a
    // linha do karaokê não avança. Regra: o INÍCIO é a âncora confiável — o fim de cada
    // palavra é TETADO no início da seguinte. A última palavra do segmento é capada em
    // 2s (fim esticado sem próxima pra limitar).
    const w = seg.words.map((x) => ({ ...x }));
    let segFixed = 0;
    for (let i = 0; i < w.length; i++) {
      const next = w[i + 1];
      if (next && w[i].end > next.start + 0.001 && next.start > w[i].start) {
        w[i] = { ...w[i], end: next.start }; segFixed++;
      } else if (!next && w[i].end - w[i].start > 2.0) {
        w[i] = { ...w[i], end: +(w[i].start + 2.0).toFixed(3) }; segFixed++;
      }
    }
    fixed += segFixed;

    // PASSO 2 — duração ~zero / empilhadas / sobrepostas restantes → redistribui na janela.
    const bugada = w.map((x, i) => {
      if (x.end - x.start < MIN) return true;
      if (i > 0 && Math.abs(x.start - w[i - 1].start) < 0.005) return true; // empilhada
      if (i > 0 && x.start < w[i - 1].end - 0.005) return true;             // sobreposta
      return false;
    });
    if (!bugada.some(Boolean)) {
      return segFixed > 0 ? { ...seg, words: w, source: "corrected" as const } : seg;
    }

    const words = w;
    let i = 0;
    while (i < words.length) {
      if (!bugada[i]) { i++; continue; }
      let j = i;
      while (j < words.length && bugada[j]) j++; // corrida bugada [i..j)
      const prevEnd = i > 0 ? words[i - 1].end : words[i].start;
      const runStart = Math.max(prevEnd, 0);
      const n = j - i;
      const nextStart = j < words.length ? words[j].start : undefined;
      const windowEnd = Math.max(nextStart ?? runStart + 0.3 * n, runStart + 0.05 * n);
      const span = windowEnd - runStart;
      const totalChars = words.slice(i, j).reduce((s, x) => s + x.text.length, 0) || 1;
      let t = runStart;
      for (let k = i; k < j; k++) {
        const last = k === j - 1;
        const dur = Math.max((span * words[k].text.length) / totalChars, 0.05);
        const end = last ? Math.max(runStart + span, t + 0.05) : t + dur;
        words[k] = { ...words[k], start: +t.toFixed(3), end: +end.toFixed(3) };
        t = words[k].end;
        fixed++;
      }
      i = j;
    }
    return { ...seg, words, source: "corrected" as const };
  });
  return { transcript: out, fixed };
}

/**
 * Etapa 4: Legenda (karaokê).
 * Deriva as linhas de legenda da transcrição corrigida — NÃO re-transcreve.
 * Cada linha guarda as palavras com timestamp para o destaque karaokê.
 */
export interface CaptionLine {
  id: string;
  start: Seconds;
  end: Seconds;
  words: Word[];
}

/** Quebra a transcrição em linhas de no máximo `maxWords` palavras. */
export function buildCaptionLines(
  transcript: TranscriptSegment[],
  maxWords = 7,
): CaptionLine[] {
  const lines: CaptionLine[] = [];
  for (const seg of transcript) {
    for (let i = 0; i < seg.words.length; i += maxWords) {
      const words = seg.words.slice(i, i + maxWords);
      if (words.length === 0) continue;
      lines.push({
        id: `${seg.id}-l${i / maxWords}`,
        start: words[0].start,
        end: words[words.length - 1].end,
        words,
      });
    }
  }
  return lines;
}

/** Linha ativa em um dado tempo de reprodução. */
export function activeLine(lines: CaptionLine[], t: Seconds): CaptionLine | undefined {
  return lines.find((l) => t >= l.start && t <= l.end);
}
