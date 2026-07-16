import { visionFromPaths } from "./visionPrompt.js";

/**
 * PROMPT COMPILER — replica o que o ChatGPT faz internamente ao gerar imagem: expande o
 * pedido de UMA linha do usuário num prompt ESTRUTURADO E LONGO (composição elemento a
 * elemento, tipografia, paleta, luz, materiais, restrições), que segue ao gpt-image JUNTO
 * das duas imagens. É o oposto deliberado do autor curto (60/120): tarefa de RESTYLE
 * (preservar a composição da Imagem 1, aplicar a linguagem visual da Imagem 2) precisa de
 * descrição densa — o teto curto foi calibrado p/ compor-de-esboço, não p/ isto.
 *
 * Medida de calibração: o resultado manual do usuário no ChatGPT (pasta vid/) — mesmo
 * layout pixel a pixel, estilo transplantado. Este compilador é avaliado contra ele.
 */

export type VisionFn = (prompt: string, paths: string[], signal?: AbortSignal) => Promise<string>;

export interface CompileInput {
  layoutPath: string;       // Imagem 1 — o design de referência cuja COMPOSIÇÃO é preservada
  stylePath?: string;       // Imagem 2 — a linguagem visual (paleta/luz/materiais)
  briefing: string;         // o pedido do usuário (1 linha basta — o compilador expande)
  /** texto do headline NOVO (troca o da referência); vazio = manter o texto da referência */
  texto?: string;
  /** cores do projeto (COLOR LAW) — mandam sobre a paleta da imagem de estilo */
  cores?: string;
  /**
   * "restyle" (default): Imagem 1 é um design PRONTO — preservar composição elemento a elemento.
   * "esboco": Imagem 1 é um SKETCH/blueprint — restrição GEOMÉTRICA 100% (posição/escala/
   * alinhamento/espaço negativo/enquadramento), NUNCA estética; o traço cru vira arte final.
   */
  modo?: "restyle" | "esboco";
  /**
   * ELEMENTOS (referências secundárias): objetos que DEVEM aparecer na tela replicados
   * fielmente (nota amassada, logo, produto...). O lugar vem do briefing/esboço; as cores
   * do elemento NÃO contaminam a paleta da tela.
   */
  elementoPaths?: string[];
  signal?: AbortSignal;
}

export interface CompileResult {
  prompt: string;
  source: "claude" | "erro";
  wordCount: number;
  tentativas: number;
  motivoFallback?: string;
}

const countWords = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

function parse(raw: string): string | null {
  const m = raw.match(/<PROMPT_FINAL>([\s\S]*?)<\/PROMPT_FINAL>/i);
  const p = m?.[1]?.trim();
  return p && countWords(p) >= 150 ? p : null; // compilado curto demais = falhou a tarefa
}

