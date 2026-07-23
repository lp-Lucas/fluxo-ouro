/**
 * TRATAMENTO DE ÁUDIO (o "Adobe Podcast" do Fluxo Ouro).
 *
 * Pipeline, em duas etapas de custo bem diferente (ver shared/audio.ts):
 *
 *   origem ──extrai──► dry.wav (48k mono)
 *                        │
 *                        ├─► [ETAPA 1 · CARA] isolamento da voz por chunks ──► stem.wav
 *                        │        cache pela ORIGEM apenas → roda 1× por vídeo
 *                        │
 *                        └─► [ETAPA 2 · BARATA] masterização local (ffmpeg) ──► tratado.m4a
 *                                 dry/wet · highpass · de-esser · presença ·
 *                                 compressor adaptativo · ganho fixo · limitador
 *
 * REGRA INEGOCIÁVEL: a saída tem EXATAMENTE a duração da origem. Os cortes, as
 * legendas e os popups são todos em tempo de FONTE — um único milissegundo de
 * deriva desincroniza o projeto inteiro. Por isso o áudio isolado é remontado por
 * POSIÇÃO ABSOLUTA (não por concatenação em sequência, que acumularia o atraso do
 * decoder a cada chunk) e a saída é aparada/preenchida na marra no final.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runFfmpeg, probeDuration } from "../flow/ffmpeg.js";
import { isolarVoz, isolamentoDisponivel, type MotorIsolamento, type ResultadoIsolamento } from "./isolate.js";
import { LOUDNESS, masterParams, type AudioSettings } from "../../../shared/audio.js";

const execFileP = promisify(execFile);

/**
 * Chunk mandado pro isolamento (s) e sobreposição entre chunks (s). Ajustáveis por
 * env: se o limite de tamanho/tempo da API mudar, dá pra afinar sem novo deploy.
 * Devem ser INTEIROS — os offsets viram milissegundos exatos no `adelay`.
 */
const CHUNK_S = Math.max(10, Math.round(Number(process.env.AUDIO_CHUNK_S ?? 240)));
const OVER_S = Math.max(1, Math.round(Number(process.env.AUDIO_CHUNK_OVERLAP_S ?? 1)));

/**
 * Versões de cache, embutidas no nome dos arquivos. São DUAS de propósito, porque
 * as duas etapas têm custos opostos: mexer na masterização (local, grátis) não pode
 * jogar fora o stem (remoto, cobrado). Incrementar a que realmente mudou.
 */
const STEM_V = 2;   // isolamento + alinhamento. Bumpar aqui RECOBRA crédito.
const MASTER_V = 2; // m2: ganho fixo + limitador no lugar do loudnorm dinâmico

export interface ProgressoAudio {
  /** 0..1 */
  p: number;
  etapa: string;
}

export interface ResultadoTratamento {
  /** Caminho do arquivo tratado (m4a). */
  outPath: string;
  motor: MotorIsolamento;
  /** Por que caiu no fallback (chave sem escopo, sem chave...). Ausente = tudo certo. */
  aviso?: string;
  lufsAntes?: number;
  lufsDepois?: number;
}

/** Chave estável da ORIGEM (nome + tamanho + mtime). Barata, sem ler o arquivo. */
export function chaveOrigem(sourcePath: string): string {
  const st = fs.statSync(sourcePath);
  return crypto.createHash("md5")
    .update(`${path.basename(sourcePath)}:${st.size}:${Math.floor(st.mtimeMs)}`)
    .digest("hex").slice(0, 12);
}

/**
 * Trata o áudio de `sourcePath` (vídeo ou áudio) conforme `cfg`.
 * `workDir` é onde ficam os caches (uploads/). Idempotente: se o resultado já
 * existe pra (origem + ajustes), devolve na hora.
 */
