import { runClaude, extractJson } from "../autocut/aiCut.js";
import type { FlowMoment, FlowPhrase } from "../../../shared/flow.js";

/** Palavra indexada da transcrição (a IA decide por índice; o tempo é do whisper). */
export interface FlowWord { text: string; start: number; end: number; }

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * DETECÇÃO: a IA lê a transcrição (+copy opcional) e devolve de 3 A 5 momentos
 * onde motion design agrega, cada um segmentado em frases por índice de palavra.
 * O usuário pode depois REMOVER, JUNTAR frases e ADICIONAR momentos manuais
 * (na transcrição, como o popup) — teto total de 5.
 * Valida: índices no range, frases ordenadas e sem sobreposição, ≥1 frase/momento.
 */
export async function detectFlowMoments(words: FlowWord[], copy: string, signal?: AbortSignal): Promise<FlowMoment[]> {
  if (words.length === 0) return [];
  const lista = words.map((w, i) => `#${i} "${w.text}"`).join(" ");
  const copyBloco = copy.trim() ? `\n\nROTEIRO (copy), como contexto:\n"""\n${copy.trim()}\n"""` : "";

  const prompt = [
    `Você é diretor de motion design. Recebe a transcrição de um vídeo (palavras indexadas).`,
    `Identifique de 3 a 5 MOMENTOS onde uma tela de motion design agrega valor: dados/números,`,
    `enumerações/listas, perguntas retóricas, contrastes, marcas ou CTAs. QUALIDADE acima de`,
    `quantidade: só passe de 3 se os momentos extras forem realmente fortes.`,
    `REGRA DE OURO — cada FRASE = UMA CENA VISUAL = UMA animação. Pense como quem vai DESENHAR a`,
    `tela: a frase é o que cabe numa imagem só, contando UMA coisa. O gatilho pra quebrar em nova`,
    `frase é a IMAGEM MUDAR, mesmo dentro da mesma oração gramatical.`,
    `EXEMPLO CANÔNICO: "transforme o cliente que chegou 11 da noite, em dinheiro no seu bolso" são`,
    `DUAS frases/telas: (1) "o cliente que chegou 11 da noite" — a cena do cliente/horário; e`,
    `(2) "em dinheiro no seu bolso" — a cena do resultado. Estruturas "de X para Y", "transforme X`,
    `em Y", "não é A, é B", antes/depois, causa→efeito: SEMPRE viram duas telas (o "antes" e o`,
    `"depois" são imagens diferentes). A vírgula/conjunção costuma marcar esse ponto de virada.`,
    `NÃO fragmente no meio de UMA cena (não corte "o cliente que chegou" / "11 da noite" — é uma`,
    `imagem só), e NÃO junte duas cenas numa frase. Mire 4 a 10 palavras por frase (~2 a 5s):`,
    `tempo pra animação respirar, sem espremer dois assuntos.`,
    `CADA frase vira UM cartão visual legível. Use SEMPRE índices de palavra (nunca invente tempo).`,
    `As frases de um momento devem ser contíguas, ordenadas e sem sobreposição.`,
    copyBloco,
    `\nTRANSCRIÇÃO:\n${lista}`,
    `\nResponda SOMENTE JSON:`,
    `{"moments":[{"wordStart":<i>,"wordEnd":<i>,"reason":"<curta, PT-BR>","phrases":[{"wordStart":<i>,"wordEnd":<i>}]}]}`,
  ].join("\n");

  const text = await runClaude(prompt, signal);
  const parsed = extractJson(text) as { moments?: Array<{ wordStart: number; wordEnd: number; reason?: string; phrases?: Array<{ wordStart: number; wordEnd: number }> }> };
  const raw = Array.isArray(parsed.moments) ? parsed.moments.slice(0, 5) : [];

  const clamp = (n: number) => Math.max(0, Math.min(words.length - 1, Math.round(n)));
  const moments: FlowMoment[] = [];
  for (const m of raw) {
    const ms = clamp(m.wordStart), me = clamp(m.wordEnd);
    if (me < ms) continue;
    const phrasesRaw = (Array.isArray(m.phrases) && m.phrases.length ? m.phrases : [{ wordStart: ms, wordEnd: me }])
      .map((p) => ({ s: clamp(p.wordStart), e: clamp(p.wordEnd) }))
      .filter((p) => p.e >= p.s && p.s >= ms && p.e <= me)
      .sort((a, b) => a.s - b.s);
    // remove sobreposição (corta o início da próxima p/ depois do fim da anterior)
    const phrases: FlowPhrase[] = [];
    let last = -1;
    for (const p of phrasesRaw) {
      const s = Math.max(p.s, last + 1);
      if (p.e < s) continue;
      const text2 = words.slice(s, p.e + 1).map((w) => w.text).join(" ");
      phrases.push({ id: uid("phrase"), wordStart: s, wordEnd: p.e, text: text2, status: "detected" });
      last = p.e;
    }
    if (phrases.length === 0) continue;
    moments.push({ id: uid("moment"), wordStart: ms, wordEnd: me, reason: (m.reason ?? "").trim() || "Momento de motion", phrases });
  }
  return moments;
}

