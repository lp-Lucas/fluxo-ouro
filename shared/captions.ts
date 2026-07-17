import type { TranscriptSegment, Word, Cut, Caption, Seconds } from "./timeline.js";
import { remapTime, remapTimeClamped, type CutPlan } from "./cutplan.js";

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
/**
 * Linha exibível. Mesma forma da `Caption` do documento — de propósito: derivada e
 * materializada são intercambiáveis, então preview e render têm UM caminho só.
 */
export type CaptionLine = Caption;

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

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLE MANUAL — legendas materializadas (camada ajustável da timeline).
//
// Sem materializar, o tempo da legenda é um SUBPRODUTO das palavras e não há onde
// guardar um ajuste. Materializar congela as linhas em dado editável; a partir daí
// `captions` manda e a derivação some. Os cortes continuam dinâmicos.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Congela as linhas derivadas em dado editável (tempo de FONTE, cortes NÃO aplicados —
 * eles seguem dinâmicos na exibição). Copy-on-write: só roda no 1º ajuste manual.
 */
export function materializeCaptions(transcript: TranscriptSegment[], maxWords = 7): Caption[] {
  return buildCaptionLines(transcript, maxWords).map((l) => ({ ...l, words: l.words.map((w) => ({ ...w })) }));
}

/**
 * Aplica os cortes ativos às linhas materializadas — mesma semântica de
 * `stripCutsFromTranscript` (remove a palavra cortada; `shiftCaption` desloca).
 * A janela só é recalculada se a linha NÃO foi ajustada à mão.
 */
export function stripCutsFromLines(lines: CaptionLine[], cuts: Cut[]): CaptionLine[] {
  const active = cuts.filter((c) => c.enabled);
  if (active.length === 0) return lines;

  const removeCuts = active.filter((c) => !c.shiftCaption);
  const shiftCuts = active.filter((c) => c.shiftCaption);
  const overlaps = (w: Word, c: Cut) => w.start < c.end && w.end > c.start;

  const out: CaptionLine[] = [];
  for (const l of lines) {
    const words = l.words
      .filter((w) => !removeCuts.some((c) => overlaps(w, c)))
      .map((w) => {
        const c = shiftCuts.find((c) => overlaps(w, c));
        if (!c) return w;
        const d = c.end - c.start;
        return { ...w, start: w.start + d, end: w.end + d };
      });
    if (words.length === 0) continue; // linha inteira caiu no corte
    out.push({
      ...l,
      words,
      start: l.locked ? l.start : words[0].start,
      end: l.locked ? l.end : words[words.length - 1].end,
    });
  }
  return out;
}

/**
 * As linhas que valem AGORA, em tempo de FONTE. Ponto de entrada ÚNICO do preview e
 * do render — é o que garante o WYSIWYG. Materializadas mandam; sem elas, deriva da
 * transcrição (projetos antigos e quem nunca tocou na camada).
 */
export function resolveCaptionLines(
  transcript: TranscriptSegment[],
  cuts: Cut[],
  captions: Caption[] | undefined,
  maxWords = 7,
): CaptionLine[] {
  if (!captions?.length) return buildCaptionLines(stripCutsFromTranscript(transcript, cuts), maxWords);
  return stripCutsFromLines(captions, cuts);
}

/** Remapeia uma linha para o tempo de SAÍDA (pós-cortes). null = sumiu no corte. */
export function remapLineToOutput(line: CaptionLine, plan: CutPlan): CaptionLine | null {
  const words = line.words
    .map((w) => {
      const s = remapTime(w.start, plan), e = remapTime(w.end, plan);
      return s != null && e != null ? ({ ...w, start: s, end: e } as Word) : null;
    })
    .filter((w): w is Word => w !== null);
  if (words.length === 0) return null;
  const start = remapTimeClamped(line.start, plan);
  const end = remapTimeClamped(line.end, plan);
  if (end - start < 0.01) return null;
  return { ...line, start, end, words };
}

/**
 * Move/estica a janela reescalando as palavras junto (proporcional ao tamanho da
 * janela). É o que mantém o karaokê preenchendo a linha inteira: sem isso, esticar
 * deixaria a última palavra acesa e parada no fim.
 */
