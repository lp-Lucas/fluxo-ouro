import { type FlowAspect } from "../../../shared/flow.js";
import { visionFromPaths } from "./visionPrompt.js";

/**
 * DESIGNER EM CÓDIGO (D1 do design híbrido): em vez de pedir a tela a um modelo de difusão
 * (tipografia torta, inconsistência entre telas), o Claude VÊ o layout + a ref de estilo e
 * ESCREVE a tela em HTML/CSS autocontido — texto pixel-perfect, cores exatas por token,
 * mesma fonte sempre. O PNG sai do Chrome headless (renderHtml.ts), determinístico.
 *
 * Elementos orgânicos complexos (mascote, foto, 3D real) NÃO são deste caminho — viram
 * camada própria (D3, gpt-image transparente). Aqui: tipografia, formas, ícones SVG
 * line-art, glow/gradiente em CSS.
 */

export type VisionFn = (prompt: string, paths: string[], signal?: AbortSignal) => Promise<string>;

export interface HtmlDesignInput {
  texto: string;            // headline — o ÚNICO texto grande da tela
  layoutPath?: string;      // slot LAYOUT — a composição desejada
  stylePath?: string;       // slot ESTILO — o mundo visual a traduzir em CSS
  delta: string;            // o que ter / não ter / mudanças
  cores?: string;           // COLOR LAW — as únicas cores permitidas
  aspectRatio: FlowAspect;
  /** HTML da tela ATUAL (iteração): o delta vira EDIÇÃO deste código, não tela nova. */
  htmlAtual?: string;
  signal?: AbortSignal;
}

export interface HtmlDesignResult {
  html: string;
  source: "claude" | "erro";
  tentativas: number;
  motivoFallback?: string;
}

function dims(a: FlowAspect): { w: number; h: number } {
  if (a === "16:9") return { w: 1920, h: 1080 };
  if (a === "1:1") return { w: 1080, h: 1080 };
  return { w: 1080, h: 1920 };
}

/** Extrai o documento entre <HTML_TELA>...</HTML_TELA>. */
function parseHtml(raw: string): string | null {
  const m = raw.match(/<HTML_TELA>([\s\S]*?)<\/HTML_TELA>/i);
  const html = m?.[1]?.trim();
  if (!html || !/<html|<body|<div/i.test(html)) return null;
  return html;
}

function systemPrompt(input: HtmlDesignInput, retryNote: string): string {
  const { w, h } = dims(input.aspectRatio);
  const temImgs = !!(input.layoutPath || input.stylePath);
  const editando = !!input.htmlAtual;
  return [
    `Você é um motion designer sênior que constrói telas EM CÓDIGO. ${editando
      ? `EDITE o HTML atual (abaixo) aplicando APENAS as mudanças pedidas — não redesenhe o que não foi pedido.`
      : `Escreva UMA tela de design como um documento HTML COMPLETO e AUTOCONTIDO.`}`,
    temImgs ? `Você vê imagem(ns) de referência:` : "",
    input.layoutPath ? `- Imagem 1 = LAYOUT: a composição — onde cada coisa fica. Rótulos manuscritos NOMEIAM posições (nunca viram texto). Ignore as cores do rascunho.` : "",
    input.stylePath ? `- Imagem ${input.layoutPath ? "2" : "1"} = ESTILO: traduza o MUNDO VISUAL dela em CSS — fundo (gradiente/chapado), glow, materiais, peso tipográfico. NÃO copie a composição dela.` : "",
    `- Headline (o ÚNICO texto grande, exatamente assim, com acentos): "${input.texto.trim()}"`,
    input.delta.trim() ? `- Pedido do usuário: "${input.delta.trim()}"` : "",
    input.cores?.trim() ? `- COLOR LAW (estrita): as ÚNICAS cores da tela são ${input.cores.trim()}. Nenhuma outra família de cor.` : "",
    ``,
    `REGRAS TÉCNICAS — obrigatórias:`,
    `1. Documento completo: <!doctype html><html><head>…</head><body>…</body></html>. TUDO inline (CSS num <style>). ÚNICA exceção de rede: Google Fonts via <link> (fonts.googleapis.com).`,
    `2. A tela é EXATAMENTE ${w}×${h}px: body { margin:0; width:${w}px; height:${h}px; overflow:hidden; }.`,
    `3. Ícones e figuras: SVG INLINE estilizado (line-art, traço uniforme 4-8px, stroke-linecap:round). Neon/glow: filter: drop-shadow em camadas. NUNCA <img> externo, NUNCA emoji.`,
    `4. Margens de segurança: nada encosta a menos de 8% das bordas.`,
    `5. Sem JavaScript, sem animação (é um still).`,
    `6. Capricho de acabamento: gradientes suaves no fundo, glow em camadas (text-shadow múltiplo), hierarquia tipográfica forte. A tela deve parecer motion design premium, não slide.`,
    editando ? `\nHTML ATUAL (edite este):\n${input.htmlAtual}` : "",
    ``,
    `Responda SOMENTE com o documento entre as tags, sem markdown:`,
    `<HTML_TELA>`,
    `(o documento completo)`,
    `</HTML_TELA>`,
    retryNote,
  ].filter(Boolean).join("\n");
}

export async function authorDesignHtml(input: HtmlDesignInput, vision: VisionFn = visionFromPaths): Promise<HtmlDesignResult> {
  const paths = [input.layoutPath, input.stylePath].filter((p): p is string => !!p);
  let retryNote = "";
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    let saida: string;
    try {
      saida = await vision(systemPrompt(input, retryNote), paths, input.signal);
    } catch (e) {
      return { html: "", source: "erro", tentativas: tentativa, motivoFallback: `visão falhou: ${(e as Error).message}` };
    }
    const html = parseHtml(saida);
    if (html) return { html, source: "claude", tentativas: tentativa };
    retryNote = "\nSua resposta anterior não veio entre <HTML_TELA>…</HTML_TELA> com um documento HTML válido. Responda EXATAMENTE nesse formato.";
  }
  return { html: "", source: "erro", tentativas: 2, motivoFallback: "formato de saída inválido (2 tentativas)" };
}
