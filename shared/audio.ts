/**
 * TRATAMENTO DE ÁUDIO — configuração do projeto (estilo Adobe Podcast Enhance).
 *
 * Duas etapas com custos MUITO diferentes, e a separação é o coração do design:
 *
 *  1. ISOLAMENTO DA VOZ (caro, remoto, lento) — tira ruído, eco e sala. Depende
 *     SÓ do arquivo de origem, nunca dos ajustes. Roda uma vez por vídeo e o stem
 *     fica em cache pra sempre.
 *  2. MASTERIZAÇÃO (barata, local, segundos) — mistura voz isolada com o original
 *     (`strength`), equaliza e normaliza o volume. Depende dos ajustes.
 *
 * Por isso mexer nos sliders NÃO gasta crédito nem espera: re-roda só a etapa 2.
 */

/** Alvo de loudness (EBU R128). O que muda de verdade entre plataformas. */
export type LoudnessPreset = "podcast" | "social" | "broadcast";

export interface LoudnessTarget {
  /** LUFS integrado — o volume percebido do vídeo inteiro. */
  i: number;
  /** True peak (dBTP) — teto pra não estourar depois da compressão da plataforma. */
  tp: number;
  /** Faixa dinâmica (LU). Menor = mais constante/"na frente". */
  lra: number;
}

export const LOUDNESS: Record<LoudnessPreset, LoudnessTarget & { label: string; hint: string }> = {
  podcast: { i: -16, tp: -1.5, lra: 11, label: "Podcast / YouTube", hint: "-16 LUFS — o padrão de fala na web" },
  social: { i: -14, tp: -1.0, lra: 9, label: "Reels / TikTok", hint: "-14 LUFS — mais alto e constante, pra celular no volume baixo" },
  broadcast: { i: -23, tp: -2.0, lra: 7, label: "Broadcast (EBU R128)", hint: "-23 LUFS — exigência de TV/emissora" },
};

export interface AudioSettings {
  /** Liga o tratamento. Desligado = o áudio original passa intocado. */
  enhance: boolean;
  /**
   * Força do tratamento (0..1): quanto da VOZ ISOLADA entra na mistura.
   * 1 = só voz limpa (fundo some — o efeito "uau" do Adobe).
   * 0.7 = limpa mas guarda um respiro do ambiente (bom pra vídeo gravado em locação).
   */
  strength: number;
  /** Alvo de volume final. */
  preset: LoudnessPreset;
  /** De-esser (0..1) — dureza dos "s"/"ch". 0 desliga. */
  deesser: number;
  /** Realce de presença em ~3 kHz, em dB (0..6). Deixa a voz "à frente". */
  presence: number;
  /** Último resultado gerado (pra preview A/B e pro export). */
  rendered?: RenderedAudio;
}

export interface RenderedAudio {
  /** URL servida do arquivo tratado (/uploads/…). */
  url: string;
  /** Hash de (origem + ajustes). Se != do atual, o resultado está velho. */
  key: string;
  /** Loudness medido ANTES do tratamento (LUFS) — o "de/para" que a UI mostra. */
  lufsAntes?: number;
  /** Motor que produziu o stem: API de isolamento ou fallback local. */
  motor?: "isolamento" | "local";
  /** Por que caiu no fallback, se caiu. A UI mostra literalmente. */
  aviso?: string;
}

export const DEFAULT_AUDIO: AudioSettings = {
  enhance: false,
  strength: 1,
  preset: "podcast",
  deesser: 0.35,
  presence: 2,
};

/** Ajustes que afetam a MASTERIZAÇÃO (etapa 2). Mudou aqui = re-render local, sem custo. */
export function masterParams(a: AudioSettings): string {
  return JSON.stringify([
    Number(a.strength.toFixed(3)),
    a.preset,
    Number(a.deesser.toFixed(2)),
    Number(a.presence.toFixed(1)),
  ]);
}

/** true se o resultado em cache ainda corresponde aos ajustes atuais. */
export function audioAtualizado(a: AudioSettings | undefined, sourceKey: string): boolean {
  if (!a?.enhance || !a.rendered) return false;
  return a.rendered.key === `${sourceKey}:${masterParams(a)}`;
}
