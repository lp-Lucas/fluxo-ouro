/**
 * Camada de abstração de matting (recorte alpha da pessoa).
 *
 * Mesma ideia do ImageProvider/PopupDetector: a composição NUNCA depende de um
 * modelo concreto, só desta interface. Trocar RVM → BiRefNet/SAM 2 é plugar
 * outro provider, sem reescrever o render.
 *
 * DECISÃO CRAVADA: a saída é UM VÍDEO com canal alpha (WebM VP9 / yuva420p),
 * curto (só a duração do popup) — NUNCA sequência de PNGs.
 */
export interface MattingRequest {
  videoPath: string; // vídeo bruto (origem)
  startFrame: number; // início do trecho do popup
  endFrame: number; // fim do trecho do popup
  fps: number;
  width: number;
  height: number;
  outputPath: string; // onde escrever o WebM alpha (cache por popupId + hash)
}

export interface MattingProvider {
  readonly name: string;
  /**
   * Gera o WebM VP9 alpha do trecho e devolve o caminho do arquivo.
   * `signal` permite cancelar (timeout de segurança) — ao abortar, o provider
   * mata a árvore de processos (python + ffmpeg filhos) para não deixar zumbi.
   */
  generateAlphaVideo(req: MattingRequest, signal?: AbortSignal): Promise<string>;
}