export async function tratarAudio(
  sourcePath: string,
  cfg: AudioSettings,
  workDir: string,
  opts: { signal?: AbortSignal; onProgress?: (p: ProgressoAudio) => void; forcar?: boolean } = {},
): Promise<ResultadoTratamento> {
  const { signal, onProgress, forcar } = opts;
  const prog = (p: number, etapa: string) => onProgress?.({ p, etapa });

  const key = chaveOrigem(sourcePath);
  const paramHash = crypto.createHash("md5").update(masterParams(cfg)).digest("hex").slice(0, 8);
  const outPath = path.join(workDir, `audio-tratado-m${MASTER_V}-${key}-${paramHash}.m4a`);
  const stemWav = path.join(workDir, `voz-isolada-v${STEM_V}-${key}.wav`);

  // "Tratar de novo": joga fora o resultado E o stem. Descartar só o resultado não
  // adiantaria nada — o stem em cache é o que carrega a limpeza, então remasterizar
  // em cima dele devolveria exatamente o mesmo áudio. É por isso que este botão
  // custa crédito: ele REFAZ o isolamento (é o ponto dele — trocar o motor, por
  // exemplo depois de habilitar o escopo da chave).
  if (forcar) {
    fs.rmSync(outPath, { force: true });
    fs.rmSync(stemWav, { force: true });
  }

  const duracao = await probeDuration(sourcePath);
  if (!(duracao > 0)) throw new Error("Não consegui ler a duração do áudio de origem.");

  // ── extração (cache pela origem) ────────────────────────────────────────────
  const dryWav = path.join(workDir, `audio-dry-${key}.wav`); // extração pura: não depende do pipeline
  if (!fs.existsSync(dryWav)) {
    prog(0.03, "Extraindo o áudio");
    await extrairWav(sourcePath, dryWav, signal);
  }
  const lufsAntes = await medirLufs(dryWav, signal).catch(() => undefined);

  if (fs.existsSync(outPath)) {
    return { outPath, motor: isolamentoDisponivel() ? "isolamento" : "local", lufsAntes };
  }

  // ── ETAPA 1 · isolamento (cache pela origem — muda slider, não re-roda) ─────
  let iso: ResultadoIsolamento = { motor: isolamentoDisponivel() ? "isolamento" : "local" };
  if (!fs.existsSync(stemWav)) {
    iso = await isolarPorChunks(dryWav, stemWav, duracao, workDir, {
      signal,
      onProgress: (p) => prog(0.05 + p * 0.8, "Isolando a voz"),
    });
  }

  // ── alinhamento (barato, decisivo) ─────────────────────────────────────────
  // Todo motor de limpeza atrasa o sinal: os filtros de FFT do fallback custam
  // ~25 ms POR passada, e a API tem a latência dela, que muda sem aviso. 50 ms
  // de atraso é o bastante pra descolar a voz da imagem e das legendas. Em vez de
  // subtrair um número mágico, MEÇO o deslocamento contra o áudio original e
  // corrijo — vale pros dois motores e sobrevive a qualquer mudança deles.
  await alinharStem(dryWav, stemWav, duracao, signal);

  // ── ETAPA 2 · masterização (local, segundos) ───────────────────────────────
  prog(0.88, "Masterizando");
  const lufsDepois = await masterizar(dryWav, stemWav, cfg, duracao, outPath, signal);
  prog(1, "Pronto");

  return { outPath, motor: iso.motor, aviso: iso.aviso, lufsAntes, lufsDepois };
}

/** Áudio da origem em WAV 48k mono — a base sample-exata de todo o resto. */
async function extrairWav(sourcePath: string, outWav: string, signal?: AbortSignal): Promise<void> {
  await runFfmpeg([
    "-y", "-i", sourcePath, "-vn",
    "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outWav,
  ], signal, "audio-extrair");
}

/**
 * Isola a voz do arquivo inteiro fatiando em chunks com sobreposição e remontando
 * por POSIÇÃO ABSOLUTA (adelay) com crossfade equal-power (afade qsin) nas bordas.
 *
 * Por que absoluto e não `acrossfade` em cadeia: cada chunk volta da API como um
 * arquivo próprio, e todo decoder introduz um pequeno atraso. Emendando em
 * sequência esse atraso SOMA a cada chunk — num vídeo de 40 min viraria centenas
 * de ms de dessincronia com a imagem. Ancorado no tempo absoluto, o atraso vira
 * uma constante inaudível e idêntica pra todos.
 */
