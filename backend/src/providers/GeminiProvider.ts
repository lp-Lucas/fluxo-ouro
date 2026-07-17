import fs from "node:fs";
import path from "node:path";
import type { ImageProvider, GenerateImageInput, GenerateImageResult } from "./ImageProvider.js";

/**
 * Provider de imagem via Google Nano Banana (Gemini 2.5 Flash Image), endpoint nativo
 * `:generateContent`. Diferente do OpenAI (2 passos: um GPT interpreta + a tool gera), o
 * Nano Banana INTERPRETA o prompt + as imagens de referência E GERA numa chamada só — então
 * o modo `chatgptStyle` é irrelevante aqui (ele já é nativo). Reusa a MESMA chave do Veo
 * (`GOOGLE_VIDEO_API_KEY`). ~$0.039/imagem — bem mais barato que o gpt-image high (~$0.25).
 *
 * NÃO tem flag nativa de fundo transparente (o gpt-image-1 tinha `background: transparent`);
 * quando pedido, reforçamos por prompt, mas alpha real não é garantido — ver caveat abaixo.
 */
export class GeminiProvider implements ImageProvider {
  readonly name = "gemini";
  private readonly model = process.env.GEMINI_IMAGE_MODEL ?? "gemini-2.5-flash-image";
  private readonly base = process.env.GOOGLE_API_BASE ?? "https://generativelanguage.googleapis.com/v1beta";

  constructor(private readonly apiKey: string) {}

  /** parte inline_data (base64) de um arquivo de referência local. */
  private inlineData(p: string): { inline_data: { mime_type: string; data: string } } | null {
    if (!fs.existsSync(p)) return null;
    const ext = path.extname(p).toLowerCase();
    const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
    return { inline_data: { mime_type: mime, data: fs.readFileSync(p).toString("base64") } };
  }

  /** acha a imagem no candidato (aceita inlineData camelCase e inline_data snake) → data URL. */
  private extractImage(json: unknown): string | null {
    const parts = (json as { candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }> })
      ?.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      const inl = (part.inlineData ?? part.inline_data) as { data?: string; mimeType?: string; mime_type?: string } | undefined;
      if (inl?.data) return `data:${inl.mimeType ?? inl.mime_type ?? "image/png"};base64,${inl.data}`;
    }
    return null;
  }

  /** motivo textual quando NÃO veio imagem (recusa por safety / só texto) — p/ erro claro. */
  private refusalText(json: unknown): string {
    const cand = (json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }> })?.candidates?.[0];
    const txt = (cand?.content?.parts ?? []).find((p) => p.text)?.text;
    return [cand?.finishReason, txt].filter(Boolean).join(" — ") || "resposta sem imagem";
  }

  private async one(input: GenerateImageInput): Promise<string> {
    const parts: unknown[] = [];
    // fundo transparente não é nativo do Nano Banana → reforça por prompt (alpha não garantido)
    const promptExtra = input.background === "transparent"
      ? " The subject MUST be isolated on a fully transparent background (PNG alpha), no backdrop, no scenery, no shadow plane."
      : "";
    parts.push({ text: input.prompt + promptExtra });
    for (const ref of input.references ?? []) {
      const d = this.inlineData(ref.path);
      if (d) parts.push(d);
    }

    const generationConfig: Record<string, unknown> = { responseModalities: ["IMAGE"] };
    if (input.aspectRatio) generationConfig.imageConfig = { aspectRatio: input.aspectRatio };

    const url = `${this.base}/models/${this.model}:generateContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }], generationConfig }),
      signal: input.signal,
    });
    if (!res.ok) throw new Error(`Nano Banana (imagem) ${res.status}: ${(await res.text()).slice(-400)}`);
    const json = await res.json();
    const img = this.extractImage(json);
    if (!img) throw new Error(`Nano Banana não retornou imagem: ${this.refusalText(json)}`);
    return img;
  }

  async generate(input: GenerateImageInput): Promise<GenerateImageResult> {
    if (!this.apiKey) {
      throw new Error("Chave do Google ausente no backend (GOOGLE_VIDEO_API_KEY) — configure para gerar imagens com o Nano Banana.");
    }
    // Nano Banana devolve 1 imagem por chamada → N variações = N chamadas em paralelo.
    const n = Math.max(1, Math.min(4, input.count ?? 1));
    const urls = await Promise.all(Array.from({ length: n }, () => this.one(input)));
    return { imageUrl: urls[0], imageUrls: urls, provider: this.name };
  }
}