/**
 * PROMPT DE DESIGN: monta o prompt (EN) para o gpt-image a partir da FRASE + o que o
 * usuário descreveu + as TAGS das imagens de referência (logo/estilo/referência/esboço).
 * A IA interpreta os papéis (ex: "use a logo fornecida", "siga o estilo da referência")
 * e escreve instruções de composição; as imagens em si vão direto ao gpt-image (edits).
 */
// Ordem canônica das referências: o ESBOÇO (layout) vai PRIMEIRO porque no `edits`
// a 1ª imagem é a BASE do resultado — a base define a COMPOSIÇÃO. Depois a "serie"
// (tela já aprovada do MESMO vídeo — âncora de coesão), elementos e logo por último.
// ("estilo" nunca chega como imagem no gerador — vira texto via análise de visão.)
// LEGADO (Fase 2): `orderRefs` só é usada pelos caminhos MORTOS de multi-tag no `edits`
// (buildDesignPromptDirect/AI/Vision + o endpoint /api/flow/design, sem roteamento). O caminho
// AUTHORED atual NÃO usa — ele fixa a ordem explícita [layout, estilo] no design-chat. NÃO
// aposentar agora: removê-la mexe em código morto (churn + risco) sem ganho. Fica como legado
// até a limpeza desses endpoints; o authored não depende dela.
const TAG_ORDER: Record<string, number> = { esboco: 0, serie: 1, estilo: 2, referencia: 3, logo: 4 };
export function orderRefs<T extends { tag: string }>(refs: T[]): T[] {
  return [...refs].sort((a, b) => (TAG_ORDER[a.tag] ?? 9) - (TAG_ORDER[b.tag] ?? 9)); // sort estável: elementos mantêm a ordem de upload
}

/**
 * Rótulo do papel de cada imagem no header do prompt. ELEMENTOS são NUMERADOS
 * ("ELEMENTO 1", "ELEMENTO 2"…) na ordem de upload — o usuário cita "(elemento 1)"
 * na descrição da cena e o modelo sabe exatamente qual imagem é.
 */
export function refHeaderLines(refs: { tag: string }[]): string[] {
  let el = 0;
  return refs.map((r, i) => {
    const num = r.tag === "referencia" ? ` — this is ELEMENTO ${++el}` : "";
    return `Image ${i + 1} — role "${r.tag}"${num}: ${refRole(r.tag)}.`;
  });
}

/**
 * PROMPT DIRETO (sem IA): espelha o fluxo manual que funcionava no ChatGPT —
 * "analisa o design da referência, REPLICA dentro do layout rascunho e coloca os
 * elementos". Curto e imperativo: as IMAGENS carregam a informação; o texto só
 * diz o papel de cada uma e a tarefa. Prompts longos e cheios de regra diluem a
 * instrução e o gpt-image ignora o layout — por isso NÃO anexar specs gigantes.
 */
