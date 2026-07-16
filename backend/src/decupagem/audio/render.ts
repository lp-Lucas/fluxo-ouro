import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * FASE 4 — RENDER DE ÁUDIO. Uma ÚNICA passada de ffmpeg → `audio_decupado.wav`: os
 * trechos MANTIDOS (segmentos do CutPlan, tempo de FONTE) emendados com crossfade
 * equal-power (curva qsin) SEM ENCURTAR A SAÍDA.
 *
 * DURAÇÃO PRESERVADA (bug medido e corrigido, 2026-07-09): `acrossfade` cru consome a
 * região de sobreposição — 2 emendas de 10ms encurtavam a saída em 20ms; com dezenas de
 * cortes o áudio dessincronizava progressivamente do vídeo (cutplan.ts calcula outStart
 * por aritmética pura e não sabe do encolhimento). Correção: cada segmento é estendido
 * +5ms em cada borda INTERNA, tomando material do TRECHO CORTADO adjacente (que existe no
 * arquivo fonte). As rampas do crossfade vivem nessas extensões emprestadas; o crossfade
 * consome exatamente elas, então a soma telescopa e a saída = Σ(srcEnd−srcStart) EXATO.
 * Bordas do vídeo (início do 1º segmento, fim do último): não há material adjacente →
 * fade simples de 5ms para dentro. `cutplan.ts` continua aritmética pura — intocado.
 *
 * FONTE ÚNICA: este WAV é o áudio do EXPORT (Remotion <Audio> global, OffthreadVideo
 * mudos). O PREVIEW ainda toca o <video> original com seek (janela de divergência
 * consciente — ver o WARN no server.ts). No WIRING: upload-once por hash do File, cada
 * mudança de plano regenera só o WAV a partir do PCM já no servidor (~1s, debounced);
 * o preview passa a tocar ESTE WAV em tempo-saída, `fixAudioUrl` morre, sem Web Audio.
 *
 * Determinístico: mesmas entradas → bytes idênticos (`-bitexact`, sem metadado).
 */

export interface KeptSpan {
  srcStart: number; // segundos, tempo da FONTE
  srcEnd: number;
}

export interface RenderAudioOpts {
  crossfadeMs?: number; // default 10 (5ms emprestados de cada lado)
  sampleRate?: number;  // default 48000
  channels?: number;    // default 2
}

/** Funde segmentos CONTÍGUOS (srcEnd == próximo srcStart) num só — não há emenda ali. */
function coalesce(spans: KeptSpan[]): KeptSpan[] {
  const sorted = [...spans].sort((a, b) => a.srcStart - b.srcStart);
  const out: KeptSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.srcStart - last.srcEnd < 1e-6) last.srcEnd = Math.max(last.srcEnd, s.srcEnd);
    else out.push({ ...s });
  }
  return out;
}

/**
 * Monta o filter_complex. Cada emenda interna estende os dois segmentos +r no material
 * cortado e cruza com d=2r; as bordas externas não estendem (lL[0]=lR[N-1]=0) → a saída
 * telescopa para Σ(srcEnd−srcStart). Fade de 5ms nas duas pontas do resultado.
 */
export function buildFilterComplex(rawSpans: KeptSpan[], crossfadeMs: number): { filter: string; outLabel: string } {
  const spans = coalesce(rawSpans);
  const N = spans.length;
  const perSide = crossfadeMs / 2 / 1000; // 5ms em segundos
  const fade = perSide.toFixed(6);
  const total = spans.reduce((a, s) => a + (s.srcEnd - s.srcStart), 0);
  const fadeOutSt = Math.max(0, total - perSide).toFixed(6);

  // r por emenda i (entre segmento i e i+1), limitado a metade da folga do corte
  const r: number[] = [];
  for (let i = 0; i < N - 1; i++) {
    const gap = spans[i + 1].srcStart - spans[i].srcEnd;
    r.push(Math.max(0, Math.min(perSide, gap / 2)));
  }
  // extensões: lL[0]=0, lR[N-1]=0; internas emprestam do corte adjacente
  const lL = new Array(N).fill(0), lR = new Array(N).fill(0);
  for (let i = 0; i < N - 1; i++) { lR[i] = r[i]; lL[i + 1] = r[i]; }

  const trims = spans.map((s, i) =>
    `[0:a]atrim=start=${(s.srcStart - lL[i]).toFixed(6)}:end=${(s.srcEnd + lR[i]).toFixed(6)},asetpts=PTS-STARTPTS[t${i}]`,
  );

  if (N === 1) {
    return { filter: `${trims[0]};[t0]afade=t=in:d=${fade},afade=t=out:st=${fadeOutSt}:d=${fade}[aout]`, outLabel: "aout" };
  }

  const xf: string[] = [];
  let prev = "t0";
  for (let i = 1; i < N; i++) {
    const d = (r[i - 1] * 2).toFixed(6); // d = lR[i-1] + lL[i] = 2·r[i-1]
    const mid = `x${i}`;
    xf.push(`[${prev}][t${i}]acrossfade=d=${d}:c1=qsin:c2=qsin[${mid}]`);
    prev = mid;
  }
  const fadeStage = `[${prev}]afade=t=in:d=${fade},afade=t=out:st=${fadeOutSt}:d=${fade}[aout]`;
  return { filter: [...trims, ...xf, fadeStage].join(";"), outLabel: "aout" };
}

/**
 * Gera `outPath` (WAV pcm_s16le) a partir de `mediaPath` mantendo só os `spans`,
 * emendados com crossfade equal-power que NÃO encurta a saída. Devolve o caminho gerado.
 */
export async function renderDecupadoAudio(
  mediaPath: string, spans: KeptSpan[], outPath: string, opts: RenderAudioOpts = {},
): Promise<string> {
  if (spans.length === 0) throw new Error("renderDecupadoAudio: nenhum segmento mantido.");
  const crossfadeMs = opts.crossfadeMs ?? 10;
  const sampleRate = opts.sampleRate ?? 48000;
  const channels = opts.channels ?? 2;

  const { filter, outLabel } = buildFilterComplex(spans, crossfadeMs);

  await execFileP("ffmpeg", [
    "-hide_banner", "-v", "error", "-y",
    "-bitexact", "-fflags", "+bitexact",
    "-i", mediaPath,
    "-filter_complex", filter,
    "-map", `[${outLabel}]`,
    "-ar", String(sampleRate), "-ac", String(channels),
    "-c:a", "pcm_s16le",
    "-flags", "+bitexact", "-map_metadata", "-1",
    outPath,
  ], { maxBuffer: 1 << 30 });

  return outPath;
}
