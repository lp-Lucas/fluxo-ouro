import type { Cut } from "../../../shared/timeline.js";
import { claudeText } from "../ai/anthropic.js";

/**
 * Autocut com IA (Claude). A IA DECIDE o que manter/cortar (semântico: retakes com
 * palavras diferentes, muletas, falsos começos, dedup); os TIMESTAMPS continuam os
 * do whisper (a IA nunca inventa tempo). As bordas grudam nos limites de palavra.
 *
 * Provedor: API oficial da Anthropic (SDK), autenticada pela ANTHROPIC_API_KEY do
 * backend/.env — ver src/ai/anthropic.ts. (O modo CLI `claude -p` foi aposentado:
 * dependia de sessão logada na máquina e falhava silencioso.)
 */

export interface AiWord { text: string; start: number; end: number; }
export type AiMode = "auto" | "copy" | "judgment";

const MODEL = process.env.AUTOCUT_MODEL ?? "claude-opus-4-8";

/** Um trecho a cortar, por índice de palavra (inclusive). */
interface AiCutSpan { from: number; to: number; reason?: string; }

/** Constrói o prompt (system + user) para a decisão de cortes. */
function buildPrompt(words: AiWord[], copy: string, mode: AiMode): string {
  const useCopy = mode === "copy" || (mode === "auto" && copy.trim().length > 0);
  const lista = words.map((w, i) => `#${i} "${w.text}" ${w.start.toFixed(2)}-${w.end.toFixed(2)}`).join("\n");
  const textoCorrido = words.map((w) => w.text).join(" ");

  const regra = useCopy
    ? `Há um ROTEIRO (copy) que é a VERDADE do que deve permanecer. Mantenha apenas o que corresponde ao roteiro (aceitando pequenas variações/rephrasings e erros DE TRANSCRIÇÃO — se a fala claramente tentou dizer a frase do roteiro, ela FICA). Corte tudo que estiver fora dele.`
    : `NÃO há roteiro. Use julgamento editorial: mantenha a versão mais fluente e completa de cada ideia.`;

  const copyBloco = useCopy ? `\n\nROTEIRO (copy):\n"""\n${copy.trim()}\n"""` : "";

  return [
    `Você é um EDITOR DE VÍDEO experiente decupando uma gravação de take único. Recebe a transcrição com timestamps por palavra.`,
    regra,
    `\nO QUE CORTAR (definições precisas):`,
    `- FRASE INCOMPLETA / falso começo: a pessoa começa uma frase e ABANDONA no meio (interrompe e recomeça, com as mesmas palavras ou outras). Sinal clássico: um trecho que não termina a ideia, imediatamente seguido de uma versão completa da mesma ideia. Corte o trecho abandonado INTEIRO, desde a primeira palavra dele.`,
    `- TAKE REPETIDO: a mesma frase/ideia dita duas ou mais vezes. REGRA: mantenha o ÚLTIMO take completo (quem grava refaz até acertar — o refeito é o bom), salvo se o último estiver claramente pior/incompleto. Corte os anteriores INTEIROS.`,
    `- ERRO ADMITIDO: a pessoa erra e comenta ("ai", "pera", "não", "de novo", risada, xingamento) — corte o erro E o comentário.`,
    `- MULETAS/gagueira: "é...", "tipo", "né", "então" soltos entre frases; palavras gaguejadas ("a- a- assim").`,
    `- TANGENTE: divagação que não pertence à mensagem final.`,
    `\nO QUE NUNCA CORTAR:`,
    `- Palavras da mensagem final, mesmo que a transcrição as tenha escrito errado (mishear do whisper NÃO é erro de fala).`,
    `- Palavra solta no MEIO de uma frase boa (corte em blocos contíguos: o take/trecho inteiro).`,
    `- Conectivos naturais dentro de frase fluente ("então" no meio de raciocínio bom fica).`,
    `\nMÉTODO (siga nesta ordem):`,
    `1. Leia o texto corrido inteiro e identifique cada ideia/frase da mensagem final.`,
    `2. Para cada trecho problemático, escreva UMA linha de análise: o problema, o trecho (palavras) e a decisão.`,
    `3. Converta as decisões em índices de palavra EXATOS (confira o primeiro e o último índice de cada corte na lista numerada).`,
    `\nDepois da análise, responda com o JSON (a análise vem ANTES, o JSON é a última coisa da resposta):`,
    `{"cuts":[{"from":<indice>,"to":<indice>,"reason":"retake|falsestart|filler|stutter|offscript|dedup|errocomentado"}]}`,
    `Onde from/to são índices de palavra (inclusive) a REMOVER. Se nada deve ser cortado: {"cuts":[]}.`,
    copyBloco,
    `\nTEXTO CORRIDO (para entender o fluxo):\n"""\n${textoCorrido}\n"""`,
    `\nTRANSCRIÇÃO NUMERADA (${words.length} palavras):\n${lista}`,
  ].join("\n");
}