function systemPrompt(input: CompileInput, retryNote: string): string {
  const esboco = input.modo === "esboco";
  return [
    `Você é o COMPILADOR DE PROMPT de um gerador de imagens profissional (o mesmo papel do rewriter interno do ChatGPT). Você vê as imagens e expande o pedido curto do usuário num prompt LONGO, denso e estruturado, em INGLÊS, para o gpt-image — que vai receber o seu prompt JUNTO das mesmas imagens.`,
    ``,
    esboco
      // MODO ESBOÇO: o sketch é restrição GEOMÉTRICA (blueprint), a referência é restrição
      // ESTÉTICA — hierarquia fixa, com as frases-chave que evitam o modelo "interpretar".
      ? [
        `- Imagem 1 = SKETCH (esboço à mão): é um BLUEPRINT DE LAYOUT, NÃO uma referência de estilo e NÃO um desenho a ser copiado esteticamente. O prompt compilado DEVE conter, com este peso, as instruções: "The sketch is NOT a style reference. Treat it as a strict layout blueprint. Every object position, every alignment, every proportion, every spacing, every margin, every scale relationship must remain identical. Do not redesign the layout. Do not reinterpret the composition. Only replace the rough sketch with polished final artwork."`,
        `- Do sketch, PRESERVE (geometria, 100% obrigatório): posição de cada elemento e de cada texto, escala, alinhamento, espaço negativo, proporções, perspectiva/ângulo, orientação, enquadramento, hierarquia visual, margens. Traços/rótulos crus do esboço NUNCA aparecem no resultado — viram arte final polida nos MESMOS lugares.`,
        input.stylePath
          ? `- Imagem 2 = ESTILO: extraia SOMENTE a linguagem visual — iluminação, materiais, texturas, qualidade de render, cores, profundidade, atmosfera, contraste, reflexos. O prompt DEVE dizer: "Extract ONLY the visual language from the style reference. Ignore its composition. Ignore its object placement. Ignore its typography hierarchy. Ignore its framing."`
          : `- (Sem imagem de estilo — o estilo vem só do briefing.)`,
        `- CONFLITO: o prompt DEVE declarar "The sketch has priority over the style reference. Whenever there is a conflict, always follow the sketch."`,
      ].join("\n")
      : [
        `- Imagem 1 = LAYOUT (design de referência): a COMPOSIÇÃO dela é sagrada. Descreva-a elemento a elemento: posição, tamanho relativo, hierarquia, espaçamento, alinhamento de cada bloco (logo, headline, sub-texto, objeto central, rodapé...). O resultado deve poder ser sobreposto ao original com os elementos nos MESMOS lugares.`,
        input.stylePath
          ? `- Imagem 2 = ESTILO: a LINGUAGEM VISUAL. Descreva paleta exata, fundo, iluminação, glow, materiais, acabamento, tratamento tipográfico. O resultado veste a composição da Imagem 1 com esta pele — e NUNCA herda a composição da Imagem 2.`
          : `- (Sem imagem de estilo — o estilo vem só do briefing.)`,
      ].join("\n"),
    (input.elementoPaths?.length
      ? `- ${input.elementoPaths.length === 1 ? "A imagem seguinte é" : `As ${input.elementoPaths.length} imagens seguintes são`} ELEMENTO(S) (referências secundárias, na ordem: ELEMENTO 1, 2…): cada um é um OBJETO que DEVE aparecer na tela, REPLICADO FIELMENTE — mesma forma, cores e detalhes; não redesenhe nem reinterprete. No prompt compilado, descreva cada ELEMENTO pelo QUE ELE É (ex.: "the crumpled banknote from the attached reference") e onde vai (do briefing${esboco ? "/esboço" : ""}). As cores do elemento pertencem SÓ a ele — nunca contaminam a paleta da tela.`
      : ""),
    `- BRIEFING do usuário (manda em conflitos): "${input.briefing.trim()}"`,
    input.cores?.trim() ? `- CORES DO PROJETO (lei — mandam sobre a paleta do estilo): ${input.cores.trim()}. Na seção COLOR PALETTE, use SÓ estas famílias.` : "",
    input.texto?.trim()
      ? `- TROCA DE TEXTO: o headline do resultado é "${input.texto.trim()}" (substitui o da referência; MESMA posição, hierarquia e tratamento). Os demais textos da referência: remova-os, a não ser que o briefing diga o contrário.`
      : `- TEXTOS: mantenha os textos da Imagem 1 EXATAMENTE como estão (caractere por caractere).`,
    `- DESTAQUES: se a Imagem 1 destaca uma palavra com caixa/pill/box/cor atrás dela, o resultado PRESERVA esse tratamento no MESMO lugar (adaptado à paleta) — descreva-o explicitamente na seção TYPOGRAPHY.`,
    ``,
    esboco
      ? [
        `ESTRUTURA OBRIGATÓRIA do prompt compilado (use estes cabeçalhos, em inglês):`,
        `GEOMETRY (from the sketch — preserve 100%) — elemento a elemento do sketch: posição de texto e objetos, escala, ângulo de câmera, espaço negativo, margens, composição, hierarquia visual, enquadramento.`,
        `TEXT CONTENT — todo texto que aparece, verbatim, entre aspas, e onde (do sketch/briefing).`,
        `STYLE (from the reference — borrow ONLY) — iluminação, materiais, texturas, qualidade de render, cores, profundidade, atmosfera, contraste, reflexos.`,
        `TYPOGRAPHY — família/peso/tratamento (do estilo/briefing; a POSIÇÃO vem do sketch).`,
        `COLOR PALETTE — cores exatas; o que é fundo/acento/texto.`,
        `CONFLICT RULE — "The sketch has priority over the reference."`,
        `RESTRICTIONS — não redesenhar o layout, não reinterpretar a composição, não herdar composição/enquadramento da referência, não inventar elementos/texto, sem marca d'água.`,
      ].join("\n")
      : [
        `ESTRUTURA OBRIGATÓRIA do prompt compilado (use estes cabeçalhos, em inglês):`,
        `COMPOSITION & LAYOUT PRESERVATION — elemento a elemento da Imagem 1, com posições.`,
        `TEXT CONTENT — todo texto que aparece, verbatim, entre aspas, e onde.`,
        `TYPOGRAPHY — família/peso/caixa/tratamento (glow, caixa de destaque etc.).`,
        `COLOR PALETTE — cores exatas (nomeie e aproxime hex), o que é fundo/acento/texto.`,
        `LIGHTING & MATERIALS — luz, glow, reflexos, materiais, atmosfera.`,
        `BACKGROUND & DEPTH — fundo, gradientes, profundidade de campo, decoração.`,
        `RESTRICTIONS — o que NÃO fazer: não mudar a composição, não inventar elementos/texto, sem marca d'água, margens seguras, etc.`,
      ].join("\n"),
    input.elementoPaths?.length
      ? `ELEMENTS — seção obrigatória extra: cada ELEMENTO anexado, descrito pelo que É, com a instrução de réplica fiel + posição + "its colors must NOT influence the screen's palette".`
      : "",
    ``,
    `TAMANHO: 400 a 800 palavras. Denso e específico — cada frase uma decisão de design. Sem enrolação genérica ("make it beautiful") e sem markdown.`,
    ``,
    `Responda SOMENTE com o prompt entre as tags:`,
    `<PROMPT_FINAL>`,
    `(o prompt compilado)`,
    `</PROMPT_FINAL>`,
    retryNote,
  ].filter(Boolean).join("\n");
}

export async function compileImagePrompt(input: CompileInput, vision: VisionFn = visionFromPaths): Promise<CompileResult> {
  // ordem das imagens = a MESMA que o gerador vai receber: layout, estilo?, elementos…
  const paths = [input.layoutPath, input.stylePath, ...(input.elementoPaths ?? [])].filter((p): p is string => !!p);
  let retryNote = "";
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    let saida: string;
    try {
      saida = await vision(systemPrompt(input, retryNote), paths, input.signal);
    } catch (e) {
      return { prompt: "", source: "erro", wordCount: 0, tentativas: tentativa, motivoFallback: `visão falhou: ${(e as Error).message}` };
    }
    const prompt = parse(saida);
    if (prompt) return { prompt, source: "claude", wordCount: countWords(prompt), tentativas: tentativa };
    retryNote = "\nSua resposta anterior não veio entre <PROMPT_FINAL>…</PROMPT_FINAL> com ao menos ~400 palavras estruturadas. Responda EXATAMENTE nesse formato, completo.";
  }
  return { prompt: "", source: "erro", wordCount: 0, tentativas: 2, motivoFallback: "formato inválido (2 tentativas)" };
}
