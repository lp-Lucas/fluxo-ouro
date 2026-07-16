import fs from "node:fs";
import path from "node:path";
import type { ImageProvider, GenerateImageInput, GenerateImageResult } from "./ImageProvider.js";

/**
 * Provider de imagem via OpenAI Images (gpt-image-1 por padrão).
 * - Sem referências: `/v1/images/generations` (texto → imagem).
 * - Com referências (logo/estilo/esboço): `/v1/images/edits` (multipart, `image[]`),
 *   passando as imagens de fato pro modelo pra influenciar o resultado.
 * Modelo/size configuráveis por env. Devolve a imagem como DATA URL (b64); o FLOW
 * salva em assets/flow/ e ajusta pra proporção escolhida.
 */
export class OpenAIImageProvider implements ImageProvider {
  readonly name = "openai";
  // gpt-image-2 segue as referências com MUITO mais fidelidade/consistência que o -1
  // (o -1 reinterpretava e fugia da identidade). Mais lento (~2min), porém muito melhor.
  private readonly defaultModel = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2";
  private readonly quality = process.env.OPENAI_IMAGE_QUALITY ?? "high"; // low|medium|high|auto
  // input_fidelity só existe no gpt-image-1; o gpt-image-2 REJEITA esse parâmetro.
  private supportsInputFidelity(model: string) { return /gpt-image-1/.test(model); }

  constructor(private readonly apiKey: string) {}

  private size(aspect?: string): string {
    if (aspect === "16:9") return "1536x1024";
    if (aspect === "1:1") return "1024x1024";
    return "1024x1536"; // 9:16 (default)
  }