export function buildDesignPromptDirect(input: {
  texto: string; userPrompt: string; refs: { tag: string }[]; identityBlock?: string;
}): string {
  const refs = orderRefs(input.refs);
  let el = 0;
  const hasStyle = refs.some((r) => r.tag === "estilo");
  const hasSketch = refs.some((r) => r.tag === "esboco");
  const lines = refs.map((r, i) => {
    const label =
      r.tag === "estilo" ? "the brand STYLE reference — this is the VISUAL WORLD of the video: reproduce its exact background (color, gradient, texture/grid), palette, lighting, materials and finish. You MAY reuse its objects/props (the same 3D pieces, the same scene elements) as supporting visuals when they fit the new scene — that keeps the world coherent. But this is a NEW screen for a NEW headline: never copy its text and never reproduce its exact composition as-is."
      : r.tag === "esboco" ? "LAYOUT sketch — the composition to follow: every part of the screen goes exactly where this sketch marks. Handwritten labels only NAME what goes in each spot (never render them as text). Ignore its colors and rough style."
      : r.tag === "serie" ? "an ALREADY APPROVED screen from THIS SAME video — the new screen MUST share its exact design system: same background treatment, same color palette, same typography (same font, same weights), same materials, same finish. Do NOT copy its composition, its text or its objects — only its design system, so both screens clearly belong to the same video."
      : r.tag === "referencia" ? `ELEMENTO ${++el} — replicate this exact object faithfully in the scene (same shape, colors and details); do not redraw, reinterpret or restyle it. Its colors belong to the OBJECT ONLY — they must NOT influence the screen's palette, banners or accents.`
      : r.tag === "logo" ? "the exact client logo — include it unaltered, where the layout marks."
      : "general visual reference.";
    return `Image ${i + 1}: ${label}`;
  });
  const hasSerie = refs.some((r) => r.tag === "serie");

  const task = hasStyle && hasSketch
    ? `TASK: Build a NEW screen with the LAYOUT sketch's composition${el ? ", placing the numbered ELEMENTO object(s) where indicated" : ""}, living in the SAME VISUAL WORLD as the style reference — same background, palette, lighting and finish, and reusing its props when they fit. It must look like the same designer made another screen of the same series.`
    : hasStyle
    ? `TASK: Build a NEW screen living in the SAME VISUAL WORLD as the style reference (same background, palette, lighting, finish; props may be reused when they fit — but a new composition for the new headline)${el ? ", placing the numbered ELEMENTO object(s) as described" : ""}.`
    : hasSketch
    ? `TASK: Create a clean premium screen following the LAYOUT sketch's composition exactly${el ? ", placing the numbered ELEMENTO object(s) where indicated" : ""}.`
    : `TASK: Create a clean premium screen for the headline below${el ? ", placing the numbered ELEMENTO object(s) as described" : ""}.`;

  return [
    input.identityBlock ?? "",
    lines.length ? `You are given ${refs.length} reference image(s), in this exact order:\n${lines.join("\n")}` : "",
    task,
    `Headline (the ONLY text on screen, exactly as written, keep Portuguese accents): "${input.texto.trim()}".`,
    `SAFE MARGINS — CRITICAL: leave a clear EMPTY margin of at least 10% of the frame width on the left and right, and 8% on top and bottom. The headline text block must fit ENTIRELY inside this inner area — make the font SMALLER if needed; letters must NEVER touch, kiss or bleed past the left/right edges, never cropped. Same for every element.`,
    input.userPrompt?.trim() ? `Scene notes (what appears and where): ${input.userPrompt.trim()}` : "",
    `Rules: do NOT invent any logo or extra text beyond the headline; NO random decorative geometric shapes or filler graphics — the screen contains the headline, the listed elements and (when fitting) props from the style reference's world, on a clean background; premium high-fidelity finish.`,
    `ACCENT DISCIPLINE: every UI accent on screen (banners, highlight bars, buttons, pills, glows, highlighted words) uses ONLY the brand accent color defined by the identity/style — NEVER a color sampled from an ELEMENTO image. The typography, banner style and finish must match the brand style so closely that this screen and the brand reference look made by the same designer.${hasSerie ? " CONSISTENCY: this screen is one of several in the SAME video — same font, same colors, same style as the approved screen; a viewer must instantly see they belong together." : ""}`,
  ].filter(Boolean).join("\n\n");
}

/** Instrução (EN) de como o gpt-image deve usar a imagem, conforme a tag. */
export function refRole(tag: string): string {
  switch (tag) {
    case "logo": return "include THIS EXACT logo in the screen, unaltered (do not redraw or restyle it); its PLACEMENT is defined by the layout sketch";
    case "estilo": return "THE MASTER STYLE — the CENTRAL ENGINE of this design. The final screen must look like it was made by the SAME designer as this image: same background treatment, same materials and surfaces, same lighting, same typography feel, same color grading. Do NOT copy its text/content — only its visual world";
    case "referencia": return "a DESIGN ELEMENT that MUST appear in the scene, REPLICATED FAITHFULLY — same object, same shape, same colors, same details as in this image. Do NOT redraw, reinterpret or restyle it (only scale and place it; change it ONLY if the scene description explicitly asks). Placement comes from the scene description / layout sketch";
    case "esboco": return "this is the LAYOUT/composition blueprint (possibly a rough hand-drawn sketch): it defines WHERE each thing goes. Handwritten labels in it (e.g. 'titulo', 'logo', 'elemento 1') NAME what goes in that spot — they are position markers, NEVER text to render. IGNORE its colors and rough drawing style (placeholders); the look comes from the master style";
    default: return "use as general visual reference";
  }
}

