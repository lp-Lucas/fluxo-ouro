import { type FlowAspect } from "../../../shared/flow.js";
import { visionFromPaths } from "./visionPrompt.js";

/**
 * CLAUDE-AUTOR (Fase 1) — o Claude vira o INPUT HUMANO do chatgptStyle, não o substitui.
 * Ele VÊ as duas imagens (layout + estilo) + o delta do usuário e ESCREVE o prompt de geração.
 * Esse prompt + AS MESMAS duas imagens vão ao /v1/responses, onde o GPT-5 vê as imagens e gera.
 * O texto do Claude é a TRAVA contra cópia de composição/cor: ele diz que o estilo fornece só
 * tipografia/material/luz, nunca layout nem cor (cor = COLOR LAW da identidade).
 *
 * Atrás da flag FLOW_PROMPT_AUTHOR=claude|raw. `raw` devolve o sistema de HOJE (delta cru +
 * identidade → design-chat) sem revert. Sem imagem de estilo, também cai em `raw` (medido:
 * sem estilo o Claude só reorganiza o delta, ganho ~nulo).
 *
 * O bloco de COLOR LAW/identidade vem PRONTO em `identityBlock` (o chamador monta: do campo
 * `cores` no fluxo novo, ou via `identityToPrompt` no caminho antigo). styleDesc = saída
 * TRANSITÓRIA por geração (ESTILO é por-geração no fluxo novo, sem cache/invalidação).
 */

// Aperto DEVAGAR (não o 43 de um teste nulo): baseline real tinha mediana 25; o alvo
// puxa o comportamento pra baixo sem apostar num número não-provado. Instrumentado:
// o .prompt.txt grava `palavras`; se bater o teto em >20% das 1ªs 30 gerações reais, revisar.
const ALVO = 60;   // palavras-alvo do CORPO (pós-identidade)
const TETO = 120;   // teto DURO (aperto deliberado, não medido — o A/B foi inconclusivo)

/** Assinatura da primitiva de visão — costura p/ testar os guards sem API. */
export type VisionFn = (prompt: string, paths: string[], signal?: AbortSignal) => Promise<string>;

export interface AuthorPromptInput {
  texto: string;            // o headline — o ÚNICO texto na tela (a frase do momento)
  layoutPath?: string;      // slot LAYOUT (Imagem 1) — a composição desejada
  stylePath?: string;       // slot ESTILO (Imagem 2) — tipografia/material/luz
  delta: string;            // cena: o que aparece/onde, o que ter, o que evitar
  identityBlock: string;    // bloco COLOR LAW pré-montado (do campo `cores`, ou compat via identityToPrompt)
  aspectRatio: FlowAspect;
  signal?: AbortSignal;
}

export interface AuthorPromptResult {
  prompt: string;               // PROJECT IDENTITY verbatim no topo + corpo → vai ao design-chat
  styleDesc?: string;           // extraído da imagem de estilo (persistir só se identity.styleDesc vazio)
  source: "claude" | "raw";
  wordCount: number;            // palavras do CORPO (pós-identidade)
  tentativas: number;           // 1 ou 2 (retry por comprimento/formato)
  motivoFallback?: string;      // preenchido quando source="raw"
}

const countWords = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Palavras do corpo = tudo depois do bloco de identidade (que é prefixo conhecido). */
function corpoWords(prompt: string, identityBlock: string): number {
  const corpo = identityBlock ? prompt.replace(identityBlock, "").trim() : prompt;
  return countWords(corpo);
}

/** Extrai <STYLE_DESC> e <PROMPT> da saída do Claude. null se o formato for inválido. */
function parseTags(raw: string): { styleDesc: string; prompt: string } | null {
  const prompt = raw.match(/<PROMPT>([\s\S]*?)<\/PROMPT>/i)?.[1]?.trim();
  if (!prompt) return null;
  const styleDesc = raw.match(/<STYLE_DESC>([\s\S]*?)<\/STYLE_DESC>/i)?.[1]?.trim() ?? "";
  return { styleDesc, prompt };
}

/** FALLBACK `raw`: o comportamento de hoje — delta cru + identidade → design-chat. */
function raw(input: AuthorPromptInput, identityBlock: string, motivo: string, tentativas = 1): AuthorPromptResult {
  const corpo = [
    `Headline (the ONLY text on screen, keep Portuguese accents): "${input.texto.trim()}".`,
    input.delta.trim(),
  ].filter(Boolean).join(" ");
  const prompt = identityBlock ? `${identityBlock}\n\n${corpo}` : corpo;
  return { prompt, styleDesc: undefined, source: "raw", wordCount: countWords(corpo), tentativas, motivoFallback: motivo };
}