  async generate(input: GenerateImageInput): Promise<GenerateImageResult> {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY ausente no backend — configure a variável de ambiente para gerar imagens.");
    }
    const size = this.size(input.aspectRatio);
    const n = Math.max(1, Math.min(4, input.count ?? 1));
    const model = input.model ?? this.defaultModel;
    const b64s = input.chatgptStyle
      ? await this.viaResponses(input.prompt, size, input.references ?? [], n, input.signal, input.background)
      : input.references?.length
      ? await this.edit(model, input.prompt, size, input.references, n, input.signal, input.background)
      : await this.generateNew(model, input.prompt, size, n, input.signal, input.background);
    const urls = b64s.map((b) => `data:image/png;base64,${b}`);
    return { imageUrl: urls[0], imageUrls: urls, provider: this.name };
  }

  /**
   * MODO CHATGPT (Responses API): um modelo GPT (4o/5, env OPENAI_CHAT_MODEL) recebe o
   * texto do usuário + as imagens anexadas, INTERPRETA (expande, contextualiza, olha as
   * refs) e chama a ferramenta `image_generation` sozinho — exatamente como o ChatGPT.
   * Por baixo a tool usa o gpt-image-1. Uma imagem por chamada; N variações = N chamadas.
   */
  private async viaResponses(
    prompt: string, size: string, refs: { path: string; tag: string }[], n: number,
    signal?: AbortSignal, background?: string,
  ): Promise<string[]> {
    const chatModel = process.env.OPENAI_CHAT_MODEL ?? "gpt-4.1";
    const content: unknown[] = [{ type: "input_text", text: prompt }];
    for (const r of refs) {
      if (!fs.existsSync(r.path)) continue;
      const ext = path.extname(r.path).toLowerCase();
      const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
      content.push({ type: "input_image", image_url: `data:${mime};base64,${fs.readFileSync(r.path).toString("base64")}` });
    }
    const tool: Record<string, unknown> = { type: "image_generation", size, quality: this.quality };
    if (background) tool.background = background;

    const one = async (): Promise<string> => {
      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: chatModel, input: [{ role: "user", content }], tools: [tool], tool_choice: { type: "image_generation" } }),
        signal,
      });
      if (!res.ok) throw new Error(`OpenAI Responses ${res.status}: ${(await res.text()).slice(-400)}`);
      const data = await res.json() as { output?: Array<{ type?: string; result?: string }> };
      const img = (data.output ?? []).find((o) => o.type === "image_generation_call" && o.result)?.result;
      if (!img) throw new Error("OpenAI Responses não retornou imagem (image_generation_call).");
      return img; // base64 png
    };
    // N variações = N chamadas em paralelo (a tool devolve 1 imagem por vez)
    return Promise.all(Array.from({ length: n }, () => one()));
  }

  /**
   * OUTPAINT/INPAINT via `/v1/images/edits`. Dois modos:
   *  - com `opts.maskPath`: máscara explícita (transparente = REPINTAR, opaco = manter) —
   *    o modelo vê a imagem INTEIRA e repinta só a região editável (bordas do fit);
   *  - sem máscara: a transparência do próprio canvas é o sinal (legado).
   * `opts.model` escolhe o modelo (padrão gpt-image-1; o fit tenta o gpt-image-2 primeiro —
   * mesma família do design — e cai pro -1 se ele recusar máscara/params).
   */
  async outpaint(imagePath: string, prompt: string, size: string, signal?: AbortSignal, opts?: { maskPath?: string; model?: string }): Promise<string> {
    if (!this.apiKey) throw new Error("OPENAI_API_KEY ausente no backend — outpaint requer a chave.");
    const model = opts?.model ?? "gpt-image-1";
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("size", size);
    form.append("quality", this.quality);
    // input_fidelity=high (só gpt-image-1): segue de perto a imagem base no repaint.
    if (this.supportsInputFidelity(model)) form.append("input_fidelity", process.env.OPENAI_INPUT_FIDELITY ?? "high");
    form.append("image", new Blob([fs.readFileSync(imagePath)], { type: "image/png" }), "canvas.png");
    if (opts?.maskPath) form.append("mask", new Blob([fs.readFileSync(opts.maskPath)], { type: "image/png" }), "mask.png");
    const res = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST", headers: { authorization: `Bearer ${this.apiKey}` }, body: form, signal,
    });
    if (!res.ok) throw new Error(`OpenAI outpaint(${model}) ${res.status}: ${(await res.text()).slice(-400)}`);
    return `data:image/png;base64,${this.extract(await res.json(), "outpaint")[0]}`;
  }

  private extract(data: { data?: { b64_json?: string }[] }, label: string): string[] {
    const list = (data?.data ?? []).map((d) => d.b64_json).filter((b): b is string => !!b);
    if (!list.length) throw new Error(`OpenAI Images (${label}) não retornou imagem.`);
    return list;
  }

  private async generateNew(model: string, prompt: string, size: string, n: number, signal?: AbortSignal, background?: string): Promise<string[]> {
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model, prompt, size, n, quality: this.quality, ...(background ? { background } : {}) }),
      signal,
    });
    if (!res.ok) throw new Error(`OpenAI Images ${res.status}: ${(await res.text()).slice(-400)}`);
    return this.extract(await res.json(), "generations");
  }

  private async edit(model: string, prompt: string, size: string, refs: { path: string; tag: string }[], n: number, signal?: AbortSignal, background?: string): Promise<string[]> {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("size", size);
    form.append("n", String(n));
    form.append("quality", this.quality);
    if (background) form.append("background", background);
    // input_fidelity=high (só gpt-image-1) faz seguir de perto as imagens anexadas.
    if (this.supportsInputFidelity(model)) form.append("input_fidelity", process.env.OPENAI_INPUT_FIDELITY ?? "high");
    for (const r of refs) {
      if (!fs.existsSync(r.path)) continue;
      const buf = fs.readFileSync(r.path);
      const ext = path.extname(r.path).toLowerCase();
      const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
      form.append("image[]", new Blob([buf], { type: mime }), path.basename(r.path));
    }
    const res = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` }, // sem content-type: o fetch põe o boundary
      body: form,
      signal,
    });
    if (!res.ok) throw new Error(`OpenAI Images (edits) ${res.status}: ${(await res.text()).slice(-400)}`);
    return this.extract(await res.json(), "edits");
  }
}
