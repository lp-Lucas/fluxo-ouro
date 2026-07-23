import fs from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { editImageOpenRouter } from "./openrouter.js";

const execFileP = promisify(execFile);

/** Mata a árvore de processos (Windows: taskkill /T; Unix: SIGKILL). */
export function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
    else process.kill(pid, "SIGKILL");
  } catch { /* já morreu */ }
}

/** Roda o ffmpeg com cancelamento; rejeita com o stderr final se falhar. */
export function runFfmpeg(args: string[], signal: AbortSignal | undefined, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    const onAbort = () => { killTree(proc.pid); reject(new Error(`${label} cancelado (timeout)`)); };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    let err = "";
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      code === 0 ? resolve() : reject(new Error(`ffmpeg (${label}) saiu com código ${code}: ${err.slice(-500)}`));
    });
  });
}

/** Duração (s) de um mídia via ffprobe. */
export async function probeDuration(path: string): Promise<number> {
  const { stdout } = await execFileP("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path,
  ]);
  const d = parseFloat(stdout.trim());
  return Number.isFinite(d) ? d : 0;
}

/**
 * Cria o START FRAME de uma entrada: uma imagem lisa na COR DE FUNDO do design.
 * Amostra a cor do topo do design (5% superior, onde raramente há elemento) reduzindo
 * a 1×1 px, e gera uma imagem sólida WxH nessa cor. É o "estado vazio" do qual a
 * animação de entrada parte (método start→end frame). Devolve o hex amostrado.
 */