export async function buildDesignPromptAI(
  input: { texto: string; userPrompt: string; presetNome?: string; aspect: string; refs: { tag: string; name?: string }[]; identityBlock?: string },
  signal?: AbortSignal,
): Promise<string> {
  const refs = orderRefs(input.refs); // layout primeiro, estilo, logo por último
  const refIdx = refs.findIndex((r) => r.tag === "referencia");
  const skIdx = refs.findIndex((r) => r.tag === "esboco");
  const styleIdx = refs.findIndex((r) => r.tag === "estilo");
  const hasStyle = styleIdx >= 0;

  // Combinação por PAPEL: layout = posições; referência = elementos gráficos;
  // estilo = cores/fontes; logo = a logo (posição vem do layout).
  let fusion = "\n\nHOW TO BUILD THE SCREEN:";
  if (skIdx >= 0) {
    fusion += ` Use Image ${skIdx + 1} as the LAYOUT/composition — place the headline text, the graphic elements and the logo exactly where it indicates (positions, sizes, hierarchy). IGNORE its placeholder colors.`;
  }
  if (hasStyle) {
    fusion += ` Image ${styleIdx + 1} is the MASTER STYLE and the CENTRAL ENGINE: the whole screen is built IN ITS VISUAL WORLD — same background treatment, materials, lighting, typography feel and color grading, as if made by the same designer.`;
  }
  if (refIdx >= 0) {
    fusion += ` The ELEMENTO images are REPLICATED FAITHFULLY into the scene — same object, shape, colors and details; do NOT redraw or reinterpret them (only scale/place; change only if the scene description explicitly asks).`;
  }
  if (skIdx < 0 && refIdx < 0) {
    fusion += ` Create a clean, on-brand composition for the phrase${hasStyle ? " inside the master style's visual world" : ""}.`;
  }
  fusion += ` The main text is the phrase below (no other text). The scene description below defines WHAT appears and WHERE — follow it exactly, rendered in the master style.`;
  const hasLayout = refIdx >= 0 || skIdx >= 0;

  // Cabeçalho DETERMINÍSTICO: mapeia cada imagem (número + tag + nº de elemento).
  const header = refs.length
    ? "You are given the following reference images, IN THIS EXACT ORDER. Use EACH one strictly by its role:\n" +
      refHeaderLines(refs).join("\n") +
      "\nWhen the scene description mentions \"elemento 1\", \"elemento 2\"… it refers to the numbered ELEMENTO images above — REPLICATE each one faithfully, placed exactly where the description says." +
      fusion + "\n\n"
    : "";

  // Claude escreve só uma direção CURTA de ADAPTAÇÃO — NÃO inventa cena/estética.
  const ask = [
    input.identityBlock ? `IDENTIDADE DO PROJETO (peso MÁXIMO — cores/fonte/botões/ícones mandam em tudo):\n${input.identityBlock}\n` : "",
    `Você monta o prompt para o gpt-image gerar UMA tela ${input.aspect} para a frase: "${input.texto}".`,
    hasStyle || hasLayout
      ? `HÁ referências visuais (mapeadas à parte). Escreva 1 a 2 frases em INGLÊS dizendo como ENCAIXAR o texto`
        + ` "${input.texto}" na tela. A descrição do usuário abaixo define a CENA (o que aparece e onde);`
        + ` as CORES/estilos vêm da IDENTIDADE do projeto (se houver) — nunca de um esboço.`
        + ` NÃO invente cena, objeto 3D, torre, nuvem, mood "cinematográfico/dramático". Fique fiel.`
      : `Escreva em INGLÊS 2 a 3 frases descrevendo uma tela limpa e profissional para o texto (fundo, tipografia, hierarquia), seguindo a identidade se houver.`,
    `\nCENA DESCRITA PELO USUÁRIO (o que aparece e onde, PT-BR): "${input.userPrompt || "(sem descrição — apenas encaixe o texto na identidade/layout)"}".`,
    input.presetNome && !hasStyle && !hasLayout ? `Estilo base: ${input.presetNome}.` : "",
    `\nSem texto extra além da frase, sem marca d'água, sem UI. Não re-liste as imagens.`,
    `\nResponda SOMENTE JSON: {"designPrompt":"<texto curto em inglês>"}`,
  ].filter(Boolean).join("\n");

  const text = await runClaude(ask, signal);
  const parsed = extractJson(text) as { designPrompt?: string };
  const creative = (parsed.designPrompt ?? "").trim();
  if (!creative) throw new Error("Claude não retornou um prompt de design válido.");
  return header + creative; // imagens mapeadas PRIMEIRO, depois a direção criativa
}

