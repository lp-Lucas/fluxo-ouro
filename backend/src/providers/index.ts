import type { ImageProvider } from "./ImageProvider.js";
import { GeminiProvider } from "./GeminiProvider.js";
import { OpenAIImageProvider } from "./OpenAIImageProvider.js";

/**
 * Seleção do provider de imagem por env (`IMAGE_PROVIDER`, default openai nesta versão).
 * OpenAI é o principal; Gemini é a implementação alternativa da MESMA interface.
 */
export function getImageProvider(): ImageProvider {
  const provider = process.env.IMAGE_PROVIDER ?? "openai";
  switch (provider) {
    case "openai":
      return new OpenAIImageProvider(process.env.OPENAI_API_KEY ?? "");
    case "gemini":
      // Nano Banana usa a MESMA chave do Veo (GOOGLE_VIDEO_API_KEY); GEMINI_API_KEY como fallback.
      return new GeminiProvider(process.env.GOOGLE_VIDEO_API_KEY ?? process.env.GEMINI_API_KEY ?? "");
    default:
      throw new Error(`Image provider desconhecido: ${provider}`);
  }
}

export type { ImageProvider } from "./ImageProvider.js";
