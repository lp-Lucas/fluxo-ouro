import { comBase } from '../../os-session';
import type { Cut, TranscriptSegment } from "../../../../shared/timeline";

/**
 * Fase 5 — cliente do "um botão" de decupagem. Manda vídeo + transcrição + copy pro
 * backend, que roda o pipeline determinístico (VAD → ancoragem → copy/guarda/alucinação →
 * merge/snap/score) e devolve os cortes APLICADOS + a razão legível (detail).
 * Nunca lança em silêncio: o backend responde 200 com `error` textual em caso de falha.
 */

export interface DecupDetail {
  start: number;
  end: number;
  label?: string;      // razão PT-BR ("Fora do roteiro (fala periférica)")
  confidence?: number;
}

export interface DecupagemResponse {
  cuts: Cut[];           // cortes DETERMINÍSTICOS (silêncio + alucinação + copy) — aplica na hora
  detail: DecupDetail[];
  needsAi: boolean;
  jobId: string | null;  // job da IA (retakes) — faça polling
  error?: string;
}

export interface DisfluenciaRegion { start: number; end: number; label: string; confidence: number }

export interface DecupProgress {
  status: "running" | "done" | "error";
  cuts?: Cut[];          // quando done: conjunto FINAL (det + IA já mesclados) — SUBSTITUI os decup-*
  detail?: DecupDetail[];
  transcript?: TranscriptSegment[]; // legenda reparada (falso começo + copy) — se presente, substitui
  regions?: DisfluenciaRegion[];    // disfluência: "ouça aqui" (marca, não corta)
  error?: string;
}

export async function runDecupagemServer(
  video: File, transcript: TranscriptSegment[], copy: string,
): Promise<DecupagemResponse> {
  const fd = new FormData();
  fd.append("video", video);
  fd.append("transcript", JSON.stringify(transcript));
  fd.append("copy", copy);
  const r = await fetch(comBase("/api/decupagem"), { method: "POST", body: fd });
  const data = await r.json().catch(() => ({ error: "Resposta inválida do servidor." }));
  if (!r.ok && !data.error) throw new Error("Falha ao decupar");
  return data as DecupagemResponse;
}

/**
 * Faz polling do patch de IA (retakes). Resolve quando o job termina; devolve o conjunto
 * FINAL (det + IA). Timeout generoso (a IA de um vídeo leva ~30-60s).
 */
export async function pollDecupagemAi(jobId: string, opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<DecupProgress> {
  const interval = opts.intervalMs ?? 1500;
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  for (;;) {
    const r = await fetch(comBase(`/api/decupagem/progress/${jobId}`));
    if (r.status === 404) return { status: "error", error: "job expirou" };
    const p = (await r.json()) as DecupProgress;
    if (p.status !== "running") return p;
    if (Date.now() > deadline) return { status: "error", error: "IA demorou demais" };
    await new Promise((res) => setTimeout(res, interval));
  }
}