export function retimeLine(line: CaptionLine, start: Seconds, end: Seconds): CaptionLine {
  const s = +start.toFixed(3), e = +Math.max(start + 0.05, end).toFixed(3);
  const span = e - s;
  const oldSpan = line.end - line.start;
  const n = line.words.length;

  // Janela degenerada (linha criada do zero): distribui as palavras por igual.
  if (oldSpan <= 1e-6 || n === 0) {
    const words = line.words.map((w, i) => ({
      ...w,
      start: +(s + (span * i) / n).toFixed(3),
      end: +(s + (span * (i + 1)) / n).toFixed(3),
    }));
    return { ...line, start: s, end: e, words, locked: true };
  }

  const k = span / oldSpan;
  const map = (t: Seconds) => +(s + (t - line.start) * k).toFixed(3);
  return { ...line, start: s, end: e, words: line.words.map((w) => ({ ...w, start: map(w.start), end: map(w.end) })), locked: true };
}

/**
 * Divide a linha no tempo `t`. Cada palavra vai para o lado onde COMEÇA — nunca
 * parte uma palavra no meio. null = a divisão deixaria um lado vazio.
 */
export function splitLineAt(line: CaptionLine, t: Seconds): [Caption, Caption] | null {
  const left = line.words.filter((w) => w.start < t);
  const right = line.words.filter((w) => w.start >= t);
  if (left.length === 0 || right.length === 0) return null;
  const cut = +t.toFixed(3);
  return [
    { ...line, id: `${line.id}-a${Math.round(cut * 1000)}`, start: line.start, end: cut, words: left, locked: true },
    { ...line, id: `${line.id}-b${Math.round(cut * 1000)}`, start: cut, end: line.end, words: right, locked: true },
  ];
}

/** Funde duas linhas vizinhas numa só (palavras concatenadas na ordem do tempo). */
export function mergeLines(a: CaptionLine, b: CaptionLine): Caption {
  const [first, second] = a.start <= b.start ? [a, b] : [b, a];
  return {
    ...first,
    start: Math.min(a.start, b.start),
    end: Math.max(a.end, b.end),
    words: [...first.words, ...second.words].sort((p, q) => p.start - q.start),
    locked: true,
  };
}

/** Texto da linha (derivado das palavras — nunca guardado, nunca dessincroniza). */
export function lineText(line: CaptionLine): string {
  return line.words.map((w) => w.text).join(" ");
}

/** Duração abaixo da qual a palavra é um piscar (não dá pra ler no karaokê). */
const MIN_WORD = 0.08;
/** Buraco interno a partir do qual a linha "trava": está na tela e nada acende. */
const MAX_GAP = 0.35;

/**
 * A linha tem timing quebrado? Dois sintomas, ambos vindos da transcrição:
 *  - palavra de duração ~zero (colapso do Whisper / bug antigo do editWord);
 *  - buraco morto entre palavras — a linha fica na tela sem nenhuma palavra ativa,
 *    e o karaokê parece travado na primeira.
 * Só DETECTA. Consertar move palavra, e isso é decisão do usuário.
 */
export function needsTimingRepair(line: CaptionLine): boolean {
  const w = line.words;
  // EPS: as palavras travadas no piso saem de distributeWords arredondadas a 3 casas,
  // e a subtração devolve 0.0799999… — sem tolerância o detector reprovaria o próprio
  // conserto e a linha ficaria marcada como quebrada pra sempre.
  const EPS = 1e-6;
  for (let i = 0; i < w.length; i++) {
    if (w[i].end - w[i].start < MIN_WORD - EPS) return true;
    if (i > 0 && w[i].start - w[i - 1].end > MAX_GAP + EPS) return true;
  }
  return false;
}

/**
 * Espalha as palavras por igual na janela (proporcional ao tamanho do texto).
 *
 * Isto DESANCORA da fala — de propósito. `retimeLine` reescala proporcionalmente, o que
 * preserva um amassado ("que" 0.24s, buraco de 1s, "é" 7ms, "dono" 76ms): arrastar a
 * borda estica o buraco junto e nunca conserta. Quando o timing original não presta,
 * distribuir é o único jeito de a linha ficar legível.
 */