async function isolarPorChunks(
  dryWav: string, outWav: string, duracao: number, workDir: string,
  opts: { signal?: AbortSignal; onProgress?: (p: number) => void },
): Promise<ResultadoIsolamento> {
  const { signal, onProgress } = opts;

  // Caso simples: cabe num chunk só.
  if (duracao <= CHUNK_S + 5) {
    const r = await isolarVoz(dryWav, outWav, signal);
    onProgress?.(1);
    return r;
  }

  const passo = CHUNK_S - OVER_S;
  const inicios: number[] = [];
  for (let t = 0; t < duracao; t += passo) inicios.push(t);

  const partes: { file: string; start: number; len: number }[] = [];
  let iso: ResultadoIsolamento = { motor: "local" };
  try {
    for (let i = 0; i < inicios.length; i++) {
      const start = inicios[i];
      const len = Math.min(CHUNK_S, duracao - start);
      if (len <= 0.05) break;

      const fatia = path.join(workDir, `.iso-${path.basename(outWav)}-${i}.wav`);
      const limpo = path.join(workDir, `.iso-${path.basename(outWav)}-${i}-ok.wav`);
      // seek sample-exato: WAV pcm, -ss depois do -i não é necessário
      await runFfmpeg([
        "-y", "-ss", start.toFixed(3), "-t", len.toFixed(3), "-i", dryWav,
        "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", fatia,
      ], signal, "audio-fatiar");

      iso = await isolarVoz(fatia, limpo, signal);
      fs.rm(fatia, () => {});
      partes.push({ file: limpo, start, len });
      onProgress?.((i + 1) / inicios.length);
    }

    await remontarPorPosicao(partes, outWav, signal);
  } finally {
    for (const p of partes) fs.rm(p.file, () => {});
  }
  return iso;
}

/** Junta os chunks isolados nas suas posições absolutas, com crossfade nas emendas. */
async function remontarPorPosicao(
  partes: { file: string; start: number; len: number }[], outWav: string, signal?: AbortSignal,
): Promise<void> {
  const args: string[] = ["-y"];
  for (const p of partes) args.push("-i", p.file);

  const cadeias = partes.map((p, i) => {
    const f: string[] = [`atrim=0:${p.len.toFixed(3)}`, "asetpts=N/SR/TB"];
    // fade de ENTRADA em todos menos o primeiro; de SAÍDA em todos menos o último.
    if (i > 0) f.push(`afade=t=in:st=0:d=${OVER_S}:curve=qsin`);
    if (i < partes.length - 1) f.push(`afade=t=out:st=${(p.len - OVER_S).toFixed(3)}:d=${OVER_S}:curve=qsin`);
    const ms = Math.round(p.start * 1000);
    if (ms > 0) f.push(`adelay=${ms}:all=1`);
    return `[${i}:a]${f.join(",")}[a${i}]`;
  });
  const mix = `${partes.map((_, i) => `[a${i}]`).join("")}amix=inputs=${partes.length}:duration=longest:normalize=0[out]`;

  args.push(
    "-filter_complex", [...cadeias, mix].join(";"),
    "-map", "[out]", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outWav,
  );
  await runFfmpeg(args, signal, "audio-remontar");
}

/** Taxa reduzida usada só pra medir o deslocamento (0,25 ms de resolução). */
const SR_MEDIDA = 4000;
/** Busca de deslocamento: ±400 ms cobre com folga qualquer latência de filtro/API. */
const BUSCA_MS = 400;

/**
 * Mede o atraso do stem em relação ao original e o corrige no próprio arquivo.
 * Devolve o atraso corrigido, em ms (positivo = o stem estava atrasado).
 */
async function alinharStem(
  dryWav: string, stemWav: string, duracao: number, signal?: AbortSignal,
): Promise<number> {
  const atrasoMs = await medirAtrasoMs(dryWav, stemWav, duracao, signal);
  if (Math.abs(atrasoMs) < 0.5) return 0; // já alinhado — não mexe

  const tmp = `${stemWav}.align.wav`;
  // Atrasado → corta do início. Adiantado → empurra pra frente. Nos dois casos a
  // duração volta a ser exatamente a da origem (apad + -t).
  const corr = atrasoMs > 0
    ? `atrim=start=${(atrasoMs / 1000).toFixed(4)},asetpts=N/SR/TB,apad`
    : `adelay=${Math.round(-atrasoMs)}:all=1,apad`;
  await runFfmpeg([
    "-y", "-i", stemWav, "-af", corr, "-t", duracao.toFixed(3),
    "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", tmp,
  ], signal, "audio-alinhar");
  fs.rmSync(stemWav, { force: true });
  fs.renameSync(tmp, stemWav);
  console.log(`[AUDIO] alinhamento: stem corrigido em ${atrasoMs.toFixed(1)} ms`);
  return atrasoMs;
}