/**
 * ESPECIFICAÇÃO DE MOTION — FIXA ("de lei"). Esta coreografia premium (estilo Apple/iOS)
 * é SEMPRE a mesma em todas as frases: é a assinatura de movimento do projeto. O que muda
 * por frase é APENAS quais elementos da cena existem — isso vem do que o usuário descreve.
 * Não deixamos a IA inventar animação; ela só descreve OS OBJETOS a serem animados.
 */
// IMPLEMENTAÇÃO: só temos UMA imagem real (o design final). O Veo ancora bem quando
// anima A PARTIR de um frame real — então pedimos a SAÍDA dos elementos (o design é o
// primeiro frame) e o backend INVERTE o vídeo → vira uma ENTRADA que termina EXATA no
// design. (O método start→end frame do Seedance exige DUAS imagens reais; com start
// vazio o Veo alucina no meio — por isso usamos inversão, não lastFrame.)
// O prompt descreve a SAÍDA; ao inverter vira: elementos = pop-scale c/ bounce;
// texto = desliza pra cima + fade + blur→nítido.
export const MOTION_SPEC = `The attached image is the FIRST frame and MUST be reproduced exactly at the start — do NOT redesign, recolor, add, remove, or reposition anything; keep every element's exact position, size, color, shape and typography. Static camera, no camera movement, no zoom.

Animate a simple, clean EXIT of the elements until ONLY the flat background remains. CRITICAL: keep the EXACT background color/tone already in the image (if the background is dark, it stays dark — never turn white). Each element keeps its own color and shape the whole time; it only fades/scales/slides away. Do NOT add or invent ANY new element, text, word, letter, grid, neon, light beam or effect.

USE ONLY THESE TWO MOTIONS — nothing else:
1) TEXT (any headline / text lines): fades out to 0% opacity while sliding DOWNWARD about 20px and softening into a slight blur. Smooth ease.
2) EVERY OTHER ELEMENT (icons, figures, shapes, cards, graphics, numbers): scales DOWN from 100% to about 80% with a soft little bounce while fading out to 0% opacity. No rotation, no spin, no sliding.

TIMING: elements leave with a small ~0.1s stagger, each exit lasting ~0.4-0.5s. Hold on the full image for a brief beat before the exit begins. No color changes, no silhouettes, no morphing, no 3D flips, no motion-blur trails, no flashy effects. Clean, premium, Apple-style micro-interactions only.`;

// MÉTODO start→end frame (Seedance/Higgsfield): o modelo recebe start-image (fundo
// vazio) + end-image (o design) e INTERPOLA a entrada — sem inversão. Prompt no padrão
// MotionIA (VIDEO_PROMPT_RULES): denso, SÓ movimento (as imagens já dizem a aparência),
// vocabulário fixo da REGRA V7 (pop+up, scale-in bounce), ≤2500 caracteres.
// ATENÇÃO: NÃO usar números/percentuais literais neste prompt (ex. "80%") — o Seedance
// pode DESENHAR o número na tela. Descrever escala/opacidade só com palavras.
/**
 * SEEDANCE 2.0 — SPEC DE ENTRADA (6 blocos, machine-readable): SHOT, ENTRANCE (com
 * JANELA TEMPORAL obrigatória), CAMERA, MOTION_QUALITY, HOLD, NEGATIVE (base + zonas
 * de risco). Anima sem deformação/ghosting/drift. Descreve SÓ movimento — a imagem
 * resolve composição/cor/texto. {SCENE} é preenchido pelo inventário estático da cena.
 * Valores fixos dentro dos ranges válidos: rise 20px, scale 0.95→1.0, blur-to-sharp,
 * push-in 3%, ease-out high damping, HOLD congela após ~1s.
 */