export function distributeWords(line: CaptionLine): CaptionLine {
  const n = line.words.length;
  if (n === 0) return line;
  // Janela curta demais p/ caber o piso em cada palavra → estica a linha. Sem isso a
  // distribuição nasceria quebrada de novo (ex.: 3 palavras em 0.18s).
  const span = Math.max(line.end - line.start, MIN_WORD * n);

  // Proporcional ao tamanho do texto, mas com PISO por palavra: quem cai abaixo do
  // piso trava nele e a sobra é redividida entre as demais. Sem o piso, palavra de 1
  // letra ("e", "o") fica com ~70ms e continua piscando mesmo numa janela folgada.
  const peso = line.words.map((w) => Math.max(1, w.text.length));
  const dur = new Array<number>(n).fill(0);
  const travada = new Array<boolean>(n).fill(false);
  for (;;) {
    const usado = dur.reduce((s, d, i) => s + (travada[i] ? d : 0), 0);
    const livre = span - usado;
    const somaPeso = peso.reduce((s, p, i) => s + (travada[i] ? 0 : p), 0);
    if (somaPeso <= 0) break;
    let mudou = false;
    for (let i = 0; i < n; i++) {
      if (travada[i]) continue;
      const d = (livre * peso[i]) / somaPeso;
      if (d < MIN_WORD) { dur[i] = MIN_WORD; travada[i] = true; mudou = true; }
      else dur[i] = d;
    }
    if (!mudou) break;
  }

  let t = line.start;
  const words = line.words.map((w, i) => {
    const start = t;
    // A última encosta no fim exato da janela (sem sobra por arredondamento).
    const end = i === n - 1 ? line.start + span : t + dur[i];
    t = end;
    return { ...w, start: +start.toFixed(3), end: +end.toFixed(3) };
  });
  return { ...line, start: line.start, end: +(line.start + span).toFixed(3), words };
}

/** Trecho de FALA real (borda medida pelo VAD), em segundos. */
export interface SpeechSpan {
  start: Seconds;
  end: Seconds;
}

// ─────────────────────────────────────────────────────────────────────────────
// REALINHAMENTO FINO — casa os tempos de uma RE-TRANSCRIÇÃO LOCAL com o texto
// que o usuário já tem.
//
// Por que existe: o timestamp de palavra do Whisper deriva na transcrição LONGA
// (janelas de 30s encadeadas acumulam erro no meio do vídeo). Re-transcrever cada
// trecho de fala do VAD isoladamente dá tempos locais precisos — mas texto novo.
// Aqui adotamos SÓ OS TEMPOS das palavras novas cujo texto casa com o existente
// (alinhamento por LCS, monotônico, com trava de distância temporal). O texto do
// usuário — correções manuais incluídas — nunca muda.
// ─────────────────────────────────────────────────────────────────────────────

