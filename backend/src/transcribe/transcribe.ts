import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "../../transcribe/transcribe.py");

export interface TranscribeOutput {
  language: string;
  durationSec: number;
  transcript: unknown[];
}

/**
 * Roda o faster-whisper (Python) sobre o arquivo INTEIRO e devolve o JSON CANÔNICO.
 * As palavras vêm daqui (legenda, copy, contexto p/ IA). A ESTRUTURA de tentativas (blocos
 * de fala) é do VAD (Silero), computada onde for necessária — não se transcreve por bloco.
 * Assíncrono: não bloqueia a API enquanto transcreve.
 */
export function runTranscription(mediaPath: string): Promise<TranscribeOutput> {
  const python = process.env.PYTHON ?? "python";
  return new Promise((resolve, reject) => {
    const proc = spawn(python, [SCRIPT, mediaPath, "--lang", "pt"]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`transcribe.py saiu com código ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as TranscribeOutput);
      } catch (e) {
        reject(new Error(`JSON inválido da transcrição: ${(e as Error).message}\n${stdout}`));
      }
    });
  });
}
