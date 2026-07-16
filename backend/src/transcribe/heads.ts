import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

import type { Word } from "../../../shared/timeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "../../transcribe/head_transcribe.py");
const REGION_SCRIPT = path.resolve(__dirname, "../../transcribe/region_transcribe.py");

export interface HeadWindow { startMs: number; endMs: number; }

/**
 * Transcreve a CABEÇA de cada janela (só o começo de cada bloco de fala) — para a detecção
 * de zona por cabeça-de-bloco. Devolve o texto de cada janela, na ordem. Não é a
 * transcrição canônica; decide só fronteira de zona.
 */
export function transcribeHeads(mediaPath: string, windows: HeadWindow[]): Promise<string[]> {
  if (windows.length === 0) return Promise.resolve([]);
  const winFile = path.join(os.tmpdir(), `heads-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(winFile, JSON.stringify(windows));
  const python = process.env.PYTHON ?? "python";
  return new Promise((resolve, reject) => {
    const proc = spawn(python, [SCRIPT, mediaPath, winFile]);
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", (e) => { fs.rm(winFile, () => {}); reject(e); });
    proc.on("close", (code) => {
      fs.rm(winFile, () => {});
      if (code !== 0) { reject(new Error(`head_transcribe.py saiu com ${code}: ${stderr}`)); return; }
      try { resolve((JSON.parse(stdout) as { text: string }[]).map((h) => h.text)); }
      catch (e) { reject(new Error(`JSON inválido das cabeças: ${(e as Error).message}\n${stdout}`)); }
    });
  });
}

/**
 * Transcreve cada janela com timestamps de PALAVRA (absolutos) — para recuperar repetições que a
 * canônica achatou. Devolve, por janela, as palavras finas. Não é a canônica; alimenta só
 * `detectaRepeticaoFina`. Falha na região vira `[]` (não derruba o job).
 */
export function transcribeRegionsWords(mediaPath: string, windows: HeadWindow[]): Promise<Word[][]> {
  if (windows.length === 0) return Promise.resolve([]);
  const winFile = path.join(os.tmpdir(), `regions-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(winFile, JSON.stringify(windows));
  const python = process.env.PYTHON ?? "python";
  return new Promise((resolve, reject) => {
    const proc = spawn(python, [REGION_SCRIPT, mediaPath, winFile]);
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", (e) => { fs.rm(winFile, () => {}); reject(e); });
    proc.on("close", (code) => {
      fs.rm(winFile, () => {});
      if (code !== 0) { reject(new Error(`region_transcribe.py saiu com ${code}: ${stderr}`)); return; }
      try {
        const raw = JSON.parse(stdout) as { text: string; start: number; end: number }[][];
        resolve(raw.map((ws) => ws.map((w) => ({ text: w.text, start: w.start, end: w.end }))));
      } catch (e) { reject(new Error(`JSON inválido das regiões: ${(e as Error).message}\n${stdout}`)); }
    });
  });
}
