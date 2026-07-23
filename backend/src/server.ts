import "./env.js"; // carrega backend/.env ANTES de qualquer módulo ler process.env
import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { runTranscription } from "./transcribe/transcribe.js";
import { fixCaptionTiming } from "./transcribe/fixTiming.js";
import { renderVideo, capDimensions } from "./render/render.js";
import { getMattingProvider } from "./matting/RVMProvider.js";
import { colorPrePass } from "./color/colorPrePass.js";
import { chromaPrePass, chromaPersonPass, chromaBackgroundPass } from "./chroma/chromaPrePass.js";
import { isColorNeutral } from "../../shared/color.js";
import { isChromaActive } from "../../shared/chroma.js";
import { aiDecideCuts, spansToCuts, type AiWord, type AiMode } from "./autocut/aiCut.js";
import { fillCaptionGaps } from "./autocut/captionCoverage.js";
import { getImageProvider } from "./providers/index.js";
import { getVideoProvider } from "./flow/videoProvider.js";
import { detectFlowMoments, buildMotionPrompt, buildDesignPromptDirect, orderRefs } from "./flow/claude.js";
import { authorDesignPrompt } from "./flow/authorPrompt.js";
import { compileImagePrompt } from "./flow/promptCompiler.js";
import { analyzeStyle, buildTransitionPrompt } from "./flow/visionPrompt.js";
import { timeFit } from "./flow/timeFit.js";
import { saveImageFit, makeStartFrame, renderEntranceClip, runFfmpeg, probeDuration, probeImageDims } from "./flow/ffmpeg.js";
import { getFlowPreset, aspectDims, identityToPrompt, colorLaw, type FlowAspect, type FlowIdentity } from "../../shared/flow.js";
import { mixBackgroundMusic } from "./music/mixMusic.js";
import { flattenAssembly } from "./assembly/flatten.js";
import {
  listMetas, readProject, createProject, saveProject, renameProject, deleteProject,
  PROJECTS_ROOT, assetFsPath, ProjectConflictError,
} from "./projects/store.js";
// Integracao com o OS (docs no monorepo: AGENTE-VIDEO-SERVICE.md).
import { osRouter } from "./os-integration/routes.js";
import { comVaga } from "./os-integration/queue.js";
import { registraExecutores } from "./os-integration/executors.js";
import { exigeStudioSession } from "./os-integration/auth.js";
import { ProjectError } from "../../shared/project.js";
import { buildCutPlan, outputToSource, segIndexOfOutput, type CutPlan } from "../../shared/cutplan.js";
import type { Cut, Word, Caption, TranscriptSegment } from "../../shared/timeline.js";
import { realignCaptionsToWords, buildRealignWindows } from "../../shared/captions.js";
import { renderDecupadoAudio } from "./decupagem/audio/render.js";
import { loadMono16k } from "./decupagem/signal/audio.js";
import { computeSpeechProbs, probsToSegments, runVad } from "./decupagem/signal/vad.js";
import { anchorWords } from "./decupagem/anchor.js";
import { buildEnergyTrack } from "./decupagem/signal/energy.js";
import { runDecupagem, planWithAi, buildRestrictTo, keeperEdges } from "./decupagem/index.js";
import { aiRetakeCuts } from "./decupagem/semantic/aiRetake.js";
import { loadDicionario } from "./decupagem/semantic/misheardGuard.js";
import { zonasCabeca, zonasBloco, coalesceMicroBlocks } from "./decupagem/semantic/retakeZones.js";
import { disfluenciaLayer } from "./decupagem/plan/disfluenciaLayer.js";
import { transcribeHeads, transcribeRegionsWords } from "./transcribe/heads.js";
import { detectaRepeticaoFina } from "./decupagem/semantic/repeticaoFina.js";
import type { CutInterval } from "./decupagem/semantic/types.js";

/**
 * Backend do Fluxo Ouro — só o trabalho que não cabe no navegador:
 * transcrição (whisper), render final (Remotion), e chamadas às APIs
 * (Seedance, Gemini) com as chaves protegidas.
 */
const app = express();

// SUBPATH DO OS: o front buildado (frontend/dist) aponta assets/API pra
// /agente-video/studio/* (VITE_BASE de producao). Atras do nginx do OS esse prefixo e'
// REMOVIDO antes de chegar aqui. Rodando SEM esse proxy (abrir o app direto, dev local
// da build de prod), as requisicoes chegam COM o prefixo — e o fallback SPA devolvia o
// index.html no lugar do .js, deixando a TELA PRETA (o React nunca montava). Removo o
// prefixo aqui pra que static, /api, /uploads e /projects resolvam nos dois cenarios.
const STUDIO_SUBPATH = "/agente-video/studio";
app.use((req, _res, next) => {
  if (req.url === STUDIO_SUBPATH || req.url.startsWith(STUDIO_SUBPATH + "/")) {
    req.url = req.url.slice(STUDIO_SUBPATH.length) || "/";
  }
  next();
});

// limite alto: documentos podem chegar com imagens novas em data URL (viram assets no save)
app.use(express.json({ limit: "60mb" }));

const UPLOAD_DIR = path.resolve("uploads");
const OUT_DIR = path.resolve("out");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// Limpeza no boot: apaga SÓ arquivos com mais de 24h (nunca tudo) em out/ e uploads/.
function limparAntigos(dir: string) {
  const limite = Date.now() - 24 * 60 * 60 * 1000;
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    try {
      if (fs.statSync(fp).mtimeMs < limite) fs.rmSync(fp, { force: true });
    } catch { /* ignora */ }
  }
}
limparAntigos(OUT_DIR);
limparAntigos(UPLOAD_DIR);

// Preserva a extensão do arquivo (o Chrome do Remotion precisa dela p/ o content-type).
// fieldSize alto: o props JSON pode crescer (muitos popups/tipografias). As imagens
// agora vão como ARQUIVOS separados, então o JSON fica leve — mas mantemos folga.
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) =>
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`),
  }),
  limits: { fieldSize: 50 * 1024 * 1024 }, // 50 MB por campo (folga p/ props grande)
});

// Expõe os uploads para o Remotion buscar via http durante o render.
app.use("/uploads", express.static(UPLOAD_DIR));
// Assets dos projetos (vídeo fonte, imagens, LUT) — servidos p/ preview e render.
app.use("/projects", express.static(PROJECTS_ROOT));

const PORT = Number(process.env.PORT ?? 3001);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "fluxo-ouro-backend" });
});

// SESSAO DO STUDIO — tem que vir ANTES de toda rota /api/* (Express e ordem de registro).
// Em PROD o nginx REMOVE o cookie do OS, entao o X-Studio-Token (assinado pelo OS) e' a
// UNICA prova de quem e' o usuario. Sem este middleware montado, o token viaja e ninguem
// confere: qualquer um que alcance a porta usa o editor. /api/health fica de fora de
// proposito (probe).
// DEV: sem VIDEO_STUDIO_SESSION_SECRET o middleware libera — o studio roda solto no 5174
// como sempre. Em PROD a env EXISTE e o gate vale.
app.use("/api", exigeStudioSession);

// Contrato que o OS consome: GET /health, POST /jobs, GET /jobs/:id, POST /jobs/:id/cancel.
// Rotas IRMAS das /api/* — nao as substituem. As /api/* servem o studio no navegador; estas
// servem o OS (Bearer VIDEO_SERVICE_TOKEN, loopback). Ver AGENTE-VIDEO-SERVICE.md secao 5.
app.use(osRouter);

// Executor de render pro job do OS. PONTE deliberada, nao refatoracao:
//
// O runRender e' uma funcao longa e delicada (matting, chroma, audio decupado, musica),
// toda amarrada em `jobs.get(jobId)` e em `uploads/<filename>`. Reescrever ela pra aceitar
// "video de qualquer lugar" e' o jeito de quebrar o export que funciona hoje. Entao aqui a
// gente ADAPTA o mundo do job ao que o runRender ja espera:
//   1. hard-link do video do projeto em uploads/ (link, nao copia: os videos tem GBs);
//   2. entrada no Map `jobs`, que e' de onde o runRender le/escreve status e progresso;
//   3. ponte de progresso (o Map usa 0..1, o contrato do OS usa 0..100).
// Quando/se o runRender for refatorado, esta ponte sai e o executor chama ele direto.
registraExecutores(async ({ projetoId, videoPath, props, onProgress, signal }) => {
  const nome = path.basename(videoPath);
  const destino = path.join(UPLOAD_DIR, nome);
  if (!fs.existsSync(destino)) {
    // hard-link: mesmo filesystem, custo zero, sem duplicar GBs. Fallback pra copia se o
    // FS nao suportar (ex.: volume diferente).
    try { fs.linkSync(videoPath, destino); } catch { fs.copyFileSync(videoPath, destino); }
  }

  const jobId = `os-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(jobId, { status: "preparing", progress: 0 });

  // O runRender so reporta progresso escrevendo no Map. Espelha pro contrato do OS.
  const timer = setInterval(() => {
    const j = jobs.get(jobId);
    if (j) onProgress(Math.round((j.progress ?? 0) * 100));
  }, 1000);
  // Cancelar no OS -> o runRender ve o status e aborta (mesmo caminho do timeout de matting).
  const onAbort = () => { const j = jobs.get(jobId); if (j) j.status = "error"; };
  signal.addEventListener("abort", onAbort);

  try {
    const fake = { filename: nome, path: destino, originalname: nome } as Express.Multer.File;
    await runRender(jobId, fake, JSON.stringify({ ...props, projectId: projetoId }));
    const j = jobs.get(jobId);
    if (j?.status === "error") throw new Error(j.error ?? "render falhou");
    if (!j?.outPath) throw new Error("render terminou sem arquivo de saida");
    return j.outPath;
  } finally {
    clearInterval(timer);
    signal.removeEventListener("abort", onAbort);
    jobs.delete(jobId);
  }
});

/**
 * INGESTÃO + TRANSCRIÇÃO: recebe o vídeo bruto, roda faster-whisper e
 * devolve os segmentos com timestamps (fonte única da timeline).
 */
app.post("/api/transcribe", upload.single("video"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "Nenhum arquivo enviado (campo 'video')." });
    return;
  }
  try {
    const result = await runTranscription(req.file.path);
    // mantém o upload (vira asset ao criar o projeto); a limpeza de 24h remove os órfãos.
    res.json({ fileName: req.file.originalname, videoFile: req.file.filename, ...result });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
    fs.rm(req.file.path, () => {});
  }
});

/**
 * MONTADOR — ingest de mídia extra (clipes pra pista principal ou b-roll). Só sobe o arquivo
 * pra uploads/ e devolve a referência + duração/dimensões (a UI usa pra montar o clipe). Vira
 * asset do projeto ao salvar (dehydrate move de uploads/ p/ assets/).
 */
app.post("/api/assembly/media", upload.single("video"), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: "Nenhum arquivo enviado (campo 'video')." }); return; }
  try {
    const [durationSec, dims] = await Promise.all([
      probeDuration(req.file.path).catch(() => 0),
      probeImageDims(req.file.path).catch(() => ({ w: 0, h: 0 })),
    ]);
    res.json({ asset: req.file.filename, fileName: req.file.originalname, durationSec, width: dims.w, height: dims.h });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
    fs.rm(req.file.path, () => {});
  }
});

/**
 * MONTADOR — "Concluir": ACHATA a montagem num MP4 único (principal concatenada + b-rolls
 * compostos) e RE-TRANSCREVE. Devolve o vídeo unificado (em uploads/) + a transcrição nova, no
 * MESMO shape do /api/transcribe. O front troca o sourceVideo/duracao/transcript e salva o
 * projeto (o que move o MP4 e os clipes pra assets/). NÃO conhece estado — resolve os clipes de
 * assets/<projectId>/ (persistidos) ou uploads/ (recém-enviados).
 */
