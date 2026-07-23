/**
 * ISOLAMENTO DE VOZ — a etapa cara do tratamento (equivale ao "Enhance" do Adobe
 * Podcast): separa a FALA do resto (ruído de fundo, ar-condicionado, eco/sala,
 * rua, teclado) e devolve só a voz.
 *
 * Motor primário: ElevenLabs Voice Isolator (modelo dedicado, resultado muito
 * acima de qualquer filtro clássico). Se não houver `ELEVENLABS_API_KEY`, cai
 * pro DENOISE LOCAL do ffmpeg — pior, mas o editor NUNCA deixa de funcionar por
 * falta de chave (mesma filosofia de env-gate do resto do OS).
 */
import fs from "node:fs";
import path from "node:path";
import { runFfmpeg } from "../flow/ffmpeg.js";

const BASE = "https://api.elevenlabs.io/v1";

export type MotorIsolamento = "isolamento" | "local";

export function chaveIsolamento(): string {
  return (process.env.ELEVENLABS_API_KEY ?? "").trim();
}

/** true = temos o motor bom (API). false = só o fallback local. */
export function isolamentoDisponivel(): boolean {
  return chaveIsolamento().length > 0;
}

export interface ResultadoIsolamento {
  motor: MotorIsolamento;
  /** Por que caiu no fallback, em PT-BR, pra UI mostrar. Ausente = correu bem. */
  aviso?: string;
}

/** Erro de credencial: a chave não serve e nunca vai servir sem intervenção humana. */
class ErroDeCredencial extends Error {}

/**
 * Isola a voz de `inputPath` (WAV) em `outPath` (WAV 48k mono).
 * Devolve qual motor foi usado — a UI avisa o usuário quando caiu no fallback.
 */
export async function isolarVoz(
  inputPath: string, outPath: string, signal?: AbortSignal,
): Promise<ResultadoIsolamento> {
  const key = chaveIsolamento();
  if (!key) {
    await denoiseLocal(inputPath, outPath, signal);
    return { motor: "local", aviso: "Servidor sem ELEVENLABS_API_KEY — rodou o denoise local." };
  }
  const bruto = `${outPath}.api.mp3`;
  try {
    await chamarElevenLabs(inputPath, bruto, key, signal);
    // Volta pra WAV 48k mono: daqui pra frente tudo é sample-exato (mp3 tem
    // delay de encoder que, somado chunk a chunk, desincronizaria do vídeo).
    await runFfmpeg(["-y", "-i", bruto, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outPath], signal, "isolar-decode");
    return { motor: "isolamento" };
  } catch (e) {
    // Credencial ruim é PERMANENTE: insistir não resolve, e derrubar o job inteiro
    // por causa dela seria pior — entrega o denoise local e diz o porquê. Já erro
    // transitório (429/5xx/rede) PROPAGA: melhor o usuário repetir do que receber
    // um resultado pior sem entender que foi um tropeço passageiro.
    if (!(e instanceof ErroDeCredencial)) throw e;
    console.warn(`[AUDIO] isolamento indisponível (${e.message}) — caindo pro denoise local`);
    await denoiseLocal(inputPath, outPath, signal);
    return { motor: "local", aviso: e.message };
  } finally {
    fs.rm(bruto, () => {});
  }
}

/** POST /v1/audio-isolation (multipart) → bytes de áudio da voz isolada. */
async function chamarElevenLabs(
  inputPath: string, outPath: string, key: string, signal?: AbortSignal,
): Promise<void> {
  const form = new FormData();
  form.append("audio", new Blob([fs.readFileSync(inputPath)]), path.basename(inputPath));

  const r = await fetch(`${BASE}/audio-isolation`, {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
    signal,
  });
  if (!r.ok) {
    const corpo = await r.text().catch(() => "");
    if (r.status === 401 || r.status === 403) {
      // Caso REAL e nada óbvio: a chave é válida, mas as keys do ElevenLabs são
      // por escopo — uma key de TTS/voices não faz isolamento. O erro genérico
      // "unauthorized" leva a gente a procurar chave errada por meia hora.
      const semEscopo = corpo.includes("audio_isolation") || corpo.includes("missing_permissions");
      throw new ErroDeCredencial(semEscopo
        ? "A ELEVENLABS_API_KEY não tem a permissão audio_isolation (habilite o escopo na key, no painel do ElevenLabs)."
        : "A ELEVENLABS_API_KEY foi recusada pelo ElevenLabs.");
    }
    throw new Error(`ElevenLabs audio-isolation ${r.status}: ${corpo.slice(0, 300)}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.byteLength === 0) throw new Error("ElevenLabs devolveu áudio vazio");
  fs.writeFileSync(outPath, buf);
}

/**
 * FALLBACK LOCAL (sem chave): denoise espectral do ffmpeg.
 * `afftdn` com rastreio de ruído (`nt=w`, banda larga) + corte de rumble. Tira
 * chiado/ar-condicionado constante; NÃO tira eco nem ruído variável — por isso é
 * fallback, não alternativa.
 */
async function denoiseLocal(inputPath: string, outPath: string, signal?: AbortSignal): Promise<void> {
  await runFfmpeg([
    "-y", "-i", inputPath,
    "-af", "highpass=f=70,afftdn=nf=-25:nt=w:tn=1,afftdn=nf=-20:nt=w:tn=1",
    "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", outPath,
  ], signal, "denoise-local");
}