/** Extrai o primeiro objeto JSON de um texto (tolera cercas ```json e lixo ao redor). */
export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const s = body.indexOf("{"), e = body.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("resposta da IA sem JSON");
  return JSON.parse(body.slice(s, e + 1));
}

/**
 * Chama o Claude pela API oficial e devolve o texto da resposta.
 * Gateway ÚNICO de texto do backend — autocut, retakes (decupagem), cobertura de
 * legenda e FLOW importam daqui, então modelo/limites mudam num lugar só.
 */
export function runClaude(prompt: string, signal?: AbortSignal): Promise<string> {
  return claudeText(prompt, { model: MODEL, signal });
}

export async function aiDecideCuts(words: AiWord[], copy: string, mode: AiMode, signal?: AbortSignal): Promise<AiCutSpan[]> {
  if (words.length === 0) return [];
  const prompt = buildPrompt(words, copy, mode);
  const text = await runClaude(prompt, signal);

  const parsed = extractJson(text) as { cuts?: AiCutSpan[] };
  const spans = Array.isArray(parsed.cuts) ? parsed.cuts : [];
  // valida/normaliza índices
  const validos = spans
    .map((s) => ({ from: Math.max(0, Math.min(words.length - 1, Math.round(s.from))), to: Math.max(0, Math.min(words.length - 1, Math.round(s.to))), reason: s.reason }))
    .filter((s) => Number.isFinite(s.from) && Number.isFinite(s.to) && s.to >= s.from);

  // TRAVA DE SANIDADE: se a IA mandou cortar quase o vídeo inteiro, algo deu errado
  // (alucinação/copy errada) — melhor recusar com erro claro do que destruir o vídeo.
  const marcadas = new Set<number>();
  for (const s of validos) for (let i = s.from; i <= s.to; i++) marcadas.add(i);
  if (words.length >= 20 && marcadas.size / words.length > 0.7) {
    throw new Error(`A IA marcou ${marcadas.size} de ${words.length} palavras pra corte (>70%) — decisão recusada por segurança. Confira a copy/transcrição e tente de novo.`);
  }
  return validos;
}

/**
 * Converte os spans (por índice) em cortes com BORDAS CRONOMETRADAS: do fim da
 * última palavra mantida até o início da próxima mantida — sem sliver, sem clipar
 * o take bom. Runs contíguos viram um corte só. (Mesma lógica do detectCutsFromCopy.)
 */
export function spansToCuts(words: AiWord[], spans: AiCutSpan[]): Cut[] {
  const cut = new Array<boolean>(words.length).fill(false);
  for (const s of spans) for (let i = s.from; i <= s.to; i++) cut[i] = true;

  const cuts: Cut[] = [];
  let n = 0, i = 0;
  while (i < words.length) {
    if (!cut[i]) { i++; continue; }
    let j = i;
    while (j < words.length && cut[j]) j++;
    const prevEnd = i > 0 ? words[i - 1].end : undefined;
    const nextStart = j < words.length ? words[j].start : undefined;
    const start = prevEnd ?? words[i].start;
    const end = nextStart ?? words[j - 1].end;
    if (end > start + 0.001) {
      cuts.push({ id: `cut-ai-${n++}`, start: +start.toFixed(3), end: +end.toFixed(3), reason: "error", enabled: true });
    }
    i = j;
  }
  return cuts;
}
