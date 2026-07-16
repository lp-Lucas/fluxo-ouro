import { useState } from "react";
import type { TranscriptSegment } from "../../../../shared/timeline";

export interface TranscribeResponse {
  fileName: string;
  language: string;
  durationSec: number;
  transcript: TranscriptSegment[];
}

type State =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string };

/**
 * Etapa 1+2: Ingestão e Transcrição.
 * Faz upload do vídeo bruto, dispara o faster-whisper e entrega a transcrição
 * (fonte única) para o App via onTranscribed.
 */
export function Ingestao({
  onTranscribed,
}: {
  onTranscribed: (data: TranscribeResponse, file: File) => void;
}) {
  const [state, setState] = useState<State>({ phase: "idle" });

  async function handleFile(file: File) {
    setState({ phase: "loading" });
    const form = new FormData();
    form.append("video", file);
    try {
      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Falha na transcrição");
      setState({ phase: "idle" });
      onTranscribed(data, file);
    } catch (e) {
      setState({ phase: "error", message: (e as Error).message });
    }
  }

  return (
    <section style={{ marginTop: 24 }}>
      <h2>1. Ingestão + Transcrição</h2>
      <input
        type="file"
        accept="video/*,audio/*"
        disabled={state.phase === "loading"}
        onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
      />
      {state.phase === "loading" && <p>Transcrevendo… (pode levar alguns minutos)</p>}
      {state.phase === "error" && <p style={{ color: "var(--red)" }}>Erro: {state.message}</p>}
    </section>
  );
}
