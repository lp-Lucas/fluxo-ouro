/**
 * Etapas do pipeline (Fluxo Ouro). Cada uma vira um módulo próprio em
 * src/modules/<nome>/ quando for implementada — uma de cada vez.
 */
export interface PipelineStep {
  id: string;
  title: string;
  status: "pendente" | "em-progresso" | "pronto";
}

export const PIPELINE: PipelineStep[] = [
  { id: "ingestao", title: "1. Ingestão (vídeo bruto)", status: "pronto" },
  { id: "transcricao", title: "2. Transcrição (faster-whisper, timestamps por palavra)", status: "pronto" },
  { id: "correcao", title: "3. Correção (edição manual por palavra)", status: "pronto" },
  { id: "legenda", title: "4. Legenda (karaokê, preview ao vivo)", status: "pronto" },
  { id: "editor", title: "5. Editor (autocut, zooms, popups)", status: "pronto" },
  { id: "export", title: "6. Export (render Remotion — legendas)", status: "em-progresso" },
  { id: "flow", title: "7. Flow (design → motion → aprovação)", status: "pendente" },
];
