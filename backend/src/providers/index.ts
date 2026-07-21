import type { ImageProvider } from "./ImageProvider.js";
import { GeminiProvider } from "./GeminiProvider.js";
import { OpenAIImageProvider } from "./OpenAIImageProvider.js";

/**
 * Seleção do provider de imagem por env (`IMAGE_PROVIDER`, default openai nesta versão).
 * OpenAI é o principal; Gemini é a implementação alternativa da MESMA interface.
 */
export function getImageProvider(): ImageProvider {
  // trim + lowercase: env editado no servidor costuma vir com espaco/CR (`openai\r`) ou
  // maiuscula — sem normalizar, o switch nao casa e estoura "provider desconhecido".
  const provider = (process.env.IMAGE_PROVIDER ?? "openai").trim().toLowerCase();
  switch (provider) {
    case "openai":
      return new OpenAIImageProvider(process.env.OPENAI_API_KEY ?? "");
    case "gemini":
      // Nano Banana usa a MESMA chave do Veo (GOOGLE_VIDEO_API_KEY); GEMINI_API_KEY como fallback.
      return new GeminiProvider(process.env.GOOGLE_VIDEO_API_KEY ?? process.env.GEMINI_API_KEY ?? "");
    default:
      throw new Error(`IMAGE_PROVIDER invalido: "${provider}". Use "openai" ou "gemini" no backend/.env (ou /etc/fluxo-ouro/env em PROD).`);
  }
}

export type { ImageProvider } from "./ImageProvider.js";
