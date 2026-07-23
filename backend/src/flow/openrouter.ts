import fs from "node:fs";

/**
 * Cliente mínimo de EDIÇÃO de imagem via OpenRouter (chat completions com saída de imagem).
 * Usado pelo fit 9:16 pra reconstruir SÓ as margens de cima/baixo com o nano-banana
 * (Gemini 2.5 Flash Image), preservando o centro (o caller crava o design original de volta).
 *
 * Contrato OpenRouter: POST /api/v1/chat/completions, `modalities:["image","text"]`, imagem de
 * entrada em content[].image_url (data URL b64), imagem de saída em
 * choices[0].message.images[].image_url.url (data URL b64). Auth: OPENROUTER_API_KEY.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.OPENROUTER_IMAGE_MODEL ?? "google/gemini-2.5-flash-image-preview";

type ORResp = {
  choices?: Array<{
    message?: {
      images?: Array<{ image_url?: { url?: string }; url?: string; type?: string }>;
      content?: unknown;
    };
  }>;
  error?: { message?: string };
};

/** Extrai o base64 do data URL (ou null se for http/sem match). */
function b64FromDataUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  const m = u.match(/^data:image\/\w+;base64,(.+)$/);
  return m ? m[1] : null;
}

/** Acha a imagem de saída no shape do OpenRouter (images[] primeiro; content[] como fallback). */
function extractImageB64(data: ORResp): string | null {
  const msg = data.choices?.[0]?.message;
  if (!msg) return null;
  for (const im of msg.images ?? []) {
    const b = b64FromDataUrl(im.image_url?.url ?? im.url);
    if (b) return b;
  }
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const p of content) {
      const rec = p as { image_url?: { url?: string }; url?: string } | undefined;
      const b = b64FromDataUrl(rec?.image_url?.url ?? rec?.url);
      if (b) return b;
    }
  }
  return null;
}

/**
 * Edita `pngPath` conforme `prompt` e devolve o PNG resultante (Buffer). Lança em qualquer
 * falha (sem chave, rede, HTTP != 2xx, resposta sem imagem) — o caller decide o fallback.
 */
export async function editImageOpenRouter(pngPath: string, prompt: string, signal?: AbortSignal): Promise<Buffer> {
  const key = (process.env.OPENROUTER_API_KEY ?? "").trim();
  if (!key) throw new Error("OPENROUTER_API_KEY ausente no backend — configure para o fit via OpenRouter.");
  const dataUrl = `data:image/png;base64,${fs.readFileSync(pngPath).toString("base64")}`;

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      // recomendados pelo OpenRouter (atribuição do app); não são segredo.
      "HTTP-Referer": process.env.OPENROUTER_REFERER ?? "https://app.blueoceanos.com",
      "X-Title": "Fluxo Ouro",
    },
    body: JSON.stringify({
      model: MODEL,
      modalities: ["image", "text"],
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: prompt },
        ],
      }],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`OpenRouter image ${res.status}: ${(await res.text()).slice(-400)}`);
  const data = (await res.json()) as ORResp;
  if (data.error?.message) throw new Error(`OpenRouter image erro: ${data.error.message}`);
  const b64 = extractImageB64(data);
  if (!b64) throw new Error(`OpenRouter não retornou imagem (${MODEL}). Resposta: ${JSON.stringify(data).slice(-300)}`);
  return Buffer.from(b64, "base64");
}