export const MOTION_SPEC_ENTRANCE = `[SHOT]
9:16 vertical motion design intro animation. {SCENE} materializing on screen with a smooth premium entrance.

[ENTRANCE — within the first 1 second]
The SOLID BACKGROUND COLOR already fills the ENTIRE frame from the very first frame — never a black screen, never a fade from black; the background is fully visible and static the whole time. The foreground elements then fade in ON TOP of that solid background: they rise up about 20px from just below their final position, with a soft scale from 0.95 to 1.0 and a blur-to-sharp fade transition. Each element settles into its EXACT final position and then holds completely still.
TEXT ANIMATION (the only motion for text) — WORD BY WORD: each word animates in individually, one after another in a quick left-to-right / top-to-bottom stagger. Each word rises up about 20px from just below its final position while fading in from 0 to full opacity and sharpening from a soft blur to crisp. No scaling, no rotation, no sliding sideways — only this rise + fade-in + blur-to-sharp per word. Every word lands in its EXACT final position, IDENTICAL to the input, character for character, then holds perfectly still.

[CAMERA]
Very slow push-in, 3%. Locked framing, no pan, no shake.

[MOTION_QUALITY]
Ease-out, high damping, no bounce, no overshoot. Slow, deliberate, elegant.

[HOLD — after entrance]
Once settled (after the first second), the scene is completely static and freezes. Only an extremely subtle ambient light shimmer on the background is allowed. All precise elements — text, numbers, icons, shapes, cards — stay perfectly frozen in their final position for the rest of the clip.

[NEGATIVE]
no black screen, no black frame, no fade from black, no fade to black, no blackout, no dark flash, no empty dark frame at the start, no flicker, no jitter, no large motion, no camera shake, no ghosting, no morphing, no elements drifting after settling, no distortion, no text warping, no text morphing, no letters changing shape, no ghost text, no duplicated or doubled text, no gibberish, no rotating or moving clock hands, no melting hands, no duplicating tick marks, no clock face distortion, no logo distortion, no icon morphing, no asymmetry, no face warping, no wavy lines, no jitter on straight edges, no new invented elements, no extra objects, no panels, no cards or glass containers appearing, no background scenery, no people.`;

/**
 * SEEDANCE 2.0 — SPEC DE CONTINUIDADE (mesma estrutura de 6 blocos da entrada, mas
 * para transição A→B: FIRST frame = tela ANTERIOR (A), LAST frame = tela NOVA (B)).
 * O bloco {MOVEMENT} é preenchido por VISÃO — o Claude olha os DOIS frames e descreve
 * o melhor movimento contínuo. Fallback genérico quando não há análise. Um mundo só,
 * sem corte, sem tela preta, texto sagrado.
 */
export const MOTION_SPEC_TRANSITION = `[SHOT]
9:16 vertical motion design CONTINUITY animation. One single seamless transition from the FIRST frame (screen A) into the LAST frame (screen B) — one uninterrupted world, never a cut, never a reset, never a black frame. The solid background fills the frame the whole time and the screen is NEVER empty.

[TRANSITION — the analyzed movement, spread smoothly across the clip]
{MOVEMENT}

[CAMERA]
Very slow push-in, 3%. Locked framing, no pan, no shake.

[MOTION_QUALITY]
Ease-out, high damping, no bounce, no overshoot. Slow, deliberate, elegant. The change flows smoothly across the middle of the clip.

[HOLD]
The FIRST frame is EXACTLY screen A and the LAST frame is EXACTLY screen B — do not redesign, recolor or reposition anything in either. Briefly hold on screen A at the very start, perform the transition, then settle and hold completely still on screen B until the end. The screen stays populated the entire time — there is no empty "background only" moment.

[NEGATIVE]
no black screen, no black frame, no fade from black, no fade to black, no cut, no hard flash between screens, no empty background moment, no flicker, no jitter, no large motion, no camera shake, no ghosting, no morphing of text, no elements drifting after settling, no distortion, no text warping, no text morphing, no letters changing shape, no ghost text, no duplicated or doubled text, no gibberish, no new invented elements, no extra objects, no panels or glass containers appearing, no rotating clock hands, no melting hands, no logo distortion, no wavy lines, no jitter on straight edges, no face warping, no background scenery, no people.`;