export async function makeStartFrame(
  designPath: string, outPath: string, w: number, h: number, signal?: AbortSignal,
): Promise<string> {
  // 1) amostra a cor: recorta a faixa do topo, reduz a 1×1, cospe 3 bytes RGB.
  const { stdout } = await execFileP("ffmpeg", [
    "-v", "error", "-i", designPath,
    "-vf", "crop=iw:ih*0.05:0:0,scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { encoding: "buffer", maxBuffer: 1024 });
  const buf = stdout as unknown as Buffer;
  const hex = [buf[0] ?? 0, buf[1] ?? 0, buf[2] ?? 0].map((n) => n.toString(16).padStart(2, "0")).join("");
  // 2) gera a imagem sólida nessa cor.
  await runFfmpeg([
    "-y", "-f", "lavfi", "-i", `color=c=0x${hex}:s=${w}x${h}`, "-frames:v", "1", outPath,
  ], signal, "flow-startframe");
  return hex;
}

/**
 * ANIMAÇÃO DE ENTRADA LOCAL (ffmpeg) — texto PERFEITO, sem IA. Anima o PNG real do
 * design (sobe suave + fade-in) sobre o fundo sólido, ao longo da duração alvo. Como é
 * o próprio design sendo transformado (nunca regenerado), o texto nunca embaralha nem
 * duplica — resolve de vez o gibberish/formas que o modelo de vídeo inventava.
 */
export async function renderEntranceClip(
  designPath: string, outPath: string, w: number, h: number, durationSec: number, signal?: AbortSignal,
): Promise<void> {
  // cor de fundo do design (topo) para a base sólida.
  const { stdout } = await execFileP("ffmpeg", [
    "-v", "error", "-i", designPath,
    "-vf", "crop=iw:ih*0.05:0:0,scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { encoding: "buffer", maxBuffer: 1024 });
  const buf = stdout as unknown as Buffer;
  const hex = [buf[0] ?? 0, buf[1] ?? 0, buf[2] ?? 0].map((n) => n.toString(16).padStart(2, "0")).join("");

  const D = Math.max(0.6, durationSec);
  const dy = Math.round(h * 0.06);                       // distância do "sobe pra entrar"
  const inDur = Math.min(D, Math.max(0.8, D * 0.7));     // revela ao longo da maior parte do clipe
  // sobe com ease-out cúbico (rápido→lento) e para na posição exata; aspas simples
  // protegem as vírgulas da expressão no parser do ffmpeg.
  const yExpr = `'if(lt(t,${inDur.toFixed(3)}),${dy}*pow(1-t/${inDur.toFixed(3)},3),0)'`;

  await runFfmpeg([
    "-y",
    "-f", "lavfi", "-i", `color=c=0x${hex}:s=${w}x${h}:r=30:d=${D.toFixed(3)}`,
    "-loop", "1", "-i", designPath,
    "-filter_complex",
    `[1:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x${hex},` +
    `format=rgba,fade=t=in:st=0:d=${inDur.toFixed(3)}:alpha=1,setpts=PTS-STARTPTS[fg];` +
    `[0:v][fg]overlay=x=0:y=${yExpr}:shortest=1,format=yuv420p[v]`,
    "-map", "[v]", "-t", D.toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-movflags", "+faststart", outPath,
  ], signal, "flow-entrance-local");
}

/**
 * START FRAME de ENTRADA que PRESERVA O TEXTO: em vez do fundo vazio (que obrigava o
 * Seedance a INVENTAR o texto do zero → gibberish), gera o "estado pré-entrada" a
 * partir do PRÓPRIO design — o texto/elementos reais, só deslocados pra baixo, um
 * pouco menores, desfocados e bem transparentes (parecendo quase só o fundo). Assim o
 * modelo só precisa DESLIZAR e FOCAR o conteúdo que já existe, nunca criá-lo.
 */
export async function makeEntranceStartFrame(
  designPath: string, outPath: string, w: number, h: number, signal?: AbortSignal,
): Promise<string> {
  // amostra a cor de fundo (mesma lógica) para a base sólida.
  const { stdout } = await execFileP("ffmpeg", [
    "-v", "error", "-i", designPath,
    "-vf", "crop=iw:ih*0.05:0:0,scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { encoding: "buffer", maxBuffer: 1024 });
  const buf = stdout as unknown as Buffer;
  const hex = [buf[0] ?? 0, buf[1] ?? 0, buf[2] ?? 0].map((n) => n.toString(16).padStart(2, "0")).join("");
  // ALINHADO ao design (SEM deslocamento e SEM escala): offset/scale criavam uma cópia
  // "fantasma" que o modelo solidificava em painéis/formas de vidro atrás do conteúdo.
  // A diferença start→end é SÓ foco (desfoque→nítido) + opacidade (fraco→cheio). O modelo
  // não tem duplicata espacial pra "completar" — só revela o que já está exatamente ali.
  await runFfmpeg([
    "-y",
    "-f", "lavfi", "-i", `color=c=0x${hex}:s=${w}x${h}`,
    "-i", designPath,
    "-filter_complex",
    `[1:v]scale=${w}:${h},gblur=sigma=6,format=rgba,colorchannelmixer=aa=0.4[fg];` +
    `[0:v][fg]overlay=0:0`,
    "-frames:v", "1", outPath,
  ], signal, "flow-entrance-start");
  return hex;
}

/** Dimensões (px) de uma imagem via ffprobe. */
export async function probeImageDims(p: string): Promise<{ w: number; h: number }> {
  const { stdout } = await execFileP("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", p,
  ]);
  const [w, h] = stdout.trim().split(",").map(Number);
  return { w: w || 0, h: h || 0 };
}

/**
 * Encaixe na proporção do vídeo (saveImageFit) — a imagem final deve parecer NATIVA no
 * alvo (9:16/16:9), com o fundo CONTÍNUO até as bordas. NUNCA corta conteúdo, NUNCA borra.
 * Caminho primário: INPAINT MASCARADO (outpaintBordas) — a IA repinta SÓ as faixas de
 * borda com o contexto da imagem inteira. Fallback (sem IA): contain + linha esticada.
 */
/** Quem repinta regiões por IA via /images/edits (o OpenAI implementa; ver ImageProvider). */
export interface Outpainter {
  outpaint(imagePath: string, prompt: string, size: string, signal?: AbortSignal, opts?: { maskPath?: string; model?: string }): Promise<string>;
}

/**
 * Prompt do repaint mascarado. `colorNote` = âncora de COR com o hex real da junção,
 * amostrado da imagem: sem ela o modelo alucinava o tom da faixa (navy → marrom
 * texturizado, testado); com o hex no prompt a cor ficou cravada. Proibição explícita
 * de textura/ruído/vinheta — "grain/texture" no prompt antigo convidava ferrugem.
 */
const borderPrompt = (edges: string, colorNote: string) =>
  `Repaint ONLY the masked strips at the ${edges} edges as a seamless continuation of this design's background. ` +
  colorNote +
  ` Fill each strip with exactly that background, continuing the same flat or gradient tones smoothly to the frame edge, matching the adjacent pixels perfectly so no seam is visible. ` +
  `STRICTLY plain background only: no texture, no noise, no grain, no vignette, no glow, no light effects, no pattern, no text, no letters, no numbers, no logos, no icons, no badges, no cards, no objects, no shapes, no lines, no new elements of any kind. ` +
  `Do NOT repeat, mirror, extend or complete any element of the design into the strips. Keep everything outside the masked strips exactly unchanged.`;

/** Cor média (hex) de um recorte da imagem — âncora de cor pro prompt do inpaint. */
async function avgRgb(p: string, crop: string): Promise<[number, number, number]> {
  const { stdout } = await execFileP("ffmpeg", [
    "-v", "error", "-i", p, "-vf", `crop=${crop},scale=1:1,format=rgb24`,
    "-frames:v", "1", "-f", "rawvideo", "-",
  ], { encoding: "buffer", maxBuffer: 1024 } as never);
  const b = stdout as unknown as Buffer;
  return [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0];
}
async function avgHex(p: string, crop: string): Promise<string> {
  return (await avgRgb(p, crop)).map((n) => n.toString(16).padStart(2, "0")).join("");
}
/** lutrgb que soma um delta por canal (clip 0..255) — casa a média da faixa com a borda. */
const lutShift = ([dr, dg, db]: [number, number, number]) =>
  `lutrgb=r='clip(val+${dr}\\,0\\,255)':g='clip(val+${dg}\\,0\\,255)':b='clip(val+${db}\\,0\\,255)'`;

// EMENDA: o original é cravado de volta por cima (fidelidade total do centro); um feather
// CURTO só dissolve microdesvios de cor na junção. Curto de propósito: com conteúdo colado
// na borda da imagem, feather largo criaria fantasma do conteúdo — 24px é imperceptível.
const SEAM_FEATHER_PX = 24;
// A máscara recua alguns px PARA DENTRO da imagem (a IA pode repintar essa fita e ancorar a
// transição); o composite final cobre esses px com o original de qualquer forma.
const MASK_INSET_PX = 8;

/**
 * BORDAS POR INPAINT MASCARADO — a imagem final parece nativa na proporção alvo.
 * O gpt-image só devolve tamanhos fixos (1024×1536 / 1536×1024 / 1024×1024), então:
 *  1) monta um canvas COMPLETO no tamanho do gpt-image: a imagem no centro do frame da
 *     proporção alvo e as faixas restantes PRÉ-PREENCHIDAS esticando a linha da borda.
 *     Nada de transparência: canvas transparente convidava o modelo a "continuar o
 *     desenho" — era a causa do conteúdo DUPLICADO nas bandas;
 *  2) manda ao /images/edits com MÁSCARA explícita (transparente = repintar): o centro
 *     fica travado, só as faixas são repintadas — o modelo vê a imagem INTEIRA (contexto
 *     → continuidade) e o pré-preenchimento ancora as cores da junção;
 *  3) recorta o frame da proporção alvo, escala p/ WxH e CRAVA o original no centro
 *     (feather curto só pra dissolver microdesvio de cor).
 * Cobre retrato E paisagem (a geometria decide onde ficam as faixas).
 */
export async function outpaintBordas(
  srcInput: string, outPath: string, w: number, h: number,
  src: { w: number; h: number }, painter: Outpainter, model: string, signal?: AbortSignal,
): Promise<void> {
  const dstRatio = w / h, srcRatio = src.w / src.h;
  // canvas do gpt-image com a orientação do alvo
  const [CW, CH] = dstRatio < 1 ? [1024, 1536] : dstRatio > 1 ? [1536, 1024] : [1024, 1024];
  // frame = maior retângulo na proporção ALVO dentro do canvas
  let frameW = CW, frameH = 2 * Math.round(CW / dstRatio / 2);
  if (frameH > CH) { frameH = CH; frameW = 2 * Math.round((CH * dstRatio) / 2); }
  const fx = Math.floor((CW - frameW) / 2), fy = Math.floor((CH - frameH) / 2);
  // imagem CONTIDA no frame (sem corte): encosta na largura OU na altura dele
  let imgW: number, imgH: number;
  if (srcRatio > frameW / frameH) { imgW = frameW; imgH = 2 * Math.round(frameW / srcRatio / 2); }
  else { imgH = frameH; imgW = 2 * Math.round((frameH * srcRatio) / 2); }
  const ix = Math.floor((CW - imgW) / 2), iy = Math.floor((CH - imgH) / 2);
  const padT = iy, padB = CH - imgH - iy, padL = ix, padR = CW - imgW - ix;

  const canvas = outPath + ".oc.png", mask = outPath + ".om.png", filled = outPath + ".of.png";
  try {
    // 1) canvas pré-preenchido: imagem no centro + faixas = linha da borda esticada (neighbor)
    const chain: string[] = [`[0:v]scale=${imgW}:${imgH}[im]`];
    let cur = "[im]";
    if (CH > imgH) {
      chain.push(
        `${cur}split=3[va][vb][vc]`,
        `[va]crop=${imgW}:1:0:0,scale=${imgW}:${padT}:flags=neighbor[vt]`,
        `[vc]crop=${imgW}:1:0:${imgH - 1},scale=${imgW}:${padB}:flags=neighbor[vbo]`,
        `[vt][vb][vbo]vstack=inputs=3[vv]`,
      );
      cur = "[vv]";
    }
    if (CW > imgW) {
      chain.push(
        `${cur}split=3[ha][hb][hc]`,
        `[ha]crop=1:${CH}:0:0,scale=${padL}:${CH}:flags=neighbor[hl]`,
        `[hc]crop=1:${CH}:${imgW - 1}:0,scale=${padR}:${CH}:flags=neighbor[hr]`,
        `[hl][hb][hr]hstack=inputs=3[hh]`,
      );
      cur = "[hh]";
    }
    await runFfmpeg([
      "-y", "-i", srcInput, "-filter_complex", chain.join(";"), "-map", cur,
      "-frames:v", "1", canvas,
    ], signal, "outpaint-canvas");

    // 2) máscara: transparente = REPINTAR (faixas), opaco = manter (imagem, com leve recuo)
    await runFfmpeg([
      "-y", "-f", "lavfi", "-i", `color=c=black@0.0:s=${CW}x${CH},format=rgba`,
      "-vf", `drawbox=x=${ix + MASK_INSET_PX}:y=${iy + MASK_INSET_PX}:w=${imgW - 2 * MASK_INSET_PX}:h=${imgH - 2 * MASK_INSET_PX}:color=white@1:t=fill`,
      "-frames:v", "1", mask,
    ], signal, "outpaint-mask");

    // 3) a IA repinta só as faixas (vendo a imagem inteira), com âncora de cor amostrada
    const edges = [CH > imgH ? "top and bottom" : "", CW > imgW ? "left and right" : ""].filter(Boolean).join(" and ");
    const notes: string[] = [];
    if (CH > imgH) {
      const [t, b] = await Promise.all([avgHex(srcInput, `${src.w}:6:0:0`), avgHex(srcInput, `${src.w}:6:0:${src.h - 6}`)]);
      notes.push(`At the top junction the background color is approximately #${t}; at the bottom junction it is approximately #${b}.`);
    }
    if (CW > imgW) {
      const [l, r] = await Promise.all([avgHex(srcInput, `6:${src.h}:0:0`), avgHex(srcInput, `6:${src.h}:${src.w - 6}:0`)]);
      notes.push(`At the left junction the background color is approximately #${l}; at the right junction it is approximately #${r}.`);
    }
    const url = await painter.outpaint(canvas, borderPrompt(edges || "outer", notes.join(" ")), `${CW}x${CH}`, signal, { maskPath: mask, model });
    fs.writeFileSync(filled, Buffer.from(url.split(",")[1] ?? "", "base64"));

    // 4) recorta o frame → escala WxH → CORRIGE O TOM das faixas → CRAVA o original.
    //    CORREÇÃO DE JUNÇÃO (determinística): o modelo acerta "quase" a cor da faixa —
    //    e em fundo escuro/chapado um degrau de 4–8 níveis vira banda visível. Medimos a
    //    média da faixa junto à junção vs a borda do original e somamos o delta por canal
    //    (lutrgb) — as médias batem EXATAS; o feather dissolve o resíduo/grão.
    const widthFit = imgW === frameW; // encostou na largura → bandas em cima/baixo
    const scaleOrig = widthFit ? `${w}:-2` : `-2:${h}`;
    const pos = widthFit ? `0:(H-h)/2` : `(W-w)/2:0`;
    const alpha = widthFit
      ? `clip(min(Y\\,H-1-Y)/${SEAM_FEATHER_PX}\\,0\\,1)*255`
      : `clip(min(X\\,W-1-X)/${SEAM_FEATHER_PX}\\,0\\,1)*255`;
    const d = (a: [number, number, number], b: [number, number, number]): [number, number, number] =>
      [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const rgbCopy = `r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)'`;
    let baseChain: string, bridgeChain: string, bridgeOverlays: string;
    if (widthFit) {
      // alturas das faixas no ESPAÇO FINAL (WxH)
      const topH = Math.round((iy - fy) * (h / frameH));
      const botH = h - Math.round(((iy - fy) + imgH) * (h / frameH));
      // lut: média da FAIXA INTEIRA vs borda do original (o modelo deriva dentro da faixa)
      const [srcT, srcB, stripT, stripB] = await Promise.all([
        avgRgb(srcInput, `${src.w}:6:0:0`), avgRgb(srcInput, `${src.w}:6:0:${src.h - 6}`),
        avgRgb(filled, `${frameW}:${iy}:${fx}:0`), avgRgb(filled, `${frameW}:${CH - iy - imgH}:${fx}:${iy + imgH}`),
      ]);
      baseChain =
        `[0:v]crop=${frameW}:${frameH}:${fx}:${fy},scale=${w}:${h},split=3[b1][b2][b3];` +
        `[b1]crop=${w}:${topH}:0:0,${lutShift(d(srcT, stripT))}[bt];` +
        `[b2]crop=${w}:${h - topH - botH}:0:${topH}[bm];` +
        `[b3]crop=${w}:${botH}:0:${h - botH},${lutShift(d(srcB, stripB))}[bb];` +
        `[bt][bm][bb]vstack=inputs=3[base]`;
      // PONTE: linha da borda esticada sobre a faixa, opaca na junção → transparente na
      // borda externa. Continuidade EXATA na junção por construção; a IA entra gradualmente.
      // a linha é REDUZIDA antes de esticar (média local) — senão o ruído da linha viraria
      // riscos verticais; reduzida, vira um gradiente limpo que ainda segue o fundo.
      const smw = Math.max(2, Math.round(w / 16));
      bridgeChain =
        `[1:v]split=3[o0][oT][oB];` +
        // piso de 45%: a ponte nunca some — desvios de MATIZ locais da IA (ex.: glow
        // alaranjado num canto) ficam atenuados >2x; o gradiente da IA segue visível.
        `[oT]crop=${src.w}:1:0:0,scale=${smw}:1,scale=${w}:${topH},format=rgba,geq=${rgbCopy}:a='255*clip(0.45+0.55*Y/${Math.max(1, topH - 1)}\\,0\\,1)'[pT];` +
        `[oB]crop=${src.w}:1:0:${src.h - 1},scale=${smw}:1,scale=${w}:${botH},format=rgba,geq=${rgbCopy}:a='255*clip(0.45+0.55*(1-Y/${Math.max(1, botH - 1)})\\,0\\,1)'[pB]`;
      bridgeOverlays = `[base][pT]overlay=0:0[p1];[p1][pB]overlay=0:${h - botH}[p2]`;
    } else {
      const leftW = Math.round((ix - fx) * (w / frameW));
      const rightW = w - Math.round(((ix - fx) + imgW) * (w / frameW));
      const [srcL, srcR, stripL, stripR] = await Promise.all([
        avgRgb(srcInput, `6:${src.h}:0:0`), avgRgb(srcInput, `6:${src.h}:${src.w - 6}:0`),
        avgRgb(filled, `${ix - fx}:${frameH}:${fx}:${fy}`), avgRgb(filled, `${CW - ix - imgW}:${frameH}:${ix + imgW}:${fy}`),
      ]);
      baseChain =
        `[0:v]crop=${frameW}:${frameH}:${fx}:${fy},scale=${w}:${h},split=3[b1][b2][b3];` +
        `[b1]crop=${leftW}:${h}:0:0,${lutShift(d(srcL, stripL))}[bl];` +
        `[b2]crop=${w - leftW - rightW}:${h}:${leftW}:0[bm];` +
        `[b3]crop=${rightW}:${h}:${w - rightW}:0,${lutShift(d(srcR, stripR))}[br];` +
        `[bl][bm][br]hstack=inputs=3[base]`;
      const smh = Math.max(2, Math.round(h / 16));
      bridgeChain =
        `[1:v]split=3[o0][oL][oR];` +
        `[oL]crop=1:${src.h}:0:0,scale=1:${smh},scale=${leftW}:${h},format=rgba,geq=${rgbCopy}:a='255*clip(0.45+0.55*X/${Math.max(1, leftW - 1)}\\,0\\,1)'[pL];` +
        `[oR]crop=1:${src.h}:${src.w - 1}:0,scale=1:${smh},scale=${rightW}:${h},format=rgba,geq=${rgbCopy}:a='255*clip(0.45+0.55*(1-X/${Math.max(1, rightW - 1)})\\,0\\,1)'[pR]`;
      bridgeOverlays = `[base][pL]overlay=0:0[p1];[p1][pR]overlay=${w - rightW}:0[p2]`;
    }
    await runFfmpeg([
      "-y", "-i", filled, "-i", srcInput, "-filter_complex",
      `${baseChain};${bridgeChain};${bridgeOverlays};` +
      `[o0]scale=${scaleOrig},format=rgba,geq=${rgbCopy}:a='${alpha}'[orig];` +
      `[p2][orig]overlay=${pos}`,
      "-frames:v", "1", outPath,
    ], signal, "outpaint-compose");
  } finally {
    fs.rm(canvas, () => {}); fs.rm(mask, () => {}); fs.rm(filled, () => {});
  }
}

// memo de sessão: 1º modelo de edits que funcionou (evita repetir um 400 por imagem)
let outpaintModelOk: string | null = null;

/**
 * FIT margens VERTICAIS (fonte mais larga que o alvo, ex.: 2:3 -> 9:16) — CONTINUAÇÃO real.
 *
 * As faixas de cima/baixo são o ESPELHO (vflip) da faixa adjacente do próprio design: a linha
 * do espelho que encosta no design é idêntica à borda (emenda invisível) e o gradiente/glow do
 * fundo CONTINUA pra fora (reflete). Preserva a variação horizontal (o glow diagonal) — por
 * isso não vira uma "banda separada" como a média horizontal fazia. O centro é o design EXATO
 * (d0). Determinístico, sem IA, sem custo. Como o topo/base dessas peças é só fundo, o espelho
 * não duplica conteúdo.
 *
 * OPCIONAL (OPENROUTER_MARGINS_AI=true + OPENROUTER_API_KEY): a IA (nano-banana) refina as
 * margens a partir dessa base e crava o centro de volta — só pra quem quer fundo gerado.
 */
async function fitVerticalMargins(input: string, outPath: string, w: number, h: number, src: { w: number; h: number }, signal?: AbortSignal): Promise<void> {
  const imgH = Math.round((src.h * w) / src.w); // altura do design contido na largura w
  const diff = h - imgH;
  if (diff < 8) { // margem irrelevante — só escala
    await runFfmpeg(["-y", "-i", input, "-vf", `scale=${w}:${h}`, "-frames:v", "1", outPath], signal, "flow-imagem");
    return;
  }
  const padTop = Math.floor(diff / 2), padBot = diff - padTop;
  if (padTop > imgH || padBot > imgH) throw new Error("margem maior que a imagem — usa o fallback"); // espelho não cobre
  const useAI = process.env.OPENROUTER_MARGINS_AI === "true" && !!(process.env.OPENROUTER_API_KEY ?? "").trim();
  const base = useAI ? outPath + ".base.png" : outPath;

  // BASE = design exato (d0) + margens = ESPELHO da faixa adjacente (preserva o glow diagonal
  // e casa exato na emenda). Uma passada de ffmpeg.
  await runFfmpeg([
    "-y", "-i", input, "-filter_complex",
    `[0:v]scale=${w}:${imgH},split=3[d0][d1][d2];` +
    `[d1]crop=${w}:${padTop}:0:0,vflip[t];` +
    `[d2]crop=${w}:${padBot}:0:${imgH - padBot},vflip[b];` +
    `[t][d0][b]vstack=inputs=3[o]`,
    "-map", "[o]", "-frames:v", "1", base,
  ], signal, "flow-vmargin");
  if (!useAI) return;

  // OPCIONAL: IA refina as margens; CRAVA o design no centro de volta (protege o miolo). Se
  // falhar, mantém a base lisa (que já é o resultado desejado).
  const aiTmp = outPath + ".ai.png";
  try {
    const prompt =
      "Only repaint the top and bottom margin bands so the background continues perfectly SMOOTHLY " +
      "to the edges: a flat, seamless continuation of the existing color/gradient — NO shadows, NO " +
      "vignette, NO glow, NO texture, NO objects, NO text, nothing new. Keep the central artwork " +
      "EXACTLY as-is. Return the full frame at the same resolution.";
    fs.writeFileSync(aiTmp, await editImageOpenRouter(base, prompt, signal));
    const F = 20;
    await runFfmpeg([
      "-y", "-i", aiTmp, "-i", input, "-filter_complex",
      `[0:v]scale=${w}:${h}[bg];` +
      `[1:v]scale=${w}:${imgH},format=rgba,` +
      `geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='255*clip(min(Y\\,${imgH - 1}-Y)/${F}\\,0\\,1)'[fg];` +
      `[bg][fg]overlay=0:${padTop}[o]`,
      "-map", "[o]", "-frames:v", "1", outPath,
    ], signal, "flow-vmargin-ai");
  } catch (e) {
    console.error("[FLOW] margens IA falhou, mantendo extensão lisa:", (e as Error).message);
    fs.copyFileSync(base, outPath);
  } finally {
    fs.rm(aiTmp, () => {}); fs.rm(base, () => {});
  }
}

export async function saveImageFit(dataUrlOrPath: string, outPath: string, w: number, h: number, signal?: AbortSignal, painter?: { outpaint?: Outpainter["outpaint"] }): Promise<void> {
  let input = dataUrlOrPath;
  let tmp: string | null = null;
  if (dataUrlOrPath.startsWith("data:")) {
    const b64 = dataUrlOrPath.split(",")[1] ?? "";
    tmp = outPath + ".src";
    fs.writeFileSync(tmp, Buffer.from(b64, "base64"));
    input = tmp;
  }
  try {
    const src = await probeImageDims(input);
    const srcRatio = src.w / src.h, dstRatio = w / h;

    if (Math.abs(srcRatio - dstRatio) < 0.01) {
      await runFfmpeg(["-y", "-i", input, "-vf", `scale=${w}:${h}`, "-frames:v", "1", outPath], signal, "flow-imagem");
      return;
    }

    // MARGENS VERTICAIS (fonte mais larga que o alvo, 2:3 -> 9:16): extensão LISA das faixas
    // de cima/baixo (determinística, centro exato). É o caminho padrão do 9:16 — sem sombra,
    // sem streak. Se falhar por algum motivo, cai no outpaint mascarado/fallback abaixo.
    if (srcRatio > dstRatio) {
      try {
        await fitVerticalMargins(input, outPath, w, h, src, signal);
        console.log(`[FLOW] fit: margens verticais lisas${process.env.OPENROUTER_MARGINS_AI === "true" ? " + IA" : ""} (centro intacto)`);
        return;
      } catch (e) {
        console.error("[FLOW] fit margens verticais falhou, seguindo p/ fallback:", (e as Error).message);
      }
    }

    // PRIMÁRIO — INPAINT MASCARADO (outpaintBordas): a IA repinta SÓ as faixas de borda,
    // vendo a imagem inteira. gpt-image-2 primeiro (mesma família do design; segue melhor);
    // se recusar máscara/params, gpt-image-1. Memo de sessão evita repetir um 400 por imagem.
    if (painter?.outpaint) {
      // BIND explícito: extrair o método (`painter.outpaint`) perdia o `this` do provider
      // → `this.apiKey` sumia → "OPENAI_API_KEY ausente" → caía no fallback. Bug real.
      const op: Outpainter = { outpaint: (img, pr, sz, sg, o) => painter.outpaint!.call(painter, img, pr, sz, sg, o) };
      const prefer = process.env.FLOW_OUTPAINT_MODEL ?? "gpt-image-2";
      const models = [...new Set([outpaintModelOk ?? prefer, prefer, "gpt-image-1"])];
      for (const model of models) {
        try {
          await outpaintBordas(input, outPath, w, h, src, op, model, signal);
          outpaintModelOk = model;
          console.log(`[FLOW] fit: bordas por inpaint mascarado (${model}) — centro intacto`);
          return;
        } catch (e) {
          console.error(`[FLOW] inpaint de borda (${model}) falhou:`, (e as Error).message);
        }
      }
    }

    // FALLBACK (sem provider ou a IA falhou): CONTAIN + linha da borda esticada.
    // NUNCA corta conteúdo, NUNCA borra (crop e blur liam como "imagem adaptada" — banidos).
    if (srcRatio > dstRatio) {
      // fonte mais LARGA (gpt-image 2:3 → 9:16): preencher cima/baixo
      const sh = 2 * Math.round((src.h * w) / src.w / 2);
      const padT = Math.floor((h - sh) / 2), padB = h - sh - padT;
      await runFfmpeg([
        "-y", "-i", input, "-filter_complex",
        padT >= 2
          ? `[0:v]scale=${w}:${sh},split=3[a][b][c];` +
            `[a]crop=${w}:1:0:0,scale=${w}:${padT}:flags=neighbor[top];` +
            `[c]crop=${w}:1:0:${sh - 1},scale=${w}:${padB}:flags=neighbor[bot];` +
            `[top][b][bot]vstack=inputs=3`
          : `[0:v]scale=${w}:${h}`,
        "-frames:v", "1", outPath,
      ], signal, "flow-imagem");
      console.log("[FLOW] fit (fallback sem IA): contain + fundo esticado");
      return;
    }
    // fonte mais ALTA que o alvo (ex.: 3:2 → 16:9): preencher esquerda/direita
    const sw = 2 * Math.round((src.w * h) / src.h / 2);
    const padL = Math.floor((w - sw) / 2), padR = w - sw - padL;
    await runFfmpeg([
      "-y", "-i", input, "-filter_complex",
      padL >= 2
        ? `[0:v]scale=${sw}:${h},split=3[a][b][c];` +
          `[a]crop=1:${h}:0:0,scale=${padL}:${h}:flags=neighbor[esq];` +
          `[c]crop=1:${h}:${sw - 1}:0,scale=${padR}:${h}:flags=neighbor[dir];` +
          `[esq][b][dir]hstack=inputs=3`
        : `[0:v]scale=${w}:${h}`,
      "-frames:v", "1", outPath,
    ], signal, "flow-imagem");
    console.log("[FLOW] fit (fallback sem IA): contain + fundo esticado (laterais)");
  } finally {
    if (tmp) fs.rm(tmp, () => {});
  }
}