/** Normaliza p/ casamento: minúsculas, sem acento, sem pontuação. */
function normToken(t: string): string {
  return t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Janelas de re-transcrição a partir dos trechos de fala do VAD. ≤28s cada — o Whisper
 * processa até 30s numa janela só; passar disso ele ENCADEIA janelas e o timestamp volta
 * a derivar (a causa raiz que o realinhamento existe pra matar). Pad curto de contexto;
 * funde só vizinhos colados.
 */
export function buildRealignWindows(
  speech: SpeechSpan[],
  opts?: { padMs?: number; mergeGapMs?: number; maxLenMs?: number },
): { startMs: number; endMs: number }[] {
  const pad = opts?.padMs ?? 150;
  const mergeGap = opts?.mergeGapMs ?? 350;
  const maxLen = opts?.maxLenMs ?? 28_000;
  const wins: { startMs: number; endMs: number }[] = [];
  for (const s of speech) {
    const a = Math.max(0, Math.round(s.start * 1000) - pad);
    const b = Math.round(s.end * 1000) + pad;
    const last = wins[wins.length - 1];
    if (last && a - last.endMs < mergeGap && b - last.startMs <= maxLen) last.endMs = Math.max(last.endMs, b);
    else wins.push({ startMs: a, endMs: b });
  }
  return wins;
}

export interface RealignResult {
  captions: Caption[];
  /** palavras existentes que casaram com a re-transcrição (tempos adotados) */
  matched: number;
  /** palavras sem par (texto corrigido à mão etc.) — interpoladas entre âncoras */
  interpolated: number;
  total: number;
  /** linhas NOVAS criadas onde havia fala sem legenda nenhuma */
  added: number;
  /** ECOS removidos: linhas duplicando fala que a re-transcrição ouviu UMA vez */
  removed: number;
  /** palavras-eco aparadas da fronteira entre linhas vizinhas (duplicação parcial) */
  trimmedWords: number;
}

/**
 * Realinha as legendas aos tempos de `fresh` (palavras da re-transcrição local, em
 * tempo absoluto e ordenadas). Regras:
 *  - casa por texto normalizado, em ORDEM (LCS) e só se |Δt| ≤ maxDrift — palavra
 *    repetida ("marketing" aparece 6×) não cruza para outra ocorrência;
 *  - palavra casada adota o tempo novo; não casada interpola entre as âncoras
 *    vizinhas (proporcional ao tamanho do texto);
 *  - a janela da linha vira o span das palavras (locked é dispensado: a janela
 *    agora É a fala);
 *  - fala re-transcrita SEM nenhuma legenda por cima vira linha nova (o buraco de
 *    texto no começo do vídeo, p.ex.) — agrupada de `maxWords` em `maxWords`.
 */
export function realignCaptionsToWords(
  captions: Caption[],
  fresh: Word[],
  opts?: { maxDrift?: Seconds; maxWords?: number },
): RealignResult {
  // 2.0s: acima do drift real do Whisper (≤1s) E de linhas arrastadas/clampadas pelo
  // usuário (~1.7s visto em produção); abaixo da distância típica de um RETAKE
  // ("E dia… [pausa] E dia 23" a 2.98s) — trava maior grudava na ocorrência errada.
  const maxDrift = opts?.maxDrift ?? 2.0;
  const maxWords = opts?.maxWords ?? 3;

  const ord = [...captions].sort((a, b) => a.start - b.start);
  // achata as palavras existentes preservando de que linha vieram
  const flat: { li: number; wi: number; w: Word }[] = [];
  ord.forEach((l, li) => l.words.forEach((w, wi) => flat.push({ li, wi, w })));
  const B = fresh
    .map((w) => ({ ...w, text: w.text.trim() }))
    .filter((w) => normToken(w.text).length > 0)
    .sort((a, b) => a.start - b.start);

  // LCS clássico com trava temporal (O(n·m) — centenas × centenas, trivial)
  const n = flat.length, m = B.length;
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  const eq = (i: number, j: number) => {
    const a = normToken(flat[i].w.text);
    if (a !== normToken(B[j].text)) return false;
    const d = Math.abs(flat[i].w.start - B[j].start);
    // token de 1 letra ("a", "e", "o") casa promíscuo — exige vizinhança apertada
    return d <= (a.length <= 1 ? 0.6 : maxDrift);
  };
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = eq(i, j)
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairA = new Int32Array(n).fill(-1); // índice em B de cada palavra existente
  const usedB = new Uint8Array(m);
  {
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (eq(i, j) && dp[i][j] === dp[i + 1][j + 1] + 1) { pairA[i] = j; usedB[j] = 1; i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
  }

  // aplica: casada = tempo novo; não casada = interpola entre âncoras vizinhas
  const newTimes: { start: number; end: number }[] = flat.map(({ w }) => ({ start: w.start, end: w.end }));
  let matched = 0;
  for (let i = 0; i < n; i++) {
    if (pairA[i] < 0) continue;
    const f = B[pairA[i]];
    newTimes[i] = { start: f.start, end: Math.max(f.end, f.start + 0.02) };
    matched++;
  }
  let interpolated = 0;
  {
    let i = 0;
    while (i < n) {
      if (pairA[i] >= 0) { i++; continue; }
      let j = i;
      while (j < n && pairA[j] < 0) j++; // corrida sem par [i..j)
      const loA = i > 0 ? newTimes[i - 1].end : undefined;
      const hiA = j < n ? newTimes[j].start : undefined;
      // sem âncora dos dois lados (tudo sem par): mantém os tempos originais
      if (loA != null || hiA != null) {
        const run = flat.slice(i, j);
        const durOrig = run[run.length - 1].w.end - run[0].w.start;
        const lo = loA ?? Math.max(0, (hiA ?? 0) - Math.max(durOrig, 0.08 * run.length));
        const hi = hiA ?? lo + Math.max(durOrig, 0.08 * run.length);
        const span = Math.max(hi - lo, 0.08 * run.length);
        const total = run.reduce((s, x) => s + Math.max(1, x.w.text.length), 0);
        let t = lo;
        for (let k = i; k < j; k++) {
          const dur = (span * Math.max(1, flat[k].w.text.length)) / total;
          newTimes[k] = { start: +t.toFixed(3), end: +(t + dur).toFixed(3) };
          t += dur;
          interpolated++;
        }
      }
      i = j;
    }
  }
  // monotonicidade ESTRITA: fala é sequencial, palavra nunca sobrepõe a anterior
  for (let i = 1; i < n; i++) {
    if (newTimes[i].start < newTimes[i - 1].end) newTimes[i] = { ...newTimes[i], start: newTimes[i - 1].end };
    if (newTimes[i].end < newTimes[i].start + 0.02) newTimes[i] = { ...newTimes[i], end: newTimes[i].start + 0.02 };
  }

  // remonta as linhas (janela = span das palavras; o texto não muda)
  const outLines: Caption[] = ord.map((l, li) => {
    const idxs = flat.map((x, i) => ({ x, i })).filter(({ x }) => x.li === li).map(({ i }) => i);
    const words = l.words.map((w, wi) => {
      const k = idxs[wi];
      return { ...w, start: +newTimes[k].start.toFixed(3), end: +newTimes[k].end.toFixed(3) };
    });
    return { ...l, words, start: words[0].start, end: words[words.length - 1].end, locked: undefined };
  });

  // ── ECOS: a transcrição canônica às vezes duplica um trecho (fim do seg N repete o
  // começo do seg N+1 — visto em produção: "…o barco afundar, ou seja o Titanic…" 2×).
  // A fala existe UMA vez, então a re-transcrição só dá tempos a UM agrupamento; a linha
  // que ficou com ZERO palavra casada E cujo texto já está coberto pelas vizinhas
  // casadas é eco — cai. (Linha sem par mas com conteúdo próprio — correção manual —
  // nunca é derrubada: a cobertura falha.)
  const matchedPerLine = ord.map((_, li) => {
    let k = 0;
    for (let i = 0; i < n; i++) if (flat[i].li === li && pairA[i] >= 0) k++;
    return k;
  });
  const ecoDrop = new Set<number>();
  outLines.forEach((l, li) => {
    if (matchedPerLine[li] > 0) return;
    const toks = l.words.map((w) => normToken(w.text)).filter(Boolean);
    if (toks.length === 0) { ecoDrop.add(li); return; }
    const bag = new Set(
      outLines.flatMap((o, oi) =>
        oi !== li && matchedPerLine[oi] > 0 && Math.abs(o.start - l.start) <= 4
          ? o.words.map((w) => normToken(w.text))
          : [],
      ),
    );
    const cobertos = toks.filter((t) => bag.has(t)).length;
    if (cobertos / toks.length >= 0.6) ecoDrop.add(li);
  });

  // Eco PARCIAL na fronteira: quando a duplicação da transcrição não cobre a linha
  // inteira, cada agrupamento casa um pedaço e a palavra dita uma vez aparece em DUAS
  // linhas vizinhas ("seja o Titanic," | "Titanic, ele afundou"). Apara da borda a
  // palavra NÃO-casada que duplica palavra CASADA da vizinha imediata. Se a fala
  // realmente repetisse, a re-transcrição teria as duas ocorrências e ambas casariam.
  const seq = outLines
    .map((l, li) => ({ l: { ...l, words: [...l.words] }, m: l.words.map((_, wi) => {
      for (let i = 0; i < n; i++) if (flat[i].li === li && flat[i].wi === wi) return pairA[i] >= 0;
      return false;
    }), li }))
    .filter((x) => !ecoDrop.has(x.li));
  let trimmedWords = 0;
  for (let i = 1; i < seq.length; i++) {
    const A = seq[i - 1], B = seq[i];
    if (A.l.words.length === 0 || B.l.words.length === 0) continue;
    if (B.l.words[0].start - A.l.words[A.l.words.length - 1].end > 1.5) continue;
    const bLead = B.l.words.slice(0, 3).filter((_, k) => B.m[k]).map((w) => normToken(w.text));
    while (A.l.words.length > 0 && !A.m[A.l.words.length - 1] &&
      bLead.includes(normToken(A.l.words[A.l.words.length - 1].text))) {
      A.l.words.pop(); A.m.pop(); trimmedWords++;
    }
    const tailBase = Math.max(0, A.l.words.length - 3);
    const aTail = A.l.words.slice(tailBase).filter((_, k) => A.m[tailBase + k]).map((w) => normToken(w.text));
    while (B.l.words.length > 0 && !B.m[0] && aTail.includes(normToken(B.l.words[0].text))) {
      B.l.words.shift(); B.m.shift(); trimmedWords++;
    }
  }
  const keptLines: Caption[] = seq
    .filter((x) => x.l.words.length > 0)
    .map((x) => {
      const l = { ...x.l, start: x.l.words[0].start, end: x.l.words[x.l.words.length - 1].end };
      // linha que perdeu palavra na apara pode ficar com janela ilegível → estica ao piso
      return l.end - l.start < MIN_WORD * l.words.length ? (distributeWords(l) as Caption) : l;
    });
  const esvaziadas = seq.length - keptLines.length;

  // fala sem legenda: palavras novas não usadas, fora de qualquer linha → linhas novas
  const added: Caption[] = [];
  {
    const livre = (w: Word) => !keptLines.some((l) => w.start < l.end && w.end > l.start);
    const orfas = B.filter((w, j) => !usedB[j] && livre(w));
    let grupo: Word[] = [];
    const flush = () => {
      while (grupo.length > 0) {
        const chunk = grupo.slice(0, maxWords);
        grupo = grupo.slice(maxWords);
        added.push({
          id: `cap-fill-${Math.round(chunk[0].start * 1000)}`,
          start: +chunk[0].start.toFixed(3),
          end: +chunk[chunk.length - 1].end.toFixed(3),
          words: chunk.map((w) => ({ text: w.text, start: w.start, end: w.end })),
        });
      }
    };
    for (const w of orfas) {
      if (grupo.length && w.start - grupo[grupo.length - 1].end > 0.6) flush();
      grupo.push(w);
    }
    flush();
  }

  // saneia o conjunto: fill que duplica texto vizinho cai, sobreposição é clampada —
  // sem isso, linha existente desalinhada + re-escuta do mesmo trecho = eco empilhado.
  const captionsOut = sanitizeCaptions([...keptLines, ...added]);
  const addedIds = new Set(added.map((c) => c.id));
  const addedFinal = captionsOut.filter((c) => addedIds.has(c.id)).length;
  // `removed` conta no PONTO FINAL: eco-drop, esvaziadas na apara E duplicatas que o
  // sanitize derrubou — senão o relatório mente para o usuário sobre o que saiu.
  const removedFinal = ord.filter((c) => !captionsOut.some((x) => x.id === c.id)).length;
  void esvaziadas;
  return {
    captions: captionsOut, matched, interpolated, total: n,
    added: addedFinal, removed: removedFinal, trimmedWords,
  };
}

/** Nº de pares consecutivos sobrepostos (legenda "dentro" da outra na timeline). */
export function countCaptionOverlaps(lines: CaptionLine[]): number {
  const ord = [...lines].sort((a, b) => a.start - b.start);
  let n = 0;
  for (let i = 1; i < ord.length; i++) if (ord[i].start < ord[i - 1].end - 1e-3) n++;
  return n;
}

/**
 * SANEIA o conjunto: legenda é trilha sequencial — sobreposição é estado quebrado
 * (os blocos se empilham na timeline e o preview só mostra a primeira).
 *  1) fill automático (`cap-fill-`) cujo texto já está coberto pelas linhas REAIS
 *     vizinhas (±4s) é eco de retake/re-escuta — cai fora (nunca derruba linha sua);
 *  2) duplicata exata sobreposta (mesmo texto normalizado) → fica a primeira;
 *  3) sobreposição restante → a linha de trás é encolhida até a da frente começar
 *     (palavras reescalam junto; `locked` preservado).
 */
export function sanitizeCaptions(captions: Caption[]): Caption[] {
  const ord = [...captions].sort((a, b) => a.start - b.start);

  // 1) fills cujo conteúdo já existe nas linhas não-fill vizinhas
  const reais = ord.filter((c) => !c.id.startsWith("cap-fill-"));
  const passo1 = ord.filter((c) => {
    if (!c.id.startsWith("cap-fill-")) return true;
    const toks = c.words.map((w) => normToken(w.text)).filter(Boolean);
    if (toks.length === 0) return false;
    const bag = new Set(
      reais.filter((o) => Math.abs(o.start - c.start) <= 4).flatMap((o) => o.words.map((w) => normToken(w.text))),
    );
    const cobertos = toks.filter((t) => bag.has(t)).length;
    return cobertos / toks.length < 0.6;
  });

  // 2) duplicata exata sobreposta
  const passo2: Caption[] = [];
  for (const c of passo1) {
    const prev = passo2[passo2.length - 1];
    const dup = passo2.some(
      (o) => c.start < o.end + 0.05 && c.end > o.start - 0.05 &&
        c.words.map((w) => normToken(w.text)).join(" ") === o.words.map((w) => normToken(w.text)).join(" "),
    );
    if (dup) continue;
    void prev;
    passo2.push(c);
  }

  // 3) clampa sobreposições (a de trás encolhe até a da frente)
  const out: Caption[] = [];
  for (const c of passo2) {
    const prev = out[out.length - 1];
    if (prev && c.start < prev.end) {
      const novoFim = Math.max(prev.start + 0.05, c.start);
      out[out.length - 1] = { ...retimeLine(prev, prev.start, novoFim), locked: prev.locked };
      if (c.start < prev.start + 0.05) {
        out.push({ ...retimeLine(c, out[out.length - 1].end, Math.max(c.end, out[out.length - 1].end + 0.05)), locked: c.locked });
        continue;
      }
    }
    out.push(c);
  }
  return out;
}

/** Desloca TODAS as legendas (janela + palavras) em `delta` segundos. Clampa em 0. */
export function shiftCaptions(captions: Caption[], delta: Seconds): Caption[] {
  return captions.map((c) => {
    const s = Math.max(0, c.start + delta);
    const off = s - c.start; // se clampou, as palavras deslocam o mesmo tanto
    return {
      ...c,
      start: +s.toFixed(3),
      end: +(c.end + off).toFixed(3),
      words: c.words.map((w) => ({ ...w, start: +Math.max(0, w.start + off).toFixed(3), end: +(w.end + off).toFixed(3) })),
    };
  });
}

/** Conserta SÓ as linhas quebradas — as saudáveis não se mexem (karaokê segue na fala). */
export function repairCaptionTimings(captions: Caption[]): { captions: Caption[]; fixed: number } {
  let fixed = 0;
  const out = captions.map((c) => {
    if (!needsTimingRepair(c)) return c;
    fixed++;
    return { ...distributeWords(c), locked: true } as Caption;
  });
  return { captions: out, fixed };
}

/**
 * Linha nova a partir de texto digitado: as palavras são distribuídas por igual na
 * janela (não há fala pra ancorar). Karaokê funciona igual.
 */
export function captionFromText(text: string, start: Seconds, end: Seconds, id: string): Caption | null {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const span = Math.max(0.05, end - start);
  const words: Word[] = parts.map((text, i) => ({
    text,
    start: +(start + (span * i) / parts.length).toFixed(3),
    end: +(start + (span * (i + 1)) / parts.length).toFixed(3),
  }));
  return { id, start: +start.toFixed(3), end: +(start + span).toFixed(3), words, locked: true };
}