/** Movimento genérico (fallback) para o bloco {MOVEMENT} quando não houve análise por visão. */
export const TRANSITION_MOVEMENT_FALLBACK = "Elements present in BOTH screens glide and scale smoothly from their position in screen A to their position in screen B, staying on screen the whole time. Elements only in screen A leave gently (soft fade + small downward slide/scale) exactly as the elements only in screen B are already arriving, so the screen never empties. New text arrives WORD BY WORD, each word rising ~20px from below with a fade-in and a soft blur-to-sharp; text that leaves fades and slides down. Every word lands identical to its frame, character for character. The background stays constant.";

/** Escolhe o spec conforme o provider de vídeo ativo (env VIDEO_PROVIDER). */
function activeMotionSpec(): string {
  // google (Veo) = anima a SAÍDA + inversão → MOTION_SPEC. Todos os outros
  // (replicate/fal/higgsfield = Seedance start→end frame) = ENTRADA → MOTION_SPEC_ENTRANCE.
  return (process.env.VIDEO_PROVIDER ?? "google") === "google" ? MOTION_SPEC : MOTION_SPEC_ENTRANCE;
}

/**
 * PROMPT DE MOTION: a coreografia é FIXA (MOTION_SPEC). O `pedido` do usuário é a
 * descrição dos OBJETOS/elementos da cena (o que existe na tela). Traduzimos essa
 * descrição para inglês (sem inventar movimento) e a inserimos como a lista de
 * elementos que a coreografia fixa vai animar. Se o usuário não descrever nada,
 * usamos só a especificação fixa.
 */
export async function buildMotionPrompt(
  input: { texto: string; presetNome?: string; pedido: string; duracaoAlvo: number; modo?: "entrada" | "transicao" }, signal?: AbortSignal,
): Promise<string> {
  const pedido = (input.pedido ?? "").trim();

  // Sem descrição de cena → só a especificação fixa (nada de invenção).
  let scene = pedido;
  if (pedido) {
    // Claude APENAS traduz/organiza os elementos descritos — NÃO cria animação.
    const ask = [
      `O usuário descreveu (em PT-BR) uma tela de motion design. Sua tarefa é extrair APENAS o`,
      `INVENTÁRIO ESTÁTICO dos elementos que existem na tela (o que aparece parado na imagem final),`,
      `em INGLÊS, como uma lista de substantivos com posição/cor quando ditas.`,
      `PROIBIDO incluir QUALQUER movimento, transição, sequência, tempo ou comportamento`,
      `(nada de "appears", "fades", "moves", "changes color", "silhouette then color", "one by one", etc.) —`,
      `a coreografia de entrada é fixa e definida em outro lugar. Se o usuário escrever algo sobre movimento,`,
      `IGNORE e descreva só o estado final estático daquele elemento (ex.: "figures each in a distinct color").`,
      `Descrição do usuário: "${pedido}".`,
      `\nResponda SOMENTE JSON: {"scene":"<inventário estático dos elementos, em inglês — SEM verbos de movimento>"}`,
    ].join("\n");
    try {
      const text = await runClaude(ask, signal);
      const parsed = extractJson(text) as { scene?: string };
      scene = (parsed.scene ?? "").trim() || pedido;
    } catch { scene = pedido; } // se a tradução falhar, manda o texto do usuário cru
  }

  // TRANSIÇÃO: o movimento real é gerado por VISÃO na hora de animar (analisa os 2
  // frames). Aqui só devolvemos o template com o movimento genérico de fallback.
  if (input.modo === "transicao") {
    return MOTION_SPEC_TRANSITION.replace("{MOVEMENT}", TRANSITION_MOVEMENT_FALLBACK);
  }
  const spec = activeMotionSpec();
  // spec de entrada tem o placeholder {SCENE} no bloco SHOT → injeta o inventário ali.
  if (spec.includes("{SCENE}")) {
    return spec.replace("{SCENE}", scene || "the on-screen design");
  }
  if (!scene) return spec;
  return `${spec}\n\nSCENE INVENTORY (the elements present in the final layout — each one enters/leaves via the fixed choreography above; do not change their color or form):\n${scene}`;
}