/** Correlação cruzada de uma janela dos dois sinais (reamostrados) → atraso em ms. */
async function medirAtrasoMs(
  dryWav: string, stemWav: string, duracao: number, signal?: AbortSignal,
): Promise<number> {
  // Janela no MIOLO do arquivo: início costuma ser silêncio/respiro, e o miolo tem fala.
  const janela = Math.min(20, Math.max(4, duracao * 0.2));
  const inicio = Math.max(0, duracao * 0.4);
  if (duracao < 2) return 0;

  const [a, b] = await Promise.all([
    lerJanela(dryWav, inicio, janela, signal),
    lerJanela(stemWav, inicio, janela, signal),
  ]);
  const maxLag = Math.round((BUSCA_MS / 1000) * SR_MEDIDA);
  if (a.length < maxLag * 3 || b.length < maxLag * 3) return 0;

  let melhorLag = 0, melhor = -Infinity;
  const ini = maxLag, fim = a.length - maxLag;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let soma = 0;
    for (let i = ini; i < fim; i++) soma += a[i] * b[i + lag];
    if (soma > melhor) { melhor = soma; melhorLag = lag; }
  }
  // Correlação negativa/nula = sinais sem relação (stem mudo, por exemplo): não
  // inventa correção — melhor não mexer do que deslocar por ruído.
  if (!(melhor > 0)) return 0;
  return (melhorLag / SR_MEDIDA) * 1000;
}

/** Decodifica [inicio, inicio+dur] de um WAV em mono @SR_MEDIDA como Float64. */
async function lerJanela(
  file: string, inicio: number, dur: number, signal?: AbortSignal,
): Promise<Float64Array> {
  const { stdout } = await execFileP("ffmpeg", [
    "-v", "error", "-ss", inicio.toFixed(3), "-t", dur.toFixed(3), "-i", file,
    "-ar", String(SR_MEDIDA), "-ac", "1", "-f", "s16le", "-",
  ], { encoding: "buffer", maxBuffer: 1 << 26, signal });
  const buf = stdout as unknown as Buffer;
  const n = buf.length >> 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i << 1);
  return out;
}

/**
 * MASTERIZAÇÃO — mistura dry/wet, cadeia de voz, e nível final.
 *
 * POR QUE NÃO USAR `loudnorm` PRA NORMALIZAR (aprendido na dor):
 * o loudnorm só aplica ganho LINEAR quando o ganho necessário cabe abaixo do teto
 * de pico. Quando não cabe — o caso comum em fala já editada — ele **ignora o
 * `linear=true` e vira DINÂMICO**, passando ganho variável ao longo do tempo. O
 * resultado é o áudio "comprimido", e como esse ganho leva tempo pra assentar, o
 * começo do arquivo soa diferente do resto. Foi exatamente o defeito relatado.
 *
 * O que se faz no lugar é o caminho clássico de mastering, e é determinístico:
 *   medir o nível → aplicar UM ganho fixo → segurar os picos num limitador.
 * O LUFS bate no alvo e a dinâmica da fala fica intacta.
 *
 * O compressor também virou ADAPTATIVO: limiar relativo ao nível medido da fala,
 * não um valor fixo. Um `threshold` fixo de -18 dB comprimia 100% do tempo num
 * material cuja fala vive por volta de -20 dB — dois esmagamentos empilhados.
 *
 * Devolve o LUFS integrado medido antes do ganho.
 */
