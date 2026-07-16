import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { orderRefs, refRole, refHeaderLines, MOTION_SPEC_TRANSITION, TRANSITION_MOVEMENT_FALLBACK } from "./claude.js";
import { extractJson } from "../autocut/aiCut.js";

/**
 * Prompt de design por VISÃO usando o Claude (que ENXERGA as imagens). O modelo
 * OLHA as referências e escreve o prompt do gpt-image descrevendo a identidade REAL
 * (fundo claro/escuro, paleta, tipografia) — ancorando o gerador pra não reinterpretar.
 *
 * Provedor de visão: por padrão o CLI `claude -p` (com a ferramenta Read, lê os
 * arquivos de imagem) — usa a assinatura logada, sem depender da cota de chat da OpenAI.
 * Se ANTHROPIC_API_KEY existir, usa a API com imagens em base64.
 *
 * Prioridade das fontes: (1) instruções do usuário mandam nas CORES/conteúdo;
 * (2) "estilo" = identidade fixa; (3) "referencia" = cópia fiel; "esboco" = só layout.
 */

export interface VisionRef { tag: string; src: string; name?: string } // src = data URL

const VISION_MODEL = process.env.ANTHROPIC_VISION_MODEL ?? "claude-sonnet-5";

/** Regras (EN) de como escrever o prompt a partir das referências. */
function rules(): string {
  return [
    `Write ONE precise prompt (in ENGLISH) for the gpt-image-2 generator to produce this 9:16 screen. Rules:`,
    `0) If a PROJECT IDENTITY block is given, it has MAXIMUM PRIORITY: its colors, typography, button and icon style override EVERYTHING (references, layout, user note). Restyle any borrowed element to it.`,
    `1) The User note describes the SCENE (what appears and where) — follow its content exactly; colors/styles come from the PROJECT IDENTITY (or, if none, from the "estilo" reference).`,
    `2) The "estilo" image is the MASTER STYLE — the CENTRAL ENGINE of the design. Open your prompt by describing ITS visual world in detail (background treatment, materials, lighting, typography feel, color grading) and state that the WHOLE screen is rendered in that world, as if made by the same designer. Describe the background TYPE precisely: if it is a GRADIENT, say "gradient" and describe direction and tones (e.g. "radial gradient, soft lavender center to deeper violet edges") — NEVER describe a gradient as a solid/flat color; if it is flat, say flat.`,
    `3) SEPARATE the roles: each "referencia"/ELEMENTO image is an object to be REPLICATED FAITHFULLY in the scene — describe THAT exact object (shape, colors, details) and say it must not be redrawn or reinterpreted, only scaled and placed (change it ONLY if the User note explicitly asks). The "esboco"/layout image is the COMPOSITION BLUEPRINT (may be a rough hand-drawn sketch) — WHERE things go; handwritten labels in it (e.g. "titulo", "logo", "elemento 1") NAME what goes in that spot and are NEVER rendered as text; IGNORE its placeholder colors and rough style. The "logo" image = the exact logo, placed where the layout indicates.`,
    `4) Change ONLY the headline to the phrase. Clean, no watermark, no extra text.`,
    `5) NEVER invent content: mention a logo ONLY if a "logo" image was actually provided (if none, write "no logo anywhere"). Do not add any element, text or badge that is not in the references or the User note. Require generous safe margins: every element at least 8% away from all frame edges, nothing touching or cropped by the border.`,
    `6) The User note may cite "elemento 1", "elemento 2"… — each maps to the numbered ELEMENTO image (in order). Describe THAT specific object (e.g. a tractor) as a faithful replica of its image, placed where the note says.`,
    `Reply STRICT JSON: {"designPrompt":"<the final english prompt, no line breaks needed>"}`,
  ].join("\n");
}

function header(refs: VisionRef[]): string {
  return "You are given the following reference images, IN THIS EXACT ORDER. Use EACH one strictly by its role:\n" +
    refHeaderLines(refs).join("\n") +
    "\nWhen the scene description mentions \"elemento 1\", \"elemento 2\"… it refers to the numbered ELEMENTO images above — REPLICATE each one faithfully, placed exactly where the description says.\n\n";
}

/** Grava as refs (data URL) em arquivos temporários; devolve caminhos + limpeza. */
function writeTemp(refs: VisionRef[]): { paths: string[]; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-vis-"));
  const paths = refs.map((r, i) => {
    const m = r.src.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i);
    const ext = /jpe?g/.test(m?.[1] ?? "") ? "jpg" : /webp/.test(m?.[1] ?? "") ? "webp" : "png";
    const p = path.join(dir, `img-${i}.${ext}`);
    fs.writeFileSync(p, Buffer.from(m?.[2] ?? r.src.split(",")[1] ?? "", "base64"));
    return p;
  });
  return { paths, cleanup: () => fs.rm(dir, { recursive: true, force: true }, () => {}) };
}