app.post("/api/assembly/flatten", async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      projectId?: string; width?: number; height?: number;
      assembly?: { main?: Array<{ asset: string; inPoint: number; outPoint: number }>; brolls?: Array<{ asset: string; inPoint: number; outPoint: number; timelineStart: number }> };
    };
    const main = body.assembly?.main ?? [];
    if (!main.length) { res.status(400).json({ error: "A pista principal precisa de ao menos um clipe." }); return; }
    const w = Math.max(2, Math.round(Number(body.width) || 1080));
    const h = Math.max(2, Math.round(Number(body.height) || 1920));
    const resolve = (asset: string): string => {
      const name = String(asset).replace(/.*\//, ""); // aceita URL hidratada ou bare
      if (body.projectId) { const a = assetFsPath(String(body.projectId), name); if (fs.existsSync(a)) return a; }
      const u = path.join(UPLOAD_DIR, name);
      if (fs.existsSync(u)) return u;
      throw new Error(`Clipe não encontrado: ${name}`);
    };
    const mainF = main.map((c) => ({ path: resolve(c.asset), in: Number(c.inPoint) || 0, out: Number(c.outPoint) || 0 }));
    const brollF = (body.assembly?.brolls ?? []).map((b) => ({ path: resolve(b.asset), in: Number(b.inPoint) || 0, out: Number(b.outPoint) || 0, timelineStart: Number(b.timelineStart) || 0 }));

    const outName = `flat-${crypto.randomUUID()}.mp4`;
    const outPath = path.join(UPLOAD_DIR, outName);
    const { durationSec } = await flattenAssembly(mainF, brollF, w, h, outPath);
    const result = await runTranscription(outPath);
    // ...result primeiro: os campos abaixo (source unificado) SEMPRE mandam sobre a transcrição.
    res.json({ ...result, videoFile: outName, fileName: outName, durationSec, width: w, height: h });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * CORREÇÃO DE TEMPO das legendas: retranscreve o áudio (whisper fresco = verdade do
 * TEMPO), alinha por texto (Gotoh) e recoloca as regiões FORA DE SINCRONIA — caso
 * real: legendas ~2s atrasadas numa janela (derrapada do whisper original). O TEXTO
 * atual (já corrigido pelo usuário/copy) é preservado; recusa se o áudio não bater.
 */
app.post("/api/fix-caption-timing", upload.single("video"), async (req, res) => {
  const file = req.file;
  if (!file) { res.status(400).json({ error: "Nenhum arquivo enviado (campo 'video')." }); return; }
  try {
    const transcript = JSON.parse(String(req.body.transcript ?? "[]"));
    const fresh = await runTranscription(file.path);
    const freshWords: Word[] = (fresh.transcript as { words?: Word[] }[]).flatMap((s) => s.words ?? []);
    const out = fixCaptionTiming(transcript, freshWords);
    console.log(`[FIX-TIMING] ${out.refused ? `recusado: ${out.refused}` : `${out.fixedWords} palavra(s) recolocada(s) em ${out.regions.length} região(ões)`} (match ${(out.matchedRatio * 100).toFixed(0)}%)`);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  } finally {
    fs.rm(file.path, () => {});
  }
});

/**
 * CORREÇÃO DE ÁUDIO p/ preview: navegador não decodifica AC-3/PCM/DTS dentro de
 * MP4 (vídeo toca mudo). Re-multiplexa copiando o VÍDEO (rápido) e convertendo
 * só o ÁUDIO pra AAC. Devolve a URL do arquivo corrigido em /uploads.
 */
app.post("/api/fix-audio", upload.single("video"), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: "Nenhum arquivo enviado (campo 'video')." }); return; }
  // SÓ O ÁUDIO (AAC): o preview toca esta faixa em paralelo, sincronizada ao vídeo
  // ORIGINAL. NUNCA trocar o arquivo de vídeo — remux muda o start_time do container
  // e desloca TODOS os timestamps (cortes/legendas dessincronizam).
  const out = path.join(UPLOAD_DIR, `${path.parse(req.file.filename).name}-audio.m4a`);
  try {
    await runFfmpeg(["-y", "-i", req.file.path, "-vn", "-c:a", "aac", "-b:a", "192k", out], undefined, "fix-audio");
    res.json({ url: `/uploads/${path.basename(out)}` });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  } finally {
    fs.rm(req.file.path, () => {});
  }
});

/**
 * PROXY DE PREVIEW (P3+P4 da fluidez, estilo CapCut): versão LEVE do vídeo só para o
 * preview — lado maior ≤960 (≈540p), H.264 veryfast, e KEYFRAME A CADA 15 FRAMES (o pulo
 * dos cortes vira seek quase instantâneo → sem engasgo); áudio AAC (de quebra resolve
 * AC-3/PCM mudo). O EXPORT continua no arquivo ORIGINAL. Cache por chave do arquivo
 * (nome+tamanho+mtime, mandada pelo front) — gera uma vez por vídeo.
 */
// Jobs de proxy EM VOO por chave: requests simultâneos (ex.: StrictMode do React dispara o
// efeito 2× em dev) esperam o MESMO ffmpeg em vez de abrir outro. Dois ffmpeg escrevendo no
// mesmo arquivo corrompiam o proxy (NAL inválido → vídeo preto) — foi um bug real.
const proxyInflight = new Map<string, Promise<void>>();

app.post("/api/proxy", upload.single("video"), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: "Nenhum arquivo enviado (campo 'video')." }); return; }
  const file = req.file;
  const key = String(req.body.key ?? path.parse(file.filename).name).replace(/[^a-z0-9_.-]/gi, "").slice(0, 120);
  // v2 no nome: os proxies v1 nasciam com EMPTY EDIT (+83ms vídeo / +62ms áudio, 21ms de
  // dessincronia A/V) — b-frames + avoid_negative_ts=make_zero. Prefixo novo fura o cache.
  const out = path.join(UPLOAD_DIR, `proxy-v2-${key}.mp4`);
  try {
    // dimensões do ORIGINAL: o front precisa delas p/ o palco WYSIWYG quando o navegador
    // NÃO consegue tocar o original (HEVC/MKV) — aí o proxy é a ÚNICA fonte visível.
    const dims = await probeImageDims(file.path).catch(() => null);
    if (!fs.existsSync(out)) {
      let job = proxyInflight.get(key);
      if (!job) {
        job = (async () => {
          const t0 = Date.now();
          // escreve num TEMP único e RENOMEIA no fim (atômico): nunca se serve arquivo
          // pela metade, e um segundo job jamais escreve por cima do primeiro.
          const tmp = path.join(UPLOAD_DIR, `proxy-v2-${key}.part-${Date.now().toString(36)}.mp4`);
          try {
            await runFfmpeg([
              "-y", "-i", file.path,
              // lado maior ≤ 960, mantendo proporção e dimensões pares
              "-vf", "scale=trunc(iw*min(1\\,960/max(iw\\,ih))/2)*2:trunc(ih*min(1\\,960/max(iw\\,ih))/2)*2",
              // -bf 0: sem B-frames não há DTS negativo, e o mux não desloca os streams
              // (com make_zero, o proxy nascia com +83ms de vazio no vídeo e +62ms no
              // áudio — 21ms de dessincronia A/V que virava "legenda fora da fala").
              "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-g", "15", "-bf", "0", "-pix_fmt", "yuv420p",
              "-c:a", "aac", "-b:a", "128k",
              "-movflags", "+faststart",
              tmp,
            ], undefined, "proxy-preview");
            if (!fs.existsSync(out)) fs.renameSync(tmp, out);
            else fs.rmSync(tmp, { force: true });
            console.log(`[PROXY] ${key} gerado em ${((Date.now() - t0) / 1000).toFixed(1)}s`);
          } catch (e) {
            fs.rmSync(tmp, { force: true });
            throw e;
          }
        })().finally(() => proxyInflight.delete(key));
        proxyInflight.set(key, job);
      }
      await job;
    }
    res.json({ url: `/uploads/${path.basename(out)}`, srcW: dims?.w, srcH: dims?.h });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  } finally {
    fs.rm(file.path, () => {});
  }
});

/**
 * EXPORT (Etapa 6): render via Remotion como JOB com progresso.
 *  POST /api/render          → inicia; devolve { jobId }
 *  GET  /api/render/progress/:id → { status, progress }  (polling)
 *  GET  /api/render/result/:id   → baixa o MP4 quando pronto
 */
type JobStatus = "preparing" | "rendering" | "done" | "error";
interface Job { status: JobStatus; progress: number; outPath?: string; error?: string; }
const jobs = new Map<string, Job>();

// Aceita o vídeo (campo "video") + N imagens de popup (campos "img_*"), tratando
// erro do multer como JSON (não HTML 500) para a UI mostrar mensagem limpa.
const uploadRender = upload.any();
app.post("/api/render", (req, res) => {
  uploadRender(req, res, (err) => {
    if (err) { res.status(400).json({ error: `Falha no upload: ${(err as Error).message}` }); return; }

    const files = (req.files as Express.Multer.File[]) ?? [];
    const videoFile = files.find((f) => f.fieldname === "video");
    if (!videoFile) { res.status(400).json({ error: "Nenhum vídeo enviado (campo 'video')." }); return; }

    // Mapa: campo da imagem (ex: "img_0") → URL absoluta que o Remotion alcança.
    const imageMap: Record<string, string> = {};
    for (const f of files) {
      if (f.fieldname !== "video") imageMap[f.fieldname] = `http://localhost:${PORT}/uploads/${f.filename}`;
    }
    // Fundo do chroma (imagem/vídeo) → precisa do CAMINHO LOCAL (entra no ffmpeg, não no Remotion).
    const chromaBgPath = files.find((f) => f.fieldname === "chromabg")?.path ?? null;

    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    jobs.set(jobId, { status: "preparing", progress: 0 });
    res.json({ jobId });
    // TETO COMPARTILHADO (AGENTE-VIDEO-SERVICE.md secao 7): o render so comeca quando ha
    // vaga dentro do limite de workers — o MESMO contador que a fila do OS usa. Sem isto,
    // este endpoint (o botao "Renderizar MP4" do studio, o mais usado) furaria o teto e
    // levaria os 8 nucleos da KVM8, que e a maquina de PROD dos 220 clientes.
    // O job fica em "preparing" enquanto espera vaga — a UI ja trata esse estado.
    comVaga(() => runRender(jobId, videoFile, req.body.props, imageMap, chromaBgPath)).catch((e) => {
      jobs.set(jobId, { status: "error", progress: 0, error: (e as Error).message });
    });
  });
});

app.get("/api/render/progress/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) { res.status(404).json({ error: "job não encontrado" }); return; }
  res.json({ status: j.status, progress: j.progress, error: j.error });
});

app.get("/api/render/result/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j || j.status !== "done" || !j.outPath) { res.status(409).json({ error: "ainda não pronto" }); return; }
  res.download(j.outPath, "fluxo-ouro.mp4", () => {
    fs.rm(j.outPath!, () => {});
    jobs.delete(req.params.id);
  });
});

const PREPARING_TIMEOUT_MS = 5 * 60 * 1000; // 5 min sem sair de "preparing" (matting travado)

/**
 * Resolve o caminho local de um asset (ex: .cube) tanto se ele estiver nos
 * assets do projeto (projects/<id>/assets/) quanto em uploads/ (sessão nova, não
 * salva). Aceita ref como URL, nome de arquivo ou caminho. Projeto tem prioridade.
 */
