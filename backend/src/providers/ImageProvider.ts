/**
 * Camada de abstração de geração de imagem.
 *
 * Requisito de arquitetura: trocar Gemini → OpenAI deve ser só plugar outro
 * provider, sem reescrever o FLOW. Todo o resto do código depende APENAS desta
 * interface, nunca de um provider concreto.
 */

/** Imagem de referência passada ao modelo (logo, estilo, etc). */
export interface ImageRef {
  path: string;   // caminho local do arquivo
  tag: string;    // papel: logo | estilo | referencia | esboco
}

export interface GenerateImageInput {
  prompt: string;
  /** Proporção da tela de design, ex: "9:16" (default), "16:9", "1:1". */
  aspectRatio?: string;
  /** Imagens de referência (usa o endpoint de edição do modelo quando presentes). */
  references?: ImageRef[];
  /** Quantas variações gerar numa chamada (default 1) — o usuário escolhe a melhor. */
  count?: number;
  /** Cancelamento (botão "parar" do usuário). */
  signal?: AbortSignal;
  /** "transparent" = PNG com alpha (elementos/botões pra sobrepor no vídeo). */
  background?: "transparent" | "opaque" | "auto";
  /** Força um modelo específico nesta chamada (ex.: gpt-image-1 p/ fundo transparente,
   *  que o gpt-image-2 NÃO suporta). Sem isto, usa o modelo padrão do provider. */
  model?: string;
  /** "modo ChatGPT": um modelo GPT (4o/5) INTERPRETA o pedido + imagens e chama a
   *  geração de imagem sozinho (Responses API, tool image_generation) — igual ao ChatGPT. */
  chatgptStyle?: boolean;
}

export interface GenerateImageResult {
  imageUrl: string;      // a primeira variação (compat)
  imageUrls?: string[];  // todas as variações geradas
  provider: string;
}

export interface ImageProvider {
  readonly name: string;
  generate(input: GenerateImageInput): Promise<GenerateImageResult>;
  /**
   * OUTPAINT/INPAINT: repinta regiões de `imagePath` via /images/edits. Com `opts.maskPath`
   * (PNG do MESMO tamanho; transparente = editar, opaco = manter), o modelo repinta SÓ a
   * região mascarada vendo a imagem inteira — é como o fit reconstrói as bordas 9:16.
   * `opts.model` escolhe o modelo do edit (padrão gpt-image-1). Devolve data URL.
   */
  outpaint?(imagePath: string, prompt: string, size: string, signal?: AbortSignal, opts?: { maskPath?: string; model?: string }): Promise<string>;
}