/** Visão via CLI `claude -p` — lê os arquivos de imagem com a ferramenta Read. */
function claudeCliVision(prompt: string, paths: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--max-turns", String(paths.length + 4),
      "--model", VISION_MODEL, "--allowedTools", "Read"];
    const proc = spawn("claude", args, { shell: process.platform === "win32" });
    const onAbort = () => { try { proc.kill(); } catch { /* */ } reject(new Error("visão cancelada")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    let out = "", err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code !== 0) { reject(new Error(`claude visão saiu com código ${code}: ${err.slice(-200)}`)); return; }
      try { const env = JSON.parse(out); resolve(String(env.result ?? "")); }
      catch { reject(new Error("resposta da visão ilegível")); }
    });
    // O prompt cita os caminhos; o Claude usa Read pra abrir cada imagem.
    proc.stdin.write(prompt + "\n\nRead these image files first:\n" + paths.map((p, i) => `Image ${i + 1}: ${p}`).join("\n"));
    proc.stdin.end();
  });
}

/** Visão via API Anthropic (imagens em base64) — só se ANTHROPIC_API_KEY existir. */
async function anthropicApiVision(prompt: string, refs: VisionRef[], signal?: AbortSignal): Promise<string> {
  const content: unknown[] = [{ type: "text", text: prompt }];
  refs.forEach((r, i) => {
    const m = r.src.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i);
    content.push({ type: "text", text: `Image ${i + 1} — role "${r.tag}":` });
    content.push({ type: "image", source: { type: "base64", media_type: m?.[1] ?? "image/png", data: m?.[2] ?? "" } });
  });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: VISION_MODEL, max_tokens: 700, messages: [{ role: "user", content }] }),
    signal,
  });
  if (!res.ok) throw new Error(`API Anthropic (visão) ${res.status}: ${(await res.text()).slice(-200)}`);
  const data = await res.json();
  return (data.content ?? []).map((b: { text?: string }) => b.text ?? "").join("");
}

/**
 * PRIMITIVA DE VISÃO reutilizável: roda um prompt vendo os arquivos de imagem em `paths`.
 * Escolhe API Anthropic (se ANTHROPIC_API_KEY) ou o CLI `claude -p` com a ferramenta Read.
 * Devolve o texto cru da resposta. Usada pelo authorPrompt (o Claude-autor) e por analyzeStyle.
 */
export async function visionFromPaths(prompt: string, paths: string[], signal?: AbortSignal): Promise<string> {
  if (process.env.ANTHROPIC_API_KEY) {
    const refs: VisionRef[] = paths.map((p, i) => {
      const mime = /\.jpe?g$/i.test(p) ? "image/jpeg" : /\.webp$/i.test(p) ? "image/webp" : "image/png";
      return { tag: `img${i}`, src: `data:${mime};base64,${fs.readFileSync(p).toString("base64")}` };
    });
    return anthropicApiVision(prompt, refs, signal);
  }
  return claudeCliVision(prompt, paths, signal);
}

/**
 * ANÁLISE DE ESTILO: o Claude OLHA a(s) imagem(ns) de estilo da marca e devolve uma
 * descrição COMPACTA do look (EN). Roda UMA vez por identidade (cacheada no doc);
 * a imagem de estilo então NÃO vai mais pro gpt-image — só esta descrição.
 */
export async function analyzeStyle(refs: VisionRef[], signal?: AbortSignal): Promise<string> {
  const task = [
    `You are looking at brand STYLE reference image(s). Describe the DESIGN STYLE in a compact, precise way`,
    `so an image generator can build a NEW screen that looks like it came from the same designer.`,
    `Cover, in this order (short lines):`,
    `1) Background: flat or gradient? exact tones/direction (e.g. "radial gradient, deep navy #0a0f1e center to near-black edges").`,
    `2) Color palette: main colors with approx hex + the single accent color.`,
    `3) Typography: family feel, weights, how hierarchy is built.`,
    `4) Surfaces/materials: cards, glass, shadows, borders, corner radii.`,
    `5) Lighting/effects: glow, light sweeps, reflections, depth.`,
    `6) Overall finish: (e.g. "photorealistic CGI, Apple keynote grade").`,
    `Do NOT describe the CONTENT, the text, the objects or the layout of the image — ONLY the style.`,
    `Reply STRICT JSON: {"styleDesc":"<the compact style description, one paragraph of short sentences>"}`,
  ].join("\n");
  let text: string;
  if (process.env.ANTHROPIC_API_KEY) {
    text = await anthropicApiVision(task, refs, signal);
  } else {
    const { paths, cleanup } = writeTemp(refs);
    try { text = await claudeCliVision(task, paths, signal); }
    finally { cleanup(); }
  }
  const parsed = extractJson(text) as { styleDesc?: string };
  const desc = (parsed.styleDesc ?? "").trim() || text.trim();
  if (!desc) throw new Error("A visão não retornou a descrição do estilo.");
  return desc;
}