function resolveAssetPath(ref: string, projectId?: string): string | null {
  const file = ref.replace(/.*\//, ""); // último segmento
  if (projectId) {
    const p = assetFsPath(projectId, file);
    if (fs.existsSync(p)) return p;
  }
  const u = path.join(UPLOAD_DIR, file);
  if (fs.existsSync(u)) return u;
  return projectId ? assetFsPath(projectId, file) : u; // devolve o esperado (erro legível depois)
}

async function runRender(jobId: string, file: Express.Multer.File, propsStr: string, imageMap: Record<string, string> = {}, chromaBgPath: string | null = null) {
  const job = jobs.get(jobId)!;
  const outPath = path.join(OUT_DIR, `${jobId}.mp4`);

  // Timeout de segurança: se o matting (fase preparing) travar, aborta e mata
  // a árvore de processos (python + ffmpeg) para não deixar zumbi comendo CPU.
  const ac = new AbortController();
  const prepTimer = setTimeout(() => {
    if (job.status === "preparing") ac.abort();
  }, PREPARING_TIMEOUT_MS);

  try {
    // (b) PONTO 2 — logo após o multipart: tamanho do campo props e resumo pós-parse.
    console.log(`[EXPORT-DEBUG] (b) props recebidos: ${propsStr?.length ?? 0} bytes`);
    // Os assets do FLOW/uploads no doc vem RELATIVOS (/projects/... , /uploads/...) — o
    // navegador reescreve pro subpath, mas o Remotion (server-side) precisa de host absoluto
    // pra buscar. Absolutiza AQUI, ponto unico dos dois callers (studio e job do OS).
    const props = JSON.parse((propsStr ?? "{}").replace(/"(\/(?:projects|uploads)\/)/g, `"http://localhost:${PORT}$1`));
    // (b) grava EM DISCO o props exato parseado do multipart (antes de resolver imagens).
    fs.writeFileSync(path.join(OUT_DIR, "debug-props-received.json"), JSON.stringify(props, null, 2));
    console.log(
      `[EXPORT-DEBUG] (b) parse OK: popups=${props.popups?.length ?? 0} cuts=${props.cuts?.length ?? 0} ` +
      `zooms=${props.zooms?.length ?? 0} font=${props.style?.fontFamily} transcript=${props.transcript?.length ?? 0}`,
    );
    const fps = props.fps ?? 30;
    const { width, height } = capDimensions(props.width ?? 1080, props.height ?? 1920);
    console.log(`[EXPORT] job ${jobId}: ${props.width}x${props.height} -> ${width}x${height}, dur ${props.durationSec}s`);

    let popups = props.popups ?? [];

    // RESILIÊNCIA: descarta popups fullscreen de vídeo (motion) cujo arquivo sumiu do
    // disco — senão o Remotion aborta o render inteiro com 404. Loga o que foi pulado.
    const flowMissing: string[] = [];
    popups = popups.filter((p: any) => {
      if (p?.type === "fullscreen" && p?.media?.kind === "video" && typeof p.media.src === "string") {
        const m = p.media.src.match(/\/projects\/([^/]+)\/assets\/flow\/(.+)$/);
        if (m) {
          const fp = assetFsPath(m[1], path.join("flow", decodeURIComponent(m[2])));
          if (!fs.existsSync(fp)) { flowMissing.push(path.basename(fp)); return false; }
        }
      }
      return true;
    });
    if (flowMissing.length) {
      console.warn(`[EXPORT] ${flowMissing.length} motion(s) sem arquivo — pulados no render: ${flowMissing.join(", ")}`);
    }

    // ── PRÉ-PASSE do plano de vídeo (antes do Remotion). ──
    // Se CHROMA ativo: assa keying→despill→fundo→cor num MP4 opaco (ordem = shader do
    // preview). O Remotion sobrepõe popups/legendas SEM cor, como no preview.
    // Senão: pré-passe de cor tradicional (correção+LUT no vídeo inteiro).
    let sourceFilename = file.filename; // servido em /uploads
    let sourcePath = file.path;         // caminho local
    const colorHash = crypto.createHash("md5").update(JSON.stringify(props.color ?? {})).digest("hex").slice(0, 8);
    const colorActive = props.color && !isColorNeutral(props.color);
    const chromaActive = isChromaActive(props.chroma);
    // Camadas só quando há popup "atrás da pessoa" com chroma (senão, caminho assado).
    const chromaLayered = chromaActive && popups.some((p: any) => p?.type === "support" && p?.behindSubject);
    let personSrc: string | undefined; // pessoa transparente (camadas)

    const chromaHash = crypto.createHash("md5")
      .update(JSON.stringify(props.chroma) + JSON.stringify(props.color) + `${width}x${height}`)
      .digest("hex").slice(0, 8);
    const commonPass = {
      inputPath: file.path,
      chroma: props.chroma,
      color: props.color ?? {},
      userLutPath: props.color?.lut?.file ? resolveAssetPath(props.color.lut.file, props.projectId) : null,
      bgPath: chromaBgPath, // fundo imagem/vídeo (local) — null se cor/nenhum
      width, height, durationSec: props.durationSec, signal: ac.signal,
    };

    if (chromaLayered) {
      // EM CAMADAS: fundo (plano de vídeo) + pessoa transparente por cima do popup "atrás".
      console.log(`[EXPORT] job ${jobId}: CHROMA em camadas (fundo + pessoa transparente)…`);
      const t0 = Date.now();
      const bgName = `chromabg-${file.filename}-${chromaHash}.mp4`;
      const personName = `chromaperson-${file.filename}-${chromaHash}.webm`;
      const bgOut = path.join(UPLOAD_DIR, bgName);
      const personOut = path.join(UPLOAD_DIR, personName);
      await chromaBackgroundPass({ ...commonPass, outputPath: bgOut });
      await chromaPersonPass({ ...commonPass, outputPath: personOut });
      console.log(`[EXPORT] job ${jobId}: chroma camadas ok (${Date.now() - t0}ms)`);
      sourceFilename = bgName;
      sourcePath = bgOut;
      personSrc = `http://localhost:${PORT}/uploads/${personName}`;
    } else if (chromaActive) {
      const outName = `chroma-${file.filename}-${chromaHash}.mp4`;
      const outPathC = path.join(UPLOAD_DIR, outName);
      console.log(`[EXPORT] job ${jobId}: pré-passe de CHROMA (keying+fundo+cor)…`);
      const t0 = Date.now();
      await chromaPrePass({ ...commonPass, outputPath: outPathC });
      console.log(`[EXPORT] job ${jobId}: chroma ok (${Date.now() - t0}ms)`);
      sourceFilename = outName;
      sourcePath = outPathC;
    } else if (colorActive) {
      console.log(`[EXPORT] job ${jobId}: cor ATIVA`);
      const hash = crypto.createHash("md5").update(JSON.stringify(props.color) + `${width}x${height}`).digest("hex").slice(0, 8);
      const corrName = `color-${file.filename}-${hash}.mp4`;
      const corrPath = path.join(UPLOAD_DIR, corrName);
      console.log(`[EXPORT] job ${jobId}: pré-passe de cor…`);
      const t0 = Date.now();
      await colorPrePass({
        inputPath: file.path,
        color: props.color,
        // resolve o .cube nos assets do projeto OU em uploads (sessão nova)
        userLutPath: props.color.lut?.file ? resolveAssetPath(props.color.lut.file, props.projectId) : null,
        outputPath: corrPath,
        width, height, // Full HD capado
        signal: ac.signal,
      });
      console.log(`[EXPORT] job ${jobId}: cor ok (${Date.now() - t0}ms)`);
      sourceFilename = corrName;
      sourcePath = corrPath;
    } else {
      console.log(`[EXPORT] job ${jobId}: sem chroma, cor neutra (pulada)`);
    }

    // Resolve os tokens "ref:img_N" das imagens (enviadas como arquivos) → URL absoluta.
    const resolveImg = (u?: string) => (u && u.startsWith("ref:") ? imageMap[u.slice(4)] ?? "" : u);
    for (const p of popups) {
      if (p?.type === "support" && p.content) {
        p.content.imageUrl = resolveImg(p.content.imageUrl);
        p.content.logoUrl = resolveImg(p.content.logoUrl);
      } else if (p?.type === "fullscreen" && p.placeholder) {
        p.placeholder.imageUrl = resolveImg(p.placeholder.imageUrl);
      }
    }

    // Matting "atrás da pessoa" (só o trecho de cada popup marcado).
    // O "atrás da pessoa" é SEMPRE honrado: com chroma vira o caminho em camadas
    // (pessoa transparente por cima do popup); sem chroma, usa o RVM abaixo.
    // RVM só quando NÃO há chroma (com chroma a pessoa vem do keying).
    for (const p of (chromaActive ? [] : popups).filter((p: any) => p?.type === "support" && p?.behindSubject)) {
      // cache-bust por cor: se a cor mudar, o alpha (que sai do vídeo corrigido) é regerado.
      const outFile = `alpha-${file.filename}-${p.id}-${colorHash}.webm`;
      try {
        console.log(`[EXPORT] matting popup ${p.id} do vídeo ${colorActive ? "corrigido" : "original"} (${p.at}s +${p.duration}s)…`);
        await getMattingProvider(p.mattingModel).generateAlphaVideo({
          videoPath: sourcePath, // vídeo já corrigido (matting vê a mesma cor)
          startFrame: Math.round(p.at * fps),
          endFrame: Math.round((p.at + p.duration) * fps),
          fps, width, height, outputPath: path.join(UPLOAD_DIR, outFile),
        }, ac.signal);
        p.alphaVideoPath = `http://localhost:${PORT}/uploads/${outFile}`;
      } catch (e) {
        // Se foi cancelado pelo timeout, propaga (falha o job). Senão, fallback:
        // segue sem alpha → o popup sai na frente (behindSubject ignorado).
        if (ac.signal.aborted) throw new Error("Matting excedeu 5 min e foi cancelado.");
        console.error(`[EXPORT] matting falhou p/ ${p.id} (fallback frente):`, e);
      }
    }

    // ── ÁUDIO DECUPADO (Fase 4): uma passada de ffmpeg → WAV único com os trechos
    // mantidos emendados por crossfade equal-power. Fonte do <Audio> global no Remotion
    // (vídeos entram mudos). Fonte única, idêntica ao preview. Fallback: sem WAV, o áudio
    // volta a sair dos próprios segmentos de vídeo.
    let audioSrc: string | undefined;
    try {
      const plan = buildCutPlan(Number(props.durationSec ?? 0), (props.cuts ?? []) as Cut[]);
      if (plan.segments.length > 0) {
        const cutsHash = crypto.createHash("md5")
          .update(JSON.stringify(props.cuts ?? []) + `:${props.durationSec}`).digest("hex").slice(0, 8);
        const wavName = `audio_decupado-${file.filename}-${cutsHash}.wav`;
        const wavPath = path.join(UPLOAD_DIR, wavName);
        if (!fs.existsSync(wavPath)) {
          await renderDecupadoAudio(sourcePath, plan.segments.map((s) => ({ srcStart: s.srcStart, srcEnd: s.srcEnd })), wavPath);
        }
        audioSrc = `http://localhost:${PORT}/uploads/${wavName}`;
        console.log(`[EXPORT] job ${jobId}: áudio decupado pronto (${plan.segments.length} segmentos)`);
        // DÍVIDA CONSCIENTE (até o wiring do preview): o export usa este WAV decupado, mas
        // o preview ainda toca o <video> original com seek — os dois áudios DIVERGEM. Some
        // quando o preview passar a consumir este mesmo WAV em tempo-saída (fixAudioUrl morre).
        console.warn(`[EXPORT] job ${jobId}: WARN áudio export≠preview (preview ainda não consome audio_decupado; janela de divergência até o wiring)`);
      }
    } catch (e) {
      console.error("[EXPORT] áudio decupado falhou (fallback ao áudio do vídeo):", (e as Error).message);
    }

    job.status = "rendering";
    clearTimeout(prepTimer); // saiu de preparing; render tem timeout próprio
    console.log(`[EXPORT] job ${jobId}: iniciando render`);
    await renderVideo({
      videoSrc: `http://localhost:${PORT}/uploads/${sourceFilename}`,
      audioSrc, // WAV decupado (fonte única); undefined → áudio dos vídeos (fallback)
      personSrc, // chroma em camadas: pessoa transparente por cima do popup "atrás"
      transcript: props.transcript ?? [],
      cuts: props.cuts ?? [],
      zooms: props.zooms ?? [],
      captions: props.captions ?? [], // legendas com tempo manual (vazio = deriva da transcrição)
      popups,
      style: props.style,
      durationSec: props.durationSec ?? 1,
      fps, width, height,
      outputPath: outPath,
      onProgress: (p) => { job.progress = p; },
    });

    // ── MÚSICA DE FUNDO (pós-render): mixa sob a fala, em loop, no volume escolhido. ──
    if (props.music?.file) {
      const musicPath = resolveAssetPath(String(props.music.file), props.projectId);
      if (musicPath && fs.existsSync(musicPath)) {
        console.log(`[EXPORT] job ${jobId}: mixando música de fundo (vol ${props.music.volume})…`);
        const mixed = outPath + ".mix.mp4";
        try {
          await mixBackgroundMusic(outPath, musicPath, { volume: Number(props.music.volume ?? 0.15), start: props.music.start, end: props.music.end }, mixed, ac.signal);
          fs.rmSync(outPath, { force: true });
          fs.renameSync(mixed, outPath);
        } catch (e) { console.error("[EXPORT] mix de música falhou (segue sem):", (e as Error).message); fs.rm(mixed, () => {}); }
      } else {
        console.warn(`[EXPORT] job ${jobId}: música não encontrada (${props.music.file}) — segue sem.`);
      }
    }

    job.status = "done"; job.progress = 1; job.outPath = outPath;
    // Cópia do MP4 nos exports do projeto (fora da limpeza de 24h). Falha não quebra o job.
    if (props.projectId) {
      try {
        const expDir = path.join(PROJECTS_ROOT, String(props.projectId), "exports");
        fs.mkdirSync(expDir, { recursive: true });
        fs.copyFileSync(outPath, path.join(expDir, `${Date.now()}.mp4`));
      } catch (e) { console.error("[EXPORT] cópia p/ projeto falhou:", (e as Error).message); }
    }
    console.log(`[EXPORT] job ${jobId}: done`);
  } catch (e) {
    // Loga o STACK completo (permanente) e mostra mensagem legível na UI.
    console.error(`[EXPORT] job ${jobId} ERRO:`, e);
    job.status = "error";
    job.error = (e as Error).message || "Falha desconhecida no render";
  } finally {
    clearTimeout(prepTimer);
    fs.rm(file.path, () => {});
  }
}

/** Upload de LUT .cube → salva em uploads/ e devolve a referência (nome do arquivo). */
app.post("/api/lut", upload.single("lut"), (req, res) => {
  if (!req.file) { res.status(400).json({ error: "Nenhum arquivo .cube enviado (campo 'lut')." }); return; }
  res.json({ file: req.file.filename });
});

/** Upload de música de fundo → salva em uploads/ e devolve a URL servida. */
app.post("/api/music", upload.single("music"), (req, res) => {
  if (!req.file) { res.status(400).json({ error: "Nenhum arquivo de áudio enviado (campo 'music')." }); return; }
  res.json({ url: `/uploads/${req.file.filename}` });
});

/**
 * AUTOCUT com IA (Claude): recebe a transcrição (segmentos) + copy + modo, a IA
 * decide o que cortar e devolve os cortes com timestamps do whisper (bordas
 * cronometradas). Provedor: `claude` CLI (logado) ou API (ANTHROPIC_API_KEY).
 */
app.post("/api/autocut-ai", async (req, res) => {
  try {
    const { transcript, copy = "", mode = "auto" } = req.body ?? {};
    if (!Array.isArray(transcript)) { res.status(400).json({ error: "Transcrição ausente." }); return; }
    const words: AiWord[] = transcript.flatMap((s: { words?: AiWord[] }) => s.words ?? [])
      .map((w: AiWord) => ({ text: w.text, start: w.start, end: w.end }));
    if (words.length === 0) { res.json({ cuts: [] }); return; }
    if (words.length > 4000) { res.status(400).json({ error: "Transcrição muito longa p/ um passe de IA (>4000 palavras). Divida o vídeo." }); return; }

    const t0 = Date.now();
    const spans = await aiDecideCuts(words, String(copy), mode as AiMode);
    const cuts = spansToCuts(words, spans);
    console.log(`[AUTOCUT-IA] ${words.length} palavras → ${cuts.length} cortes (${Date.now() - t0}ms)`);
    res.json({ cuts });
  } catch (e) {
    console.error("[AUTOCUT-IA] erro:", e);
    res.status(500).json({ error: (e as Error).message || "Falha no autocut com IA" });
  }
});

// source → Cut.reason (enum do timeline); a razão legível PT-BR vai em `detail`.
const decupCutReason = (src: string): Cut["reason"] => (src === "vad_silence" || src === "vad_breath" ? "silence" : "error");
function toCutsAndDetail(planned: CutInterval[]): { cuts: Cut[]; detail: unknown[] } {
  const stamp = Date.now();
  const cuts: Cut[] = planned.map((c, i) => ({
    id: `decup-${stamp}-${i}`, start: c.startMs / 1000, end: c.endMs / 1000, reason: decupCutReason(c.source), enabled: true,
  }));
  const detail = planned.map((c) => ({ start: c.startMs / 1000, end: c.endMs / 1000, label: c.label, confidence: c.confidence, applied: c.applied }));
  return { cuts, detail };
}

// Job de IA da decupagem (especulação/polling, padrão flowJobs). result = conjunto FINAL
// (determinístico + IA já re-planejado) — o front substitui os cortes decup-* por ele.
type DecupJob = { status: "running" | "done" | "error"; result?: { cuts: Cut[]; detail: unknown[]; transcript?: unknown[]; regions?: unknown[] }; error?: string };
const decupJobs = new Map<string, DecupJob>();

/**
 * DECUPAGEM (Fase 5) — UM BOTÃO, com ESPECULAÇÃO:
 *  - DETERMINÍSTICO (imediato): áudio (decode único) → VAD (fonte do TEMPO) → ancoragem →
 *    runDecupagem (copy + SILÊNCIO/dead-air + alucinação apertada → merge/snap/score). Volta na hora.
 *  - IA (job, polling em /api/decupagem/progress/:id): retakes/falsos começos. SEM COPY é a
 *    ÚNICA camada de conteúdo — não é opcional. O patch re-planeja tudo (planWithAi) e o
 *    front substitui os cortes decup-* pelo conjunto final.
 * NUNCA FALHA EM SILÊNCIO: erro volta em `error` (200).
 */
app.post("/api/decupagem", upload.single("video"), async (req, res) => {
  const file = req.file;
  if (!file) { res.status(400).json({ error: "Vídeo ausente." }); return; }
  try {
    const transcript = JSON.parse(String(req.body.transcript ?? "[]"));
    const copy = String(req.body.copy ?? "");
    const words: Word[] = Array.isArray(transcript) ? transcript.flatMap((s: { words?: Word[] }) => s.words ?? []) : [];
    if (words.length === 0) { res.json({ cuts: [], detail: [], needsAi: false, jobId: null }); return; }

    const t0 = Date.now();
    await loadDicionario();                                    // Hunspell (idempotente, cacheado) — guarda de mishear
    const samples = await loadMono16k(file.path);              // decode ÚNICO
    const probs = await computeSpeechProbs(samples);
    const segments = probsToSegments(probs, samples.length);   // VAD de TEMPO (150ms) — ancoragem/silêncio
    const anchored = anchorWords(words, segments);
    const track = buildEnergyTrack(samples);

    // VAD de ZONA (minSilence fino 30ms, separado do de tempo) + cabeças-de-bloco → zonas.
    // Fragmentar ajuda: cada fragmento de uma tentativa repetida começa igual. Nunca falha o
    // pipeline: se a transcrição de cabeça falhar, segue só com periodicidade.
    let headZones: { from: number; to: number; via?: "periodicidade" | "cabeca" | "bloco" | "ambos" }[] = [];
    let zblocks: { startMs: number; endMs: number }[] = [];
    try {
      const raw = probsToSegments(probs, samples.length, { minSilenceMs: 30 }).filter((s) => s.isSpeech);
      zblocks = coalesceMicroBlocks(raw); // funde cacos <400ms (intruso garble) antes da cabeça
      const heads = await transcribeHeads(file.path, zblocks.map((b) => ({ startMs: b.startMs, endMs: Math.min(b.startMs + 800, b.endMs) })));
      // três métodos: CABEÇA (falso começo acústico) + BLOCO (reformulação, texto canônico). unirZonas junta.
      headZones = [...zonasCabeca(zblocks, heads, anchored), ...zonasBloco(zblocks, anchored)];
    } catch (e) { console.error("[DECUPAGEM] zona por cabeça/bloco falhou (segue só periodicidade):", (e as Error).message); }

    const result = runDecupagem(anchored, copy, { track, vadSegments: segments, headZones });
    const det = toCutsAndDetail(result.cuts);
    console.log(`[DECUPAGEM] det: ${words.length} palavras → ${det.cuts.length} cortes (${Date.now() - t0}ms), needsAi=${result.needsAi}`);

    // IA em background (retakes). Sem copy → sem restrictTo (a IA julga tudo).
    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    decupJobs.set(jobId, { status: "running" });
    // ZONAS DE RETAKE: dentro delas a IA decide sem restrição; fora, restrita aos candidatos.
    const restrictTo = buildRestrictTo(result.retakeCandidates, result.retakeZones, copy.trim().length > 0);
    console.log(`[DECUPAGEM] zonas de retake: ${JSON.stringify(result.retakeZones)} | restrictTo=${restrictTo ? `{${[...restrictTo].join(",")}}` : "undefined"}`);
    (async () => {
      const ai0 = Date.now();
      const aiCuts = await aiRetakeCuts(anchored, copy, { restrictTo });
      // REGRA DE BORDA: as palavras mantidas nas zonas (keeper) são invioláveis — cortes que
      // as invadem são encolhidos até a borda. O keeper é definido por TODOS os cortes da zona
      // (IA + falso-começo por bloco), senão a zona-cabeça inteira pareceria keeper.
      const fc = result.rawIntervals.filter((c) => c.reason.includes("falso_comeco"));
      const protect = keeperEdges(anchored, result.retakeZones, [...aiCuts, ...fc]);
      const planned = planWithAi(result.rawIntervals, aiCuts, track, protect);
      const full = planned.filter((c) => c.applied);
      const aiN = full.filter((c) => c.reason.includes("ai_retake_detection")).length;
      console.log(`[DECUPAGEM] IA job ${jobId}: ${aiCuts.length} cortes IA → ${full.length} finais (${aiN} de retake) (${Date.now() - ai0}ms)`);
      const out = toCutsAndDetail(full);
      // FALSO COMEÇO DETECTADO mas BLOQUEADO (sem copy p/ reparar a legenda que o corte parte):
      // NÃO some em silêncio — vira marcador ACIONÁVEL ("cole a copy pra cortar"). O editor precisa
      // saber que o erro foi achado e o que destrava o corte.
      const blockedFC = planned.filter((c) =>
        !c.applied && c.blocked_by === "caption_timestamp_collapse" && c.reason.includes("falso_comeco"));
      if (blockedFC.length) console.log(`[DECUPAGEM] ${blockedFC.length} falso começo bloqueado (falta copy) → marcado`);
      // DISFLUÊNCIA (marca, não corta): colapso de ancoragem = onde OLHAR. Passa full + blockedFC
      // como cobertura p/ não duplicar o span do falso começo bloqueado.
      const disflu = disfluenciaLayer(anchored, zblocks, [...full, ...blockedFC]);
      // RECUPERAR REPETIÇÃO ACHATADA: a canônica cola tomadas repetidas numa palavra arrastada, então
      // a periodicidade textual não as vê. Re-transcreve FINO cada região de disfluência e procura
      // repetição imediata; onde há, o marcador vago vira um CORTE PRECISO da 1ª tomada (o editor
      // decide no chip "cortar"). Nunca derruba o job: falha na transcrição → segue com o marcador.
      let fineWords: Word[][] = [];
      try {
        fineWords = await transcribeRegionsWords(file.path, disflu.map((r) => ({ startMs: r.startMs, endMs: r.endMs })));
      } catch (e) { console.error("[DECUPAGEM] repetição fina falhou (segue com marcador):", (e as Error).message); }
      let recuperadas = 0;
      const disfluRegions = disflu.map((r, i) => {
        const rep = fineWords[i]?.length ? detectaRepeticaoFina(fineWords[i]) : null;
        if (rep && rep.cutEndMs > rep.cutStartMs) {
          recuperadas++;
          return { start: rep.cutStartMs / 1000, end: rep.cutEndMs / 1000, label: `Repetição: "${rep.frase}" ×${rep.vezes} — corte a 1ª`, confidence: 0.8 };
        }
        return { start: r.startMs / 1000, end: r.endMs / 1000, label: "Possível repetição — ouça", confidence: r.confidence };
      });
      if (recuperadas) console.log(`[DECUPAGEM] ${recuperadas} repetição(ões) achatada(s) recuperada(s) por transcrição fina`);
      const regions = [
        ...blockedFC.map((c) => ({
          start: c.startMs / 1000, end: c.endMs / 1000, label: "Falso começo — cole a copy p/ cortar", confidence: c.confidence ?? 0.9,
        })),
        ...disfluRegions,
      ];
      if (regions.length) console.log(`[DECUPAGEM] ${regions.length} marcador(es) para revisar`);
      // CAPTION-COVERAGE: falso começo aplicado com copy deixa a legenda do recomeço com buraco.
      // caption-coverage (cutplan→coverage, tempo-saída) re-preenche com a copy. Só com copy.
      let repaired: unknown[] | undefined;
      if (copy.trim().length > 0 && full.some((c) => c.reason.includes("needs_caption_repair"))) {
        try {
          const cov = await fillCaptionGaps(transcript, samples.length / 16000, out.cuts, copy);
          if (cov.filled > 0) { repaired = cov.transcript as unknown[]; console.log(`[DECUPAGEM] caption-coverage: ${cov.filled}/${cov.gaps} buracos reparados`); }
        } catch (e) { console.error("[DECUPAGEM] caption-coverage falhou (segue sem reparo):", (e as Error).message); }
      }
      decupJobs.set(jobId, { status: "done", result: { ...out, transcript: repaired, regions } });
    })().catch((e) => {
      console.error(`[DECUPAGEM] IA job ${jobId} erro:`, e);
      decupJobs.set(jobId, { status: "error", error: (e as Error).message || "Falha na IA de decupagem" });
    });
    setTimeout(() => decupJobs.delete(jobId), 10 * 60 * 1000); // TTL

    res.json({ cuts: det.cuts, detail: det.detail, needsAi: result.needsAi, jobId, error: result.error });
  } catch (e) {
    console.error("[DECUPAGEM] erro:", e);
    res.json({ cuts: [], detail: [], needsAi: false, jobId: null, error: (e as Error).message || "Falha ao decupar" });
  } finally {
    fs.rm(file.path, () => {}); // limpa o upload temporário (a IA usa só a memória)
  }
});

/** Polling do patch de IA da decupagem. `cuts` (quando done) = conjunto FINAL (det + IA). */
app.get("/api/decupagem/progress/:id", (req, res) => {
  const j = decupJobs.get(req.params.id);
  if (!j) { res.status(404).json({ error: "job não encontrado" }); return; }
  res.json({ status: j.status, cuts: j.result?.cuts, detail: j.result?.detail, transcript: j.result?.transcript, regions: j.result?.regions, error: j.error });
});

/**
 * COBERTURA de legenda (IA): acha trechos do vídeo final sem legenda e, com a copy,
 * preenche o texto que falta (timestamps no trecho que ficou). Devolve a transcrição.
 */
app.post("/api/caption-coverage", async (req, res) => {
  try {
    const { transcript, cuts = [], copy = "", durationSec } = req.body ?? {};
    if (!Array.isArray(transcript)) { res.status(400).json({ error: "Transcrição ausente." }); return; }
    if (typeof durationSec !== "number" || durationSec <= 0) { res.status(400).json({ error: "durationSec inválido." }); return; }
    const t0 = Date.now();
    const out = await fillCaptionGaps(transcript, durationSec, cuts, String(copy));
    console.log(`[COBERTURA] ${out.gaps} buracos, ${out.filled} preenchidos (${Date.now() - t0}ms)`);
    res.json(out);
  } catch (e) {
    console.error("[COBERTURA] erro:", e);
    res.status(500).json({ error: (e as Error).message || "Falha na conferência de legenda" });
  }
});

/**
 * ALINHAR LEGENDAS COM A FALA (fino): re-transcreve cada trecho de fala do VAD em janela
 * CURTA (≤28s — o Whisper não encadeia, o timestamp local não deriva) e adota os tempos
 * novos SÓ nas palavras cujo texto casa com o existente (LCS com trava temporal). O texto
 * do usuário nunca muda; fala re-ouvida sem legenda nenhuma vira linha nova.
 * Substitui o antigo /api/anchor-captions (VAD só tinha autoridade nas fronteiras).
 */
app.post("/api/realign-captions", async (req, res) => {
  try {
    const { projectId, captions, maxWords } = req.body ?? {};
    if (!projectId) { res.status(400).json({ error: "projectId ausente." }); return; }
    if (!Array.isArray(captions) || captions.length === 0) {
      res.status(400).json({ error: "Não há legendas materializadas para alinhar." }); return;
    }
    const pf = readProject(String(projectId));
    // readProject hidrata sourceVideo p/ URL servida; VAD e whisper precisam do arquivo em disco.
    const file = String(pf.document.sourceVideo).replace(/.*\//, "");
    const video = assetFsPath(String(projectId), file);
    if (!fs.existsSync(video)) { res.status(404).json({ error: "Vídeo fonte do projeto não encontrado." }); return; }

    const t0 = Date.now();
    // speechPadMs=0: borda REAL da fala (o pad de 30ms deslocaria as janelas).
    const vad = await runVad(video, { speechPadMs: 0 });
    const speech = vad.filter((s) => s.isSpeech).map((s) => ({ start: s.startMs / 1000, end: s.endMs / 1000 }));
    const wins = buildRealignWindows(speech);
    console.log(`[REALINHAR] ${speech.length} trechos de fala → ${wins.length} janelas; re-transcrevendo…`);
    const fresh = (await transcribeRegionsWords(video, wins)).flat();
    const out = realignCaptionsToWords(captions as Caption[], fresh, { maxWords: Number(maxWords) || 3 });
    console.log(`[REALINHAR] casadas ${out.matched}/${out.total}, interpoladas ${out.interpolated}, ` +
      `novas ${out.added} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    res.json(out);
  } catch (e) {
    console.error("[REALINHAR] erro:", e);
    res.status(500).json({ error: (e as Error).message || "Falha ao alinhar as legendas" });
  }
});

/**
 * Recoloca no tempo de FONTE um transcript feito sobre o áudio JÁ SEM os cortes (tempo de
 * saída). Agrupa as palavras por trecho mantido: se uma palavra do whisper cair na emenda de
 * dois trechos (raro), ela e as seguintes viram um segmento NOVO — assim nenhuma linha de
 * legenda atravessa um corte (era o bug que o usuário via).
 */
function mapTranscriptOutputToSource(segs: TranscriptSegment[], plan: CutPlan): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  const clampN = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  let sid = 0;
  for (const seg of segs) {
    let cur: Word[] = [];
    let curIdx = -1;
    const flush = () => {
      if (!cur.length) return;
      out.push({ id: `rt${sid++}`, start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(" ").trim(), words: cur, source: "whisper" });
      cur = [];
    };
    for (const w of seg.words ?? []) {
      const idx = segIndexOfOutput((w.start + w.end) / 2, plan);
      const sSeg = plan.segments[idx];
      const ss = clampN(outputToSource(w.start, plan), sSeg.srcStart, sSeg.srcEnd);
      const se = clampN(outputToSource(w.end, plan), sSeg.srcStart, sSeg.srcEnd);
      if (idx !== curIdx) { flush(); curIdx = idx; }
      cur.push({ ...w, start: ss, end: Math.max(ss + 0.02, se) });
    }
    flush();
  }
  return out;
}

/**
 * RETRANSCREVER PULANDO OS CORTES: renderiza SÓ o áudio dos trechos mantidos na timeline
 * (concat limpo, sem crossfade), transcreve, e recoloca cada palavra no tempo de fonte. É a
 * forma limpa de reconstruir as legendas depois de muitos cortes — sem os bugs de remapear
 * palavras que a borda de um corte atravessava. O front troca o roteiro e re-deriva a legenda.
 */
app.post("/api/retranscribe-cut", async (req, res) => {
  try {
    const { projectId, cuts, durationSec } = req.body ?? {};
    if (!projectId) { res.status(400).json({ error: "projectId ausente." }); return; }
    const pf = readProject(String(projectId));
    const file = String(pf.document.sourceVideo).replace(/.*\//, "");
    const video = assetFsPath(String(projectId), file);
    if (!fs.existsSync(video)) { res.status(404).json({ error: "Vídeo fonte do projeto não encontrado." }); return; }
    const dur = Number(durationSec) || Number(pf.document.durationSec) || 0;
    const plan = buildCutPlan(dur, (Array.isArray(cuts) ? cuts : []) as Cut[]);
    if (!plan.segments.length || plan.outDuration < 0.2) { res.status(400).json({ error: "Não sobrou áudio suficiente após os cortes." }); return; }

    // Extrai SÓ o áudio dos trechos mantidos, concat LIMPO (sem crossfade — bordas de palavra
    // nítidas p/ o whisper), mono 16k (o modelo espera 16k).
    const outWav = path.join(OUT_DIR, `retrans-${String(projectId)}-${Date.now().toString(36)}.wav`);
    const trims = plan.segments.map((s, i) => `[0:a]atrim=start=${s.srcStart.toFixed(6)}:end=${s.srcEnd.toFixed(6)},asetpts=PTS-STARTPTS[a${i}]`);
    const concat = plan.segments.map((_, i) => `[a${i}]`).join("") + `concat=n=${plan.segments.length}:v=0:a=1[out]`;
    await runFfmpeg(["-y", "-i", video, "-filter_complex", `${trims.join(";")};${concat}`, "-map", "[out]", "-ac", "1", "-ar", "16000", outWav], undefined, "retranscribe-cut");

    const fresh = await runTranscription(outWav);
    fs.rm(outWav, () => {});
    const transcript = mapTranscriptOutputToSource((fresh.transcript ?? []) as TranscriptSegment[], plan);
    console.log(`[RETRANSCREVER] ${plan.segments.length} trecho(s), ${plan.outDuration.toFixed(1)}s de áudio → ${transcript.length} segmento(s)`);
    res.json({ transcript, durationSec: dur });
  } catch (e) {
    console.error("[RETRANSCREVER] erro:", e);
    res.status(500).json({ error: (e as Error).message || "Falha ao retranscrever pulando os cortes" });
  }
});

// ───────────────────────── FLOW (motion design por IA) ─────────────────────
// Jobs por FRASE (não por momento): o usuário aprova/anima frases em paralelo.
type FlowJob = { status: "running" | "done" | "error"; progress: number; error?: string; result?: unknown; abort?: () => void };
const flowJobs = new Map<string, FlowJob>();

function startFlowJob(worker: (job: FlowJob, signal: AbortSignal) => Promise<unknown>): string {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const job: FlowJob = { status: "running", progress: 0 };
  flowJobs.set(id, job);
  const ac = new AbortController();
  job.abort = () => ac.abort(); // cancelamento pelo usuário (endpoint /cancel)
  const timer = setTimeout(() => ac.abort(), 12 * 60 * 1000); // vídeo demora → 12 min
  worker(job, ac.signal)
    .then((result) => { job.status = "done"; job.progress = 1; job.result = result; })
    .catch((e) => {
      job.status = "error";
      job.error = ac.signal.aborted ? "geração cancelada" : ((e as Error).message || "Falha no FLOW");
    })
    .finally(() => clearTimeout(timer));
  return id;
}

/** Cancela um job em andamento (aborta a chamada externa via AbortSignal). */
app.post("/api/flow/cancel/:id", (req, res) => {
  const j = flowJobs.get(req.params.id);
  if (!j) { res.status(404).json({ error: "job não encontrado" }); return; }
  if (j.status === "running") j.abort?.();
  res.json({ ok: true });
});

const flowHash = (s: string) => crypto.createHash("md5").update(s).digest("hex").slice(0, 10);

/** Caminho + URL de um asset do FLOW em projects/<id>/assets/flow/. */
function flowAsset(projectId: string, file: string): { fsPath: string; url: string } {
  const dir = assetFsPath(projectId, "flow");
  fs.mkdirSync(dir, { recursive: true });
  // url RELATIVA (nao http://localhost:PORT): dentro do iframe do OS o localhost e a maquina
  // do usuario, entao a midia gerada nao carregava. Relativa -> o front reescreve pro subpath
  // via comBase. (fsPath continua absoluto p/ uso server-side.)
  return { fsPath: path.join(dir, file), url: `/projects/${projectId}/assets/flow/${file}` };
}

app.get("/api/flow/progress/:id", (req, res) => {
  const j = flowJobs.get(req.params.id);
  if (!j) { res.status(404).json({ error: "job não encontrado" }); return; }
  res.json({ status: j.status, progress: j.progress, error: j.error, result: j.result });
});

/** Detecção: a IA acha 3 momentos e segmenta em frases (por índice de palavra). */
app.post("/api/flow/detect", (req, res) => {
  try {
    const { transcript, copy = "" } = req.body ?? {};
    if (!Array.isArray(transcript)) { res.status(400).json({ error: "Transcrição ausente." }); return; }
    const words = transcript.flatMap((s: { words?: { text: string; start: number; end: number }[] }) => s.words ?? []);
    if (words.length === 0) { res.status(400).json({ error: "Transcrição vazia." }); return; }
    const jobId = startFlowJob(async (_job, signal) => ({ moments: await detectFlowMoments(words, String(copy), signal) }));
    res.json({ jobId });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

/** Prompt de design (síncrono): se há imagens, um modelo de VISÃO (gpt-4o) analisa as
 *  referências e escreve o prompt (ancora a identidade real). Senão, Claude cego. */
/** Análise de ESTILO (visão): extrai a descrição do look da referência da marca. */
app.post("/api/flow/analyze-style", async (req, res) => {
  try {
    const { refs = [] } = req.body ?? {};
    const list = (Array.isArray(refs) ? refs : []).filter((r: { src?: string }) => r.src?.startsWith("data:"));
    if (!list.length) { res.status(400).json({ error: "Anexe a imagem de estilo antes de analisar." }); return; }
    const styleDesc = await analyzeStyle(list);
    res.json({ styleDesc });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

app.post("/api/flow/design-prompt", async (req, res) => {
  try {
    const { texto = "", userPrompt = "", refs = [], identity } = req.body ?? {};
    const list: { tag: string; src?: string; name?: string }[] = Array.isArray(refs) ? refs : [];
    const idt = (identity ?? { refs: [] }) as FlowIdentity;

    // ESTILO nunca vai como imagem (o gpt-image copiaria o conteúdo) — entra como
    // TEXTO. Sem styleDesc ainda? Analisa por visão AGORA e devolve pro front cachear.
    const estilos = list.filter((r) => r.tag === "estilo" && r.src?.startsWith("data:"))
      .map((r) => ({ tag: r.tag, src: r.src as string, name: r.name }));
    let styleDescNew: string | undefined;
    let styleDesc = idt.styleDesc?.trim() ?? "";
    if (!styleDesc && estilos.length) {
      try { styleDesc = styleDescNew = await analyzeStyle(estilos); }
      catch (e) { console.warn("[FLOW] análise de estilo falhou:", (e as Error).message); }
    }

    // PROMPT DIRETO (sem IA): curto e imperativo, como o fluxo manual no ChatGPT.
    // O estilo entra DUAS vezes: como imagem BORRADA (atmosfera: fundo/cores/luz)
    // e como TEXTO analisado (tipografia/materiais/acabamento, que o borrão apaga).
    const designPrompt = buildDesignPromptDirect({
      texto: String(texto), userPrompt: String(userPrompt),
      refs: list.map((r) => ({ tag: r.tag })),
      identityBlock: identityToPrompt({ ...idt, styleDesc }),
    });
    res.json({ designPrompt, ...(styleDescNew ? { styleDesc: styleDescNew } : {}) });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

/**
 * ELEMENTO PRA POPUP DE APOIO — DUAS ETAPAS, cada modelo no que faz de melhor:
 *  1) GERAÇÃO (gpt-image-2, fidelidade máxima às referências): com um BOTÃO anexado,
 *     a frase do usuário SUBSTITUI o texto do botão — mesmo design, só o texto muda.
 *     Sem referência, cria o elemento descrito. Sai em fundo SÓLIDO (o -2 não faz alpha).
 *  2) REMOÇÃO DE FUNDO (gpt-image-1, único com alpha nativo): recebe o resultado da
 *     etapa 1 e SÓ recorta o fundo — não redesenha nada. Devolve PNG transparente.
 */
app.post("/api/popup-element", (req, res) => {
  try {
    const { prompt, images = [] } = req.body ?? {};
    if (!prompt?.trim()) { res.status(400).json({ error: "Descreva o elemento (ex: botão vermelho 'COMPRE AGORA')." }); return; }
    const refs: string[] = (Array.isArray(images) ? images : []).filter((s: string) => typeof s === "string" && s.startsWith("data:"));
    const jobId = startFlowJob(async (job, signal) => {
      job.progress = 0.1;
      const texto = String(prompt).trim();
      // ETAPA 1 — com botão de referência: REPLICA o design e troca SÓ o texto pela frase.
      const genPrompt = refs.length
        ? `You are given a reference image of a button/graphic element. Reproduce that EXACT element — same shape, colors, gradients, borders, glow/effects, font style and letter treatment — changing ONLY its text, which must read exactly: "${texto}" (keep Portuguese accents exactly). ` +
          `If the new text is longer or shorter, resize the text or the element width naturally, keeping the same design language. ` +
          `Render ONLY the element, centered, tight framing with a small margin, on a plain SOLID single-color background that contrasts with the element (no scenery, no gradient background, no floor, no shadow cast on a surface, no watermark, no extra text).`
        : `A single isolated graphic element for a video overlay: ${texto}. ` +
          `Render ONLY the element itself, centered, tight framing with a small margin, on a plain SOLID single-color background that contrasts with the element. ` +
          `No background scenery, no floor, no drop shadow onto a surface, no extra text beyond what was requested (keep Portuguese accents exactly), no watermark. Crisp, premium, high-fidelity finish.`;
      const tmpDir = path.join(UPLOAD_DIR, `popupel-${Date.now().toString(36)}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      const refPaths = refs.map((src, i) => {
        const m = src.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i);
        const ext = (m?.[1] ?? "").includes("jpeg") || (m?.[1] ?? "").includes("jpg") ? "jpg" : (m?.[1] ?? "").includes("webp") ? "webp" : "png";
        const p = path.join(tmpDir, `ref-${i}.${ext}`);
        fs.writeFileSync(p, Buffer.from(m?.[2] ?? "", "base64"));
        return { path: p, tag: "referencia" };
      });
      try {
        const gen = await getImageProvider().generate({
          prompt: genPrompt, aspectRatio: "1:1", count: 1, signal,
          references: refPaths.length ? refPaths : undefined, model: "gpt-image-2",
        });
        job.progress = 0.55;
        console.log(`[POPUP-EL] etapa 1 ok (gpt-image-2${refs.length ? ", com botão de referência" : ""}) → remoção de fundo`);

        // ETAPA 2 — gpt-image-1 SÓ remove o fundo (recorte fiel, alpha nativo).
        const stagePath = path.join(tmpDir, "stage1.png");
        fs.writeFileSync(stagePath, Buffer.from(gen.imageUrl.split(",")[1] ?? "", "base64"));
        const cutPrompt =
          `Remove the background completely: output the EXACT same element from the attached image on a fully TRANSPARENT background (alpha PNG). ` +
          `Do NOT redraw, restyle, recolor, move or change the element in ANY way — a pixel-faithful cutout of the element only. ` +
          `No background, no halo, no outline, no shadow cast on a surface, no watermark.`;
        const cut = await getImageProvider().generate({
          prompt: cutPrompt, aspectRatio: "1:1", count: 1, signal,
          background: "transparent", references: [{ path: stagePath, tag: "referencia" }], model: "gpt-image-1",
        });
        return { imageUrl: cut.imageUrl }; // data URL PNG com alpha
      } finally {
        fs.rm(tmpDir, { recursive: true, force: true }, () => {});
      }
    });
    res.json({ jobId });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

/**
 * CHAT DE DESIGN (estilo ChatGPT): o usuário anexa imagens + escreve o que quer;
 * o texto vai VERBATIM ao gpt-image junto das imagens (na ordem anexada). Sem
 * templates, sem reescrita — o controle é 100% do usuário, como no ChatGPT.
 */
app.post("/api/flow/design-chat", (req, res) => {
  try {
    const { projectId, phraseId, prompt, images = [], aspect = "9:16", texto, delta, identity, refs } = req.body ?? {};
    if (!projectId) { res.status(400).json({ error: "projectId ausente (salve o projeto antes de gerar)." }); return; }
    if (!prompt?.trim() && !texto?.trim()) { res.status(400).json({ error: "Escreva o que você quer gerar." }); return; }
    const { w, h } = aspectDims(String(aspect) as FlowAspect);
    const jobId = startFlowJob(async (job, signal) => {
      job.progress = 0.1;
      const file = `chat-${phraseId}-${Date.now().toString(36)}.png`;
      const asset = flowAsset(String(projectId), file);
      const tmpDir = flowAsset(String(projectId), `.tmp-chat-${phraseId}`).fsPath;
      fs.mkdirSync(tmpDir, { recursive: true });
      // grava um data URL em arquivo temp; devolve o path (ou undefined se não for data URL)
      const writeTmp = (src: string | undefined, name: string): string | undefined => {
        const m = src?.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i);
        if (!m) return undefined;
        const ext = m[1].includes("jpeg") || m[1].includes("jpg") ? "jpg" : m[1].includes("webp") ? "webp" : "png";
        const p = path.join(tmpDir, `${name}.${ext}`);
        fs.writeFileSync(p, Buffer.from(m[2], "base64"));
        return p;
      };

      // MAPEAMENTO 2 SLOTS (Fase 2): a UI manda só LAYOUT (tag `esboco`) + ESTILO (tag `estilo`).
      // COMPAT: as tags antigas (5 no total) continuam válidas no schema — projetos salvos abrem
      // sem migração. `logo` fica na identidade (não é slot). `serie` é automática (fora da UI).
      // `referencia`/ELEMENTO está FORA do MVP dos 2 slots: se vier num projeto antigo, é lida sem
      // quebrar mas NÃO vira slot — o órfão dobra no `delta` até ganhar anexo próprio (Fase 3).
      const taggedRefs: { tag: string; src: string; id?: string }[] = Array.isArray(refs) ? refs : [];
      const estiloRef = taggedRefs.find((r) => r.tag === "estilo" && r.src?.startsWith("data:"));
      const layoutRef = taggedRefs.find((r) => r.tag === "esboco" && r.src?.startsWith("data:"));
      // FORMATO AUTOR (Fase 2): o request traz texto/delta/refs. SEMPRE passa por authorDesignPrompt,
      // que decide sozinho claude vs raw (flag FLOW_PROMPT_AUTHOR=raw, OU sem imagem de estilo → raw).
      // NUNCA bloqueia: sem estilo é o comportamento de hoje (identidade + delta), pelo caminho do autor.
      const isAuthoredShape = !!(String(texto ?? "").trim() || String(delta ?? "").trim() || taggedRefs.length > 0);

      let finalPrompt = String(prompt ?? "");
      let genRefs: { path: string; tag: string }[] = [];
      let audit = "";
      let styleOut: { styleDesc: string; styleDescRefId?: string } | undefined;

      if (isAuthoredShape) {
        const stylePath = estiloRef ? writeTmp(estiloRef.src, "estilo") : undefined;
        const layoutPath = layoutRef ? writeTmp(layoutRef.src, "layout") : undefined;
        // INVALIDAÇÃO: o styleDesc cacheado só vale se veio DESTA imagem de estilo.
        let idt = (identity ?? { refs: [] }) as FlowIdentity;
        if (idt.styleDesc && idt.styleDescRefId !== estiloRef?.id) idt = { ...idt, styleDesc: undefined, styleDescRefId: undefined };
        const r = await authorDesignPrompt({
          texto: String(texto ?? ""), delta: String(delta ?? prompt ?? ""),
          layoutPath, stylePath, identityBlock: identityToPrompt(idt), aspectRatio: String(aspect) as FlowAspect, signal,
        });
        finalPrompt = r.prompt;
        // as imagens QUE EXISTEM: layout 1º, estilo 2º (a ordem que o autor referencia).
        genRefs = [layoutPath ? { path: layoutPath, tag: "layout" } : null, stylePath ? { path: stylePath, tag: "estilo" } : null]
          .filter((x): x is { path: string; tag: string } => !!x);
        // PERSISTÊNCIA: devolve o styleDesc novo (+ chave) só quando o derivou (1ª vez, e há estilo).
        if (r.styleDesc && !idt.styleDesc && estiloRef) styleOut = { styleDesc: r.styleDesc, styleDescRefId: estiloRef.id };
        audit = `source: ${r.source}\nmotivo: ${r.motivoFallback ?? ""}\ntentativas: ${r.tentativas}\npalavras: ${r.wordCount}\nstyleDesc: ${(r.styleDesc ?? "").replace(/\n/g, " ")}\n---\n`;
        console.log(`[FLOW] design-chat ${phraseId}: AUTOR source=${r.source} (${r.wordCount}p, ${r.tentativas}t)`);
      } else {
        // CHAT ANTIGO (verbatim): prompt do usuário + imagens da conversa. É "raw" — sem autor.
        const imgs: string[] = (Array.isArray(images) ? images : []).filter((s: string) => typeof s === "string" && s.startsWith("data:"));
        genRefs = imgs.map((src, i) => ({ path: writeTmp(src, `img-${i}`)!, tag: "chat" })).filter((r) => r.path);
        audit = `source: raw\nmotivo: chat verbatim (sem autor)\ntentativas: 0\npalavras: ${String(finalPrompt).trim().split(/\s+/).filter(Boolean).length}\n---\n`;
        console.log(`[FLOW] design-chat ${phraseId}: ${genRefs.length} imagem(ns), chat verbatim (source=raw)`);
      }

      const { imageUrl } = await getImageProvider().generate({ prompt: finalPrompt, aspectRatio: String(aspect), references: genRefs, count: 1, signal, chatgptStyle: true });
      await saveImageFit(imageUrl, asset.fsPath, w, h, signal, getImageProvider());
      fs.writeFileSync(asset.fsPath + ".prompt.txt", audit + finalPrompt);
      fs.rm(tmpDir, { recursive: true, force: true }, () => {});
      return { imagePath: asset.url, ...(styleOut ?? {}) };
    });
    res.json({ jobId });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

/**
 * GERAR DESIGN (fluxo NOVO — R2 do rebuild). A interface manda 2 slots (layout+estilo) + prompt
 * (delta) + cores (COLOR LAW, 1 campo). O Claude-autor vê as 2 imagens e escreve o prompt; ele +
 * as MESMAS imagens vão ao GPT-5 (Responses), que VÊ as imagens e gera pelo gpt-image; o outpaint
 * completa as bordas. Sem identidade de projeto, sem chat, sem tags. authorDesignPrompt decide
 * claude vs raw (flag FLOW_PROMPT_AUTHOR, ou sem estilo → raw). Job assíncrono, cancelável.
 */
app.post("/api/flow/gerar-design", (req, res) => {
  try {
    const { projectId, phraseId, texto = "", layout, estilo, prompt = "", cores = "", aspect = "9:16", modo = "restyle", elementos = [] } = req.body ?? {};
    if (!projectId) { res.status(400).json({ error: "projectId ausente (salve o projeto antes de gerar)." }); return; }
    const { w, h } = aspectDims(String(aspect) as FlowAspect);
    const jobId = startFlowJob(async (job, signal) => {
      job.progress = 0.1;
      const file = `design-${phraseId}-${Date.now().toString(36)}.png`;
      const asset = flowAsset(String(projectId), file);
      const tmpDir = flowAsset(String(projectId), `.tmp-design-${phraseId}`).fsPath;
      fs.mkdirSync(tmpDir, { recursive: true });
      const writeTmp = (src: string | undefined, name: string): string | undefined => {
        const m = src?.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i);
        if (!m) return undefined;
        const ext = m[1].includes("jpeg") || m[1].includes("jpg") ? "jpg" : m[1].includes("webp") ? "webp" : "png";
        const p = path.join(tmpDir, `${name}.${ext}`);
        fs.writeFileSync(p, Buffer.from(m[2], "base64"));
        return p;
      };
      const layoutPath = writeTmp(layout, "layout");
      const stylePath = writeTmp(estilo, "estilo");
      // ELEMENTOS (referências secundárias, até 4): objetos que aparecem na tela replicados
      // fielmente (nota amassada, logo, produto…). Vão ao compilador E ao gerador, na MESMA
      // ordem (pós-layout/estilo) — o compilador os descreve pelo que são.
      const elementoPaths = (Array.isArray(elementos) ? elementos : []).slice(0, 4)
        .map((src: string, i: number) => writeTmp(String(src), `elemento-${i + 1}`))
        .filter((p): p is string => !!p);

      // AUTOR POR TAREFA (medido no ground truth da pasta vid/): COM layout pronto no slot →
      // COMPILADOR (prompt longo estruturado, preserva a composição elemento a elemento —
      // paridade ~ChatGPT). SEM layout → autor curto (compõe do estilo+delta). O prompt
      // compilado é denso de propósito: restyle precisa de densidade; o teto curto (60/120)
      // vale só para compor-de-esboço. FLOW_PROMPT_AUTHOR=raw desativa os dois (fallback cru).
      let promptFinal: string, fonte: string, palavras: number, auditExtra = "";
      const usarCompilador = layoutPath && (process.env.FLOW_PROMPT_AUTHOR ?? "claude") === "claude";
      if (usarCompilador) {
        const c = await compileImagePrompt({
          layoutPath, stylePath, briefing: String(prompt), texto: String(texto), cores: String(cores),
          modo: modo === "esboco" ? "esboco" : "restyle", elementoPaths, signal,
        });
        if (c.source === "claude") {
          promptFinal = c.prompt; fonte = "compilador"; palavras = c.wordCount;
          auditExtra = `tentativas: ${c.tentativas}\n`;
        } else {
          // compilador falhou → autor curto segura (nunca quebra a geração)
          const r = await authorDesignPrompt({ texto: String(texto), delta: String(prompt), layoutPath, stylePath, identityBlock: colorLaw(String(cores)), aspectRatio: String(aspect) as FlowAspect, signal });
          promptFinal = r.prompt; fonte = `${r.source} (compilador falhou: ${c.motivoFallback})`; palavras = r.wordCount;
        }
      } else {
        const r = await authorDesignPrompt({
          texto: String(texto), delta: String(prompt), layoutPath, stylePath,
          identityBlock: colorLaw(String(cores)), aspectRatio: String(aspect) as FlowAspect, signal,
        });
        promptFinal = r.prompt; fonte = r.source; palavras = r.wordCount;
        auditExtra = `motivo: ${r.motivoFallback ?? ""}\ntentativas: ${r.tentativas}\n`;
      }

      const genRefs = [
        layoutPath ? { path: layoutPath, tag: "layout" } : null,
        stylePath ? { path: stylePath, tag: "estilo" } : null,
        ...elementoPaths.map((p, i) => ({ path: p, tag: `elemento-${i + 1}` })),
      ].filter((x): x is { path: string; tag: string } => !!x);
      const { imageUrl } = await getImageProvider().generate({ prompt: promptFinal, aspectRatio: String(aspect), references: genRefs, count: 1, signal, chatgptStyle: true });
      await saveImageFit(imageUrl, asset.fsPath, w, h, signal, getImageProvider());
      fs.writeFileSync(asset.fsPath + ".prompt.txt", `source: ${fonte}\npalavras: ${palavras}\n${auditExtra}---\n${promptFinal}`);
      fs.rm(tmpDir, { recursive: true, force: true }, () => {});
      console.log(`[FLOW] gerar-design ${phraseId}: source=${fonte} (${palavras}p)`);
      return { imagePath: asset.url, source: fonte, palavras };
    });
    res.json({ jobId });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

/**
 * CONCAT DO MOMENTO: junta os clipes (fitted) das frases de um momento num ÚNICO
 * vídeo contínuo — é ele que vai pra timeline (um popup por momento, não por frase).
 * Os fitted saem todos do timeFit com o MESMO encode/dimensões → concat re-encodado
 * simples e seguro. Devolve o caminho e a duração total.
 */
app.post("/api/flow/concat-moment", (req, res) => {
  try {
    const { projectId, momentId, videos = [] } = req.body ?? {};
    if (!projectId) { res.status(400).json({ error: "projectId ausente." }); return; }
    const list: string[] = (Array.isArray(videos) ? videos : []).filter((v: string) => typeof v === "string" && v.length > 0);
    if (!list.length) { res.status(400).json({ error: "nenhum vídeo para juntar." }); return; }
    const jobId = startFlowJob(async (_job, signal) => {
      const paths = list.map((u) => flowAsset(String(projectId), path.basename(new URL(u, "http://x").pathname)).fsPath);
      for (const p of paths) if (!fs.existsSync(p)) throw new Error(`clipe não encontrado: ${path.basename(p)} — gere/re-sincronize os vídeos antes.`);
      // NOME ESTÁVEL por momento (sem hash): a URL do popup nunca muda, então undo/save
      // nunca apontam pra um arquivo apagado. Sempre RE-GERA (os clipes podem ter mudado).
      const out = flowAsset(String(projectId), `moment-${String(momentId).replace(/[^a-z0-9_-]/gi, "")}.mp4`);
      const inputs = paths.flatMap((p) => ["-i", p]);
      const filter = paths.map((_, i) => `[${i}:v]`).join("") + `concat=n=${paths.length}:v=1:a=0[v]`;
      await runFfmpeg([
        "-y", ...inputs, "-filter_complex", filter, "-map", "[v]",
        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
        "-movflags", "+faststart", out.fsPath,
      ], signal, "flow-concat");
      const duration = await probeDuration(out.fsPath);
      console.log(`[FLOW] concat-moment ${momentId}: ${paths.length} clipes → ${duration.toFixed(2)}s`);
      return { videoPath: out.url, duration };
    });
    res.json({ jobId });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

/**
 * UPLOAD DE DESIGN PRONTO: o usuário sobe a própria arte (sem gerar por IA);
 * ajustamos pra proporção do vídeo e ela vira o design da frase, pronta pra animar.
 */
app.post("/api/flow/upload-design", async (req, res) => {
  try {
    const { projectId, phraseId, image, aspect = "9:16" } = req.body ?? {};
    if (!projectId) { res.status(400).json({ error: "projectId ausente (salve o projeto antes)." }); return; }
    if (!image?.startsWith("data:image/")) { res.status(400).json({ error: "imagem ausente ou inválida." }); return; }
    const { w, h } = aspectDims(String(aspect) as FlowAspect);
    const asset = flowAsset(String(projectId), `upload-${phraseId}-${Date.now().toString(36)}.png`);
    await saveImageFit(String(image), asset.fsPath, w, h, undefined, getImageProvider());
    console.log(`[FLOW] upload-design ${phraseId}: design próprio salvo (${w}x${h})`);
    res.json({ imagePath: asset.url });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

/** Design: gera a imagem de UMA frase (prompt + refs + proporção) → assets/flow/. */
app.post("/api/flow/design", (req, res) => {
  try {
    const { projectId, phraseId, prompt, aspect = "9:16", refs = [], seed = 0, identity } = req.body ?? {};
    if (!projectId) { res.status(400).json({ error: "projectId ausente (salve o projeto antes de gerar)." }); return; }
    if (!prompt?.trim()) { res.status(400).json({ error: "prompt de design ausente." }); return; }
    const { w, h } = aspectDims(String(aspect) as FlowAspect);
    const refList: { tag: string; src: string }[] = orderRefs(Array.isArray(refs) ? refs : []);
    // CINTO E SUSPENSÓRIO: se o prompt (velho/editado) não traz a identidade, o
    // servidor re-injeta as cores/escolhas no topo — as cores NUNCA se perdem.
    const identityBlock = identityToPrompt(identity as FlowIdentity | undefined);
    let finalPrompt = String(prompt).trim();
    if (identityBlock && !finalPrompt.includes("PROJECT IDENTITY")) {
      finalPrompt = `${identityBlock}\n\n${finalPrompt}`;
    }
    console.log(`[FLOW] design ${phraseId}: refs=[${refList.map((r) => r.tag).join(",")}] identidade=${identityBlock ? "SIM" : "não"} prompt=${finalPrompt.length} chars`);
    const jobId = startFlowJob(async (_job, signal) => {
      // cache por (prompt final + proporção + refs + semente). Nova semente = imagem nova.
      const hashKey = finalPrompt + aspect + refList.map((r) => r.tag + (r.src?.length ?? 0)).join(",") + ":seed" + seed;
      const file = `img-${phraseId}-${flowHash(hashKey)}.png`;
      const asset = flowAsset(String(projectId), file);
      if (!fs.existsSync(asset.fsPath)) {
        // grava as refs (data URL) em arquivos temporários pra passar ao provider
        const tmpDir = flowAsset(String(projectId), `.tmp-${phraseId}`).fsPath;
        fs.mkdirSync(tmpDir, { recursive: true });
        const refPaths: { path: string; tag: string }[] = [];
        let i = 0;
        for (const r of refList) {
          if (!r.src?.startsWith("data:")) continue;
          // preserva o formato real (jpeg/webp/png) — o gpt-image rejeita mime trocado
          const m = r.src.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i);
          const mime = (m?.[1] ?? "image/png").toLowerCase();
          const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
          const p = path.join(tmpDir, `ref-${i}.${ext}`);
          fs.writeFileSync(p, Buffer.from(m?.[2] ?? r.src.split(",")[1] ?? "", "base64"));
          refPaths.push({ path: p, tag: r.tag });
          i++;
        }
        console.log(`[FLOW] design frase ${phraseId}: ${refPaths.length} imagem(ns) de referência → ${refPaths.length ? "edits (usando as imagens)" : "generations (só prompt)"}`);
        // gera N variações numa chamada — o gpt-image oscila; o usuário escolhe a boa.
        const count = Math.max(1, Math.min(4, Number(process.env.FLOW_DESIGN_VARIATIONS ?? 3)));
        const { imageUrls, imageUrl } = await getImageProvider().generate({ prompt: finalPrompt, aspectRatio: String(aspect), references: refPaths, count });
        const urls = imageUrls?.length ? imageUrls : [imageUrl];
        for (let i = 0; i < urls.length; i++) {
          const p = i === 0 ? asset.fsPath : flowAsset(String(projectId), file.replace(/\.png$/, `-v${i}.png`)).fsPath;
          await saveImageFit(urls[i], p, w, h, signal, getImageProvider());
        }
        fs.rm(tmpDir, { recursive: true, force: true }, () => {});
        // auditoria: grava o prompt final + tags enviadas ao lado da imagem
        fs.writeFileSync(asset.fsPath + ".prompt.txt", `refs: ${refList.map((r) => r.tag).join(", ")}\n\n${finalPrompt}`);
      }
      // lista as variações existentes (v0 = arquivo base)
      const options = [asset.url];
      for (let i = 1; i < 4; i++) {
        const vf = file.replace(/\.png$/, `-v${i}.png`);
        if (fs.existsSync(flowAsset(String(projectId), vf).fsPath)) options.push(flowAsset(String(projectId), vf).url);
      }
      return { imagePath: asset.url, imageOptions: options, designPrompt: prompt };
    });
    res.json({ jobId });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

/** Prompt de motion (síncrono): Claude converte o pedido do usuário em prompt técnico. */
app.post("/api/flow/motion-prompt", async (req, res) => {
  try {
    const { texto = "", presetId, pedido = "", duracaoAlvo = 0, modo } = req.body ?? {};
    const preset = getFlowPreset(presetId);
    const motionModelPrompt = await buildMotionPrompt({ texto: String(texto), presetNome: preset?.nome, pedido: String(pedido), duracaoAlvo: Number(duracaoAlvo), modo: modo === "transicao" ? "transicao" : "entrada" });
    res.json({ motionModelPrompt });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

/** Animação: gera o vídeo da frase + time-fit → assets/flow/. */
app.post("/api/flow/animate", (req, res) => {
  try {
    const { projectId, phraseId, image, prevImage, motionModelPrompt, targetDuration, aspect = "9:16", minDuration = 0, localText = false, regenNonce } = req.body ?? {};
    if (!projectId) { res.status(400).json({ error: "projectId ausente (salve o projeto antes de gerar)." }); return; }
    if (!image || !motionModelPrompt?.trim() || !(targetDuration > 0)) { res.status(400).json({ error: "Faltam image, motionModelPrompt ou targetDuration." }); return; }
    const { w, h } = aspectDims(String(aspect) as FlowAspect);
    const jobId = startFlowJob(async (job, signal) => {
      const imgLocal = flowAsset(String(projectId), path.basename(new URL(String(image), "http://x").pathname)).fsPath;
      if (!fs.existsSync(imgLocal)) throw new Error("Imagem base não encontrada — gere/aprove o design antes de animar.");
      // ANIMAÇÃO CONTÍNUA (MotionIA §4.1): prevImage = design da frase ANTERIOR →
      // vira o START frame deste clipe; o END é o design desta frase. Emenda invisível.
      const prevLocal = prevImage ? flowAsset(String(projectId), path.basename(new URL(String(prevImage), "http://x").pathname)).fsPath : null;
      if (prevImage && (!prevLocal || !fs.existsSync(prevLocal))) throw new Error("Design anterior não encontrado — aprove o design da frase anterior primeiro.");
      const provider = getVideoProvider();
      const continua = !!prevLocal;
      // ENTRADA LOCAL: compõe a animação no ffmpeg a partir do PNG real — texto perfeito,
      // sem IA. Forçado quando o momento é modo "texto" (localText), ou global via
      // FLOW_AI_ENTRANCE!=true. Modelo de vídeo (Seedance) só quando NENHUM desses.
      const localEntrance = !continua && !provider.needsReverse && (localText === true || process.env.FLOW_AI_ENTRANCE !== "true");
      const engine = localEntrance ? "local" : provider.name;
      // Cache por (engine, IMAGEM, prompt, encadeamento). A imagem base SEMPRE entra na
      // chave — trocar o design (mesmo prompt) regenera o motion a partir da NOVA imagem.
      // No contínuo já entram os DOIS designs (A e B); no simples, entra a imagem desta frase.
      const chainKey = continua
        ? ":cont:" + path.basename(prevLocal!) + ":" + path.basename(imgLocal)
        : ":img:" + path.basename(imgLocal);
      // "Regerar" explícito (regenNonce) força um take novo do modelo mesmo com imagem+prompt iguais.
      const regenKey = regenNonce ? ":r:" + String(regenNonce) : "";
      const rawFile = `raw-${phraseId}-${flowHash(engine + ":" + motionModelPrompt + chainKey + regenKey)}.mp4`;
      const raw = flowAsset(String(projectId), rawFile);
      if (!fs.existsSync(raw.fsPath)) { // cache por (engine, imagem, prompt, encadeamento)
        job.progress = 0.1;
        if (localEntrance) {
          // texto perfeito: anima o design real (sobe + fade) via ffmpeg, sem IA.
          await renderEntranceClip(imgLocal, raw.fsPath, w, h, Math.max(Number(minDuration) || 0, Number(targetDuration)), signal);
        } else if (continua) {
          // TRANSIÇÃO CONTÍNUA: a VISÃO analisa os dois frames (A=anterior, B=atual) e
          // monta o prompt de movimento; start = A, end = B (start→end frame). Sem inversão.
          const transPrompt = await buildTransitionPrompt(prevLocal!, imgLocal, signal);
          await provider.generate({ imagePath: prevLocal!, lastFramePath: imgLocal, prompt: transPrompt, aspectRatio: String(aspect), durationHint: Number(targetDuration) }, raw.fsPath, signal);
        } else if (provider.needsReverse) {
          // Veo: design = FRAME ÂNCORA (1º frame); anima a SAÍDA; o time-fit inverte → ENTRADA.
          await provider.generate({ imagePath: imgLocal, prompt: motionModelPrompt, aspectRatio: String(aspect), durationHint: Number(targetDuration) }, raw.fsPath, signal);
        } else {
          // Seedance 2.0 (IA): START = fundo VAZIO (cor do design) → END = design. O modelo
          // interpola a ENTRADA dos elementos (coreografia do MOTION_SPEC_ENTRANCE).
          const startFrame = flowAsset(String(projectId), `start-${phraseId}-${flowHash(rawFile + ":empty")}.png`).fsPath;
          await makeStartFrame(imgLocal, startFrame, w, h, signal);
          await provider.generate({ imagePath: startFrame, lastFramePath: imgLocal, prompt: motionModelPrompt, aspectRatio: String(aspect), durationHint: Number(targetDuration) }, raw.fsPath, signal);
        }
      }
      job.progress = 0.8;
      // Com inversão (Veo solto) ou direto; o trim mantém a cauda (desfecho na imagem).
      const rev = continua ? false : provider.needsReverse;
      const dir = rev ? "rev" : "fwd";
      const minDur = Number(minDuration) || 0;
      const fitFile = `fit-${phraseId}-${flowHash(rawFile + ":" + targetDuration + ":" + aspect + ":" + dir + ":min" + minDur)}.mp4`;
      const fit = flowAsset(String(projectId), fitFile);
      const { fitInfo } = await timeFit(raw.fsPath, Number(targetDuration), fit.fsPath, { w, h }, signal, { reverse: rev, minDuration: minDur });
      return { videoPath: raw.url, fittedVideoPath: fit.url, fitInfo };
    });
    res.json({ jobId });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

/** Re-sincroniza: refaz SÓ o time-fit (mudaram os cortes → targetDuration). Sem API. */
app.post("/api/flow/refit", (req, res) => {
  try {
    const { projectId, phraseId, rawVideo, targetDuration, aspect = "9:16", minDuration = 0 } = req.body ?? {};
    if (!projectId || !rawVideo || !(targetDuration > 0)) { res.status(400).json({ error: "Faltam projectId, rawVideo ou targetDuration." }); return; }
    const { w, h } = aspectDims(String(aspect) as FlowAspect);
    const minDur = Number(minDuration) || 0;
    const jobId = startFlowJob(async (_job, signal) => {
      const rawLocal = flowAsset(String(projectId), path.basename(new URL(String(rawVideo), "http://x").pathname)).fsPath;
      if (!fs.existsSync(rawLocal)) throw new Error("Vídeo bruto não encontrado — gere o vídeo antes de re-sincronizar.");
      const rev = getVideoProvider().needsReverse;
      const fitFile = `fit-${phraseId}-${flowHash(path.basename(rawLocal) + ":" + targetDuration + ":" + aspect + ":" + (rev ? "rev" : "fwd") + ":min" + minDur)}.mp4`;
      const fit = flowAsset(String(projectId), fitFile);
      const { fitInfo } = await timeFit(rawLocal, Number(targetDuration), fit.fsPath, { w, h }, signal, { reverse: rev, minDuration: minDur });
      return { fittedVideoPath: fit.url, fitInfo };
    });
    res.json({ jobId });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// ───────────────────────── PROJETOS ─────────────────────
// Mapeia erros de projeto para status + mensagem legível (PT-BR).
function projErr(res: express.Response, e: unknown) {
  // Conflito de versao (outra sessao salvou por cima): 409 + a versao atual do servidor,
  // pro front decidir (recarregar). NAO e' erro do usuario — e' guarda anti-perda-de-trabalho.
  if (e instanceof ProjectConflictError) {
    res.status(409).json({ error: e.message, code: "CONFLICT", updatedAt: e.serverUpdatedAt });
    return;
  }
  const msg = (e as Error).message ?? "Erro no projeto";
  const notFound = e instanceof ProjectError && /não encontrado/i.test(msg);
  res.status(notFound ? 404 : 400).json({ error: msg });
}

app.get("/api/projects", (_req, res) => {
  try { res.json(listMetas()); } catch (e) { projErr(res, e); }
});

app.post("/api/projects", (req, res) => {
  try {
    const { name, document } = req.body ?? {};
    if (!document) { res.status(400).json({ error: "Documento inicial ausente." }); return; }
    res.json(createProject(name ?? "Sem nome", document));
  } catch (e) { projErr(res, e); }
});

app.get("/api/projects/:id", (req, res) => {
  try { res.json(readProject(req.params.id)); } catch (e) { projErr(res, e); }
});

app.put("/api/projects/:id", (req, res) => {
  try {
    const { document, baseUpdatedAt } = req.body ?? {};
    if (!document) { res.status(400).json({ error: "Documento ausente." }); return; }
    res.json(saveProject(req.params.id, document, baseUpdatedAt));
  } catch (e) { projErr(res, e); }
});

app.patch("/api/projects/:id", (req, res) => {
  try {
    const { name } = req.body ?? {};
    if (!name?.trim()) { res.status(400).json({ error: "Nome inválido." }); return; }
    res.json(renameProject(req.params.id, name.trim()));
  } catch (e) { projErr(res, e); }
});

app.delete("/api/projects/:id", (req, res) => {
  try { deleteProject(req.params.id); res.json({ ok: true }); } catch (e) { projErr(res, e); }
});

// TODO: /api/design  -> providers/getImageProvider()
// TODO: /api/motion  -> Seedance

// PRODUCAO: serve o front buildado (frontend/dist) na MESMA porta da API — servico UNICO,
// igual ao AgenteVIDEOMAKER. Sob o proxy nginx do subpath (/agente-video/studio/ -> esta
// porta), o studio (SPA) e a API saem da mesma origem, entao o nginx precisa de UMA location
// so. So ativa se o build existir (em dev o Vite serve o front em :5174 -> inerte aqui).
// Registrado DEPOIS de todas as rotas: o fallback SPA so pega o que sobra, e exclui as rotas
// do backend (/api, /uploads, /projects, /jobs, /health) pra nao devolver index.html no lugar.
{
  const frontDist = path.resolve("..", "frontend", "dist");
  if (fs.existsSync(path.join(frontDist, "index.html"))) {
    app.use(express.static(frontDist));
    app.get(/^(?!\/(api|uploads|projects|jobs|health)(\/|$)).*/, (_req, res) =>
      res.sendFile(path.join(frontDist, "index.html")),
    );
    console.log("[server] front buildado servido de frontend/dist (servico unico)");
  }
}

const server = app.listen(PORT, () => {
  console.log(`backend ouvindo em http://localhost:${PORT}`);
});

// Porta ocupada (provável instância órfã): mensagem clara e sai com código != 0.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n[BOOT] Porta ${PORT} já está em uso — provavelmente há outro backend rodando (órfão).\n` +
      `       Rode "npm run dev" de novo (o script libera a porta), ou mate o processo manualmente.\n`,
    );
    process.exit(1);
  }
  throw err;
});
