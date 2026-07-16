/** Intervalo de corte da decupagem — mais rico que o Cut do timeline (Fase 4/5 usam). */
export type CutSource = "copy" | "ai_retake" | "vad_silence" | "vad_breath" | "filler" | "hallucination";

export interface CutInterval {
  startMs: number;
  endMs: number;
  source: CutSource;
  reason: string[];     // acumula no merge (várias camadas podem concordar)
  confidence?: number;  // Fase 5 (scoring)
  applied?: boolean;    // Fase 5 (>=0.85 aplicado; a guarda força false)
  label?: string;       // Fase 5 (razão legível em PT-BR para a UI)
  /** Detecção confiável, mas INCAPAZ de agir sem estragar. Ex.: "caption_timestamp_collapse"
   *  (falso começo cujo corte parte uma palavra canônica → legenda quebraria). applied:false,
   *  confidence intacta — é a métrica de "quantos detectados vs quantos cortáveis". */
  blocked_by?: string;
  /** Independe da copy (ex.: disfluência por colapso de ancoragem). Marca, não corta. */
  copyIndependent?: boolean;
}

/** Resultado da camada semântica: cortes determinísticos + o que a IA precisa refinar. */
export interface SemanticResult {
  /** Cortes já decididos (copy/guarda/alucinação) — aplicados imediatamente. */
  cuts: CutInterval[];
  /** Índices de palavra FREADOS pela guarda de mishear — nunca cortados. */
  braked: number[];
  /** Há takes repetidos ambíguos (as duas tomadas batem com a copy)? → precisa de IA. */
  needsAi: boolean;
  /** Índices de palavra candidatos a retake (a IA decide qual tomada manter). */
  retakeCandidates: number[];
  /** Zonas de retake: dentro delas o copyLayer se cala; a IA decide livre. `via` = método(s).
   *  `cut` (só zona-cabeça pura) = corte acústico do falso começo (por bloco, não por palavra). */
  retakeZones: { from: number; to: number; via?: "periodicidade" | "cabeca" | "bloco" | "ambos"; cut?: { startMs: number; endMs: number } }[];
}