/**
 * ANÁLISE DE CONTINUIDADE (visão): o Claude OLHA o FRAME A (tela anterior) e o FRAME B
 * (tela nova) e descreve o MELHOR MOVIMENTO contínuo de A→B (o que permanece e desliza,
 * o que sai, o que entra), preenchendo o bloco {MOVEMENT} do MOTION_SPEC_TRANSITION.
 * Recebe CAMINHOS de arquivo (os frames já existem no disco na hora de animar).
 */
export async function analyzeTransitionMovement(startPath: string, endPath: string, signal?: AbortSignal): Promise<string> {
  const task = [
    `You are a senior motion designer. You are shown TWO frames of one continuous video:`,
    `FRAME A = the START screen (the previous design) and FRAME B = the END screen (the next design).`,
    `Both are finished designs on the SAME background. Describe, in ENGLISH, the SINGLE best CONTINUOUS`,
    `movement that transforms A into B as ONE uninterrupted motion (this fills a "TRANSITION" block).`,
    `RULES:`,
    `- Describe MOTION ONLY — never colors, never layout, never the text content itself.`,
    `- Elements present in BOTH A and B: they STAY on screen and glide/scale smoothly from their A`,
    `  position/size to their B position/size (a fluid move — they never disappear).`,
    `- Elements only in A: they LEAVE gently (soft fade + small downward slide/scale) — but ONLY as`,
    `  B's new elements are already arriving, so the screen NEVER empties to bare background.`,
    `- Elements only in B: they ARRIVE — text WORD BY WORD, each word rising ~20px from below with a`,
    `  fade-in and a soft blur-to-sharp; graphics scale in softly from ~0.95 to 1.0.`,
    `- TEXT IS SACRED: any text must stay IDENTICAL to its frame, character for character — never`,
    `  warped, duplicated, morphed or garbled. If the text differs between A and B, the old text leaves`,
    `  (fade + slight slide down) while the new text arrives word by word.`,
    `- Background constant. No black frame, no cut, no empty moment. Spread the motion across the clip.`,
    `Keep it 3 to 6 short sentences, movement only. Reply STRICT JSON: {"movement":"<the movement description>"}`,
  ].join("\n");

  let text: string;
  if (process.env.ANTHROPIC_API_KEY) {
    const toRef = (p: string, tag: string): VisionRef => {
      const b64 = fs.readFileSync(p).toString("base64");
      const mime = /\.jpe?g$/i.test(p) ? "image/jpeg" : /\.webp$/i.test(p) ? "image/webp" : "image/png";
      return { tag, src: `data:${mime};base64,${b64}` };
    };
    text = await anthropicApiVision(task, [toRef(startPath, "FRAME A (start)"), toRef(endPath, "FRAME B (end)")], signal);
  } else {
    text = await claudeCliVision(task, [startPath, endPath], signal);
  }
  const parsed = extractJson(text) as { movement?: string };
  return (parsed.movement ?? "").trim();
}

/**
 * PROMPT DE CONTINUIDADE COMPLETO: preenche o MOTION_SPEC_TRANSITION com o movimento
 * analisado por visão (ou o fallback, se a visão falhar). Usado na hora de animar
 * um clipe do momento contínuo (frame A = design anterior, frame B = design atual).
 */
export async function buildTransitionPrompt(startPath: string, endPath: string, signal?: AbortSignal): Promise<string> {
  let movement = "";
  try { movement = await analyzeTransitionMovement(startPath, endPath, signal); } catch { /* usa fallback */ }
  return MOTION_SPEC_TRANSITION.replace("{MOVEMENT}", movement || TRANSITION_MOVEMENT_FALLBACK);
}

export async function buildDesignPromptVision(
  input: { texto: string; userPrompt: string; aspect: string; refs: VisionRef[]; identityBlock?: string },
  signal?: AbortSignal,
): Promise<string> {
  const refs = orderRefs(input.refs); // layout primeiro, estilo, logo por último
  const task =
    (input.identityBlock ? `${input.identityBlock}\n\n` : "") +
    `${rules()}\n\nThe new screen (${input.aspect}) headline is: "${input.texto}".` +
    (input.userPrompt ? `\nUser note (the SCENE — what appears and where): "${input.userPrompt}".` : "");

  let text: string;
  if (process.env.ANTHROPIC_API_KEY) {
    text = await anthropicApiVision(task, refs, signal);
  } else {
    const { paths, cleanup } = writeTemp(refs);
    try { text = await claudeCliVision(task, paths, signal); }
    finally { cleanup(); }
  }
  const parsed = extractJson(text) as { designPrompt?: string };
  const body = (parsed.designPrompt ?? "").trim() || text.trim();
  if (!body) throw new Error("A visão não retornou um prompt.");
  return header(refs) + body;
}