/** System prompt do Claude-autor: instrução PT-BR, saída EN (destinatário = GPT-5 no Responses). */
function systemPrompt(input: AuthorPromptInput, identityBlock: string, retryNote: string): string {
  const temLayout = !!input.layoutPath;
  return [
    `Você escreve o prompt para o GPT-5, que vai VER estas MESMAS imagens e gerar uma tela de design ${input.aspectRatio}. Você também vê as imagens.`,
    temLayout
      ? `- Imagem 1 = LAYOUT: a composição. Onde cada coisa fica. Rótulos manuscritos NOMEIAM posições — nunca viram texto na tela. Ignore as cores do rascunho.`
      : `- (Sem imagem de layout — componha uma tela limpa e profissional.)`,
    `- Imagem ${temLayout ? "2" : "1"} = ESTILO: dela o GPT-5 tira APENAS tipografia, material, luz e acabamento — NUNCA a composição/layout, NUNCA a cor. Escreva isso EXPLÍCITO no seu prompt: "use the style reference ONLY for typography, material and finish; never copy its layout; never take its colors."`,
    input.delta.trim() ? `- DELTA do usuário (a CENA — o que aparece e onde, o que evitar): "${input.delta.trim()}".` : `- (Sem delta — apenas encaixe o headline na identidade/layout.)`,
    `- O headline (ÚNICO texto na tela, mantenha os acentos): "${input.texto.trim()}".`,
    identityBlock ? `\nBloco PROJECT IDENTITY (prioridade MÁXIMA — a paleta dele é a ÚNICA cor permitida):\n${identityBlock}` : "",
    ``,
    `REGRAS DE SAÍDA (há guards no código — não confie só na sua obediência):`,
    identityBlock ? `1. O bloco PROJECT IDENTITY entra VERBATIM no topo do <PROMPT>. Não reescreva, não resuma, não traduza — copie.` : `1. (Sem identidade definida.)`,
    `2. Corpo (após a identidade) no máximo ${ALVO} palavras. Prompts longos diluem e o GPT-5 perde o layout. Se estourar, corte ADJETIVOS, nunca instruções de posição.`,
    `3. Imperativo. Linke estilo→design em texto: "apply the style ref's <material/typography> to the PROJECT IDENTITY palette."`,
    `4. A imagem de ESTILO informa MATERIAL e TIPOGRAFIA, jamais COR. Estilo azul + identidade verde → tela verde.`,
    `5. Margens de segurança (nada encosta na borda); disciplina de acento (só a cor de marca acentua).`,
    ``,
    `Saída EXATA, sem preâmbulo, sem markdown:`,
    `<STYLE_DESC>`,
    `(2-4 frases descrevendo o estilo: fundo, material, tipografia, luz. Vazio se não houver imagem de estilo.)`,
    `</STYLE_DESC>`,
    `<PROMPT>`,
    `(${identityBlock ? "o bloco PROJECT IDENTITY verbatim, depois " : ""}o corpo em inglês, até ${ALVO} palavras)`,
    `</PROMPT>`,
    retryNote,
  ].filter(Boolean).join("\n");
}

export async function authorDesignPrompt(input: AuthorPromptInput, vision: VisionFn = visionFromPaths): Promise<AuthorPromptResult> {
  const identityBlock = input.identityBlock;

  // FLAG: FLOW_PROMPT_AUTHOR=raw devolve o sistema de hoje, sem revert.
  if ((process.env.FLOW_PROMPT_AUTHOR ?? "claude") !== "claude") {
    return raw(input, identityBlock, "flag FLOW_PROMPT_AUTHOR=raw");
  }
  // Sem imagem de estilo, o Claude só reorganiza o delta (medido: ganho ~nulo) → raw.
  if (!input.stylePath) return raw(input, identityBlock, "sem imagem de estilo");

  const paths = [input.layoutPath, input.stylePath].filter((p): p is string => !!p);
  let retryNote = "";
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    let saida: string;
    try {
      saida = await vision(systemPrompt(input, identityBlock, retryNote), paths, input.signal);
    } catch (e) {
      return raw(input, identityBlock, `visão falhou: ${(e as Error).message}`, tentativa);
    }

    const parsed = parseTags(saida);
    if (!parsed) {
      if (tentativa === 1) { retryNote = "\nSua resposta anterior não seguiu o formato <STYLE_DESC>…</STYLE_DESC><PROMPT>…</PROMPT>. Responda EXATAMENTE nesse formato."; continue; }
      return raw(input, identityBlock, "formato de saída inválido", tentativa);
    }

    // GARANTE identidade: se o Claude não copiou o bloco, re-injeta (preserva o corpo dele).
    let prompt = parsed.prompt.trim();
    if (identityBlock && !prompt.includes("PROJECT IDENTITY")) prompt = `${identityBlock}\n\n${prompt}`;

    const palavras = corpoWords(prompt, identityBlock);
    if (palavras > TETO) {
      if (tentativa === 1) {
        retryNote = `\nSua resposta anterior teve ${palavras} palavras no corpo (limite ${ALVO}). Reescreva cortando ADJETIVOS, mantendo TODAS as instruções de posição.`;
        continue;
      }
      return raw(input, identityBlock, `corpo longo demais (${palavras} palavras)`, tentativa);
    }

    return { prompt, styleDesc: parsed.styleDesc || undefined, source: "claude", wordCount: palavras, tentativas: tentativa };
  }
  return raw(input, identityBlock, "esgotou as tentativas");
}