async function masterizar(
  dryWav: string, stemWav: string, cfg: AudioSettings, duracao: number,
  outPath: string, signal?: AbortSignal,
): Promise<number | undefined> {
  const alvo = LOUDNESS[cfg.preset] ?? LOUDNESS.podcast;
  const strength = Math.max(0, Math.min(1, cfg.strength));
  const soVoz = strength >= 0.999;

  // Entradas: [0] voz isolada (wet) e, se a força < 1, [1] original (dry).
  const entradas = soVoz ? ["-i", stemWav] : ["-i", stemWav, "-i", dryWav];
  const mistura = soVoz
    ? "[0:a]anull[mix]"
    : `[0:a]volume=${strength.toFixed(3)}[w];[1:a]volume=${(1 - strength).toFixed(3)}[d];` +
      "[w][d]amix=inputs=2:duration=longest:normalize=0[mix]";

  // Cor da voz (sem dinâmica): rumble → sibilância → presença.
  const cor: string[] = ["highpass=f=75"];
  if (cfg.deesser > 0.01) cor.push(`deesser=i=${Math.min(1, cfg.deesser).toFixed(2)}`);
  if (Math.abs(cfg.presence) > 0.05) cor.push(`equalizer=f=3000:t=q:w=1.2:g=${cfg.presence.toFixed(1)}`);
  const cadeiaCor = cor.join(",");

  // ── passada 1: nível da fala já equalizada, pra calibrar o compressor ─────
  const i0 = await medirI(entradas, `${mistura};[mix]${cadeiaCor}`, signal);

  // Só o que passa de 8 dB acima do nível médio da fala é comprimido, e de leve
  // (2:1, ataque lento). Serve pra segurar sílaba estourada, não pra nivelar tudo.
  const limiar = i0 == null ? -18 : Math.max(-40, Math.min(-3, i0 + 8));
  const comp = `acompressor=threshold=${limiar.toFixed(1)}dB:ratio=2:attack=20:release=250:knee=6`;
  const cadeia = `${cadeiaCor},${comp}`;

  // ── passada 2: nível DEPOIS da compressão → é dele que sai o ganho ────────
  const i1 = await medirI(entradas, `${mistura};[mix]${cadeia}`, signal);
  const ganho = i1 == null ? 0 : alvo.i - i1;

  // Limitador de pico no teto do preset, com folga de 0,3 dB pro pico entre
  // amostras (o alimiter trabalha em pico de amostra, não em true peak).
  const teto = Math.pow(10, (alvo.tp - 0.3) / 20).toFixed(4);
  const limitador = `alimiter=limit=${teto}:attack=5:release=50:level=disabled`;

  // `apad` + `-t`: garante a duração EXATA da origem (ver cabeçalho do arquivo).
  const filtro = `${mistura};[mix]${cadeia},volume=${ganho.toFixed(2)}dB,${limitador},aresample=48000,apad[out]`;
  await runFfmpeg([
    "-y", ...entradas,
    "-filter_complex", filtro, "-map", "[out]",
    "-t", duracao.toFixed(3),
    "-ar", "48000", "-ac", "2", "-c:a", "aac", "-b:a", "256k",
    "-movflags", "+faststart", outPath,
  ], signal, "audio-masterizar");

  console.log(`[AUDIO] master: fala ${i0?.toFixed(1)} LUFS → limiar ${limiar.toFixed(1)} dB, ganho ${ganho.toFixed(1)} dB`);
  return i1 ?? undefined;
}

/** LUFS integrado da saída de uma cadeia de filtros (passada de medição, sem arquivo). */
async function medirI(entradas: string[], cadeia: string, signal?: AbortSignal): Promise<number | null> {
  const m = await medirLoudnorm(entradas, `${cadeia},loudnorm=print_format=json[out]`, signal);
  const v = m ? Number(m.input_i) : NaN;
  return Number.isFinite(v) ? v : null;
}

interface MedidaLoudnorm {
  input_i: string; input_lra: string; input_tp: string; input_thresh: string; target_offset: string;
}

/** Roda a passada de medição do loudnorm e devolve o JSON que ele imprime no stderr. */
async function medirLoudnorm(
  entradas: string[], filtro: string, signal?: AbortSignal,
): Promise<MedidaLoudnorm | null> {
  try {
    const { stderr } = await execFileP("ffmpeg", [
      "-hide_banner", "-nostats", ...entradas,
      "-filter_complex", filtro, "-map", "[out]",
      "-f", "null", "-",
    ], { maxBuffer: 1 << 26, signal });
    return extrairJson(stderr);
  } catch (e) {
    // ffmpeg escreve o JSON no stderr mesmo quando sai != 0 em alguns builds.
    const err = e as { stderr?: string };
    return err.stderr ? extrairJson(err.stderr) : null;
  }
}

/** O loudnorm imprime um JSON solto no meio do stderr — pega o último bloco {...}. */
function extrairJson(txt: string): MedidaLoudnorm | null {
  const ini = txt.lastIndexOf("{");
  const fim = txt.lastIndexOf("}");
  if (ini < 0 || fim <= ini) return null;
  try {
    const j = JSON.parse(txt.slice(ini, fim + 1)) as MedidaLoudnorm;
    return j.input_i && j.target_offset ? j : null;
  } catch { return null; }
}

/** LUFS integrado de um arquivo (o "antes" que a UI mostra). */
async function medirLufs(file: string, signal?: AbortSignal): Promise<number | undefined> {
  const m = await medirLoudnorm(["-i", file], "[0:a]loudnorm=print_format=json[out]", signal);
  const v = m ? Number(m.input_i) : NaN;
  return Number.isFinite(v) ? v : undefined;
}
