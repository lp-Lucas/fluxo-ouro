import Anthropic from "@anthropic-ai/sdk";

/**
 * Cliente ÚNICO da API oficial da Anthropic (SDK @anthropic-ai/sdk).
 *
 * Substitui o CLI `claude -p` de vez: o CLI dependia de sessão logada na máquina e
 * quebrava silencioso (saía com código 1 sem stderr). Aqui a autenticação é a
 * ANTHROPIC_API_KEY do backend/.env — sem processo filho, sem shim do npm.
 *
 * Todas as chamadas usam STREAMING + finalMessage(): prompts grandes (transcrição
 * inteira) e thinking adaptativo estouram o timeout HTTP em chamadas não-streaming.
 */

const DEFAULT_MODEL = "claude-opus-4-8";

let cliente: Anthropic | null = null;
function client(): Anthropic {
  const key = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY ausente — cole a sua chave da API da Anthropic no backend/.env " +
      "(console.anthropic.com → API Keys) e o backend reinicia sozinho.",
    );
  }
  cliente ??= new Anthropic({ apiKey: key });
  return cliente;
}

/** Junta só os blocos de texto (thinking vem junto no stream e não é texto). */
function textOf(msg: Anthropic.Message): string {
  return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

/** Erros da API → mensagem curta em PT-BR (a genérica do SDK confunde na UI). */
function traduzErro(e: unknown): Error {
  if (e instanceof Anthropic.AuthenticationError) {
    return new Error("Chave da Anthropic inválida ou revogada — confira a ANTHROPIC_API_KEY no backend/.env.");
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new Error("Limite de requisições da Anthropic atingido — aguarde um pouco e tente de novo.");
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new Error("Sem conexão com a API da Anthropic — verifique a internet.");
  }
  if (e instanceof Anthropic.APIError) {
    return new Error(`API da Anthropic (${e.status}): ${e.message.slice(0, 300)}`);
  }
  return e instanceof Error ? e : new Error(String(e));
}

export interface ClaudeOpts {
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Chamada de TEXTO (autocut, retakes, cobertura de legenda, FLOW). */
export async function claudeText(prompt: string, opts: ClaudeOpts = {}): Promise<string> {
  try {
    const stream = client().messages.stream(
      {
        model: opts.model ?? DEFAULT_MODEL,
        max_tokens: opts.maxTokens ?? 16000,
        // adaptativo: decisões de corte/retake são raciocínio de verdade — o modelo
        // escolhe quanto pensar; o texto do thinking não entra no textOf().
        thinking: { type: "adaptive" },
        messages: [{ role: "user", content: prompt }],
      },
      { signal: opts.signal },
    );
    return textOf(await stream.finalMessage());
  } catch (e) {
    throw traduzErro(e);
  }
}

export interface ClaudeImage {
  /** ex.: "image/png" */
  mediaType: string;
  /** base64 puro, sem prefixo data: */
  dataB64: string;
  /** rótulo textual colocado antes da imagem (ex.: 'Image 1 — role "estilo"') */
  label?: string;
}

/** Chamada de VISÃO (análise de estilo, prompt de design, continuidade A→B). */
export async function claudeVision(prompt: string, images: ClaudeImage[], opts: ClaudeOpts = {}): Promise<string> {
  const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: prompt }];
  for (const img of images) {
    if (img.label) content.push({ type: "text", text: img.label });
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mediaType as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
        data: img.dataB64,
      },
    });
  }
  try {
    const stream = client().messages.stream(
      {
        model: opts.model ?? DEFAULT_MODEL,
        max_tokens: opts.maxTokens ?? 8000,
        thinking: { type: "adaptive" },
        messages: [{ role: "user", content }],
      },
      { signal: opts.signal },
    );
    return textOf(await stream.finalMessage());
  } catch (e) {
    throw traduzErro(e);
  }
}
