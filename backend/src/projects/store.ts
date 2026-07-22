import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  migrateProject, novoProjeto, ProjectError,
  type ProjectFile, type ProjectMeta, type EditorDocument,
} from "../../../shared/project.js";

/**
 * Storage de projetos + ciclo de vida de assets.
 *
 * REGRA CENTRAL (resolve o conflito com a limpeza de 24h): a pasta projects/
 * NUNCA é limpa. Ao salvar, todo asset referenciado que está em uploads/ (área
 * temporária, limpa em 24h) é MOVIDO para projects/<id>/assets/ e a referência
 * no documento passa a ser o nome do arquivo (bare). uploads/ segue temporário.
 *
 * DECISÃO mover vs. copiar: MOVER. Na v1 não há compartilhamento de asset entre
 * projetos, então mover é seguro e não duplica arquivos grandes (vídeo).
 *
 * Convenção de referências:
 *  - Em DISCO (project.json): nome do arquivo (bare), ex: "video.mp4".
 *  - Ao LER (hydrate): vira URL servida "/projects/<id>/assets/<arquivo>".
 *  - Ao SALVAR (dehydrate): data URL → arquivo; URL/uploads → move; asset → mantém.
 */

const ROOT = path.resolve("projects");
const UPLOAD_DIR = path.resolve("uploads");
fs.mkdirSync(ROOT, { recursive: true });

const PORT = Number(process.env.PORT ?? 3001);
const projDir = (id: string) => path.join(ROOT, id);
const assetsDir = (id: string) => path.join(projDir(id), "assets");
const projJson = (id: string) => path.join(projDir(id), "project.json");
export const assetFsPath = (id: string, file: string) => path.join(assetsDir(id), file);
const assetUrl = (id: string, file: string) => `/projects/${id}/assets/${file}`;

// FLOW: assets em assets/flow/. Em DISCO ref = "flow/<arquivo>"; ao ler vira URL
// ABSOLUTA (o Remotion do export precisa de host; o navegador também aceita).
const flowBasename = (r: string) => r.replace(/.*\//, "");
const flowUrl = (id: string, file: string) => `http://localhost:${PORT}/projects/${id}/assets/flow/${file}`;
const isFlowRef = (r?: string) => !!r && (r.startsWith("flow/") || r.includes("/assets/flow/"));
const dehydrateFlowRef = (r?: string) => (isFlowRef(r) && !r!.startsWith("flow/") ? `flow/${flowBasename(r!)}` : r);
const hydrateFlowRef = (id: string, r?: string) => (r && r.startsWith("flow/") ? flowUrl(id, flowBasename(r)) : r);

/** Aplica um transform em todas as refs de asset do FLOW (flow state + popups fullscreen). */
function mapFlowRefs(doc: EditorDocument, fn: (r?: string) => string | undefined): void {
  const f = doc.flow;
  if (f) for (const m of f.moments) for (const ph of m.phrases) {
    ph.imagePath = fn(ph.imagePath); ph.videoPath = fn(ph.videoPath); ph.fittedVideoPath = fn(ph.fittedVideoPath);
    if (ph.imageOptions) ph.imageOptions = ph.imageOptions.map((o) => fn(o) ?? o);
    if (ph.designChat) for (const msg of ph.designChat) {
      if (msg.images) msg.images = msg.images.map((s) => fn(s) ?? s); // assistant = asset flow/; user = data URL (passa reto)
    }
  }
  for (const p of doc.popups) {
    if (p.type === "fullscreen" && p.media && isFlowRef(p.media.src)) p.media = { ...p.media, src: fn(p.media.src) ?? p.media.src };
  }
}

/**
 * Apaga arquivos em assets/flow/ que o documento (dehidratado) não referencia mais.
 * SÓ apaga órfãos com mais de 1h: arquivos de trabalho de jobs em andamento (start-*.png
 * do frame inicial, raw-/fit- recém-gerados ainda não gravados no doc) não podem ser
 * removidos por um autosave no meio da geração — era isso que quebrava o Higgsfield.
 */
function pruneFlowAssets(id: string, doc: EditorDocument): void {
  const dir = assetFsPath(id, "flow");
  if (!fs.existsSync(dir)) return;
  const referidos = new Set<string>();
  mapFlowRefs(doc, (r) => { if (r?.startsWith("flow/")) referidos.add(flowBasename(r)); return r; });
  // Janela LONGA (14 dias): undo/redo pode reapontar pra um asset gerado dias atrás —
  // apagar cedo demais causava 404 no render (o popup referenciava um arquivo já podado).
  const limite = Date.now() - 14 * 24 * 60 * 60 * 1000;
  for (const f of fs.readdirSync(dir)) {
    if (referidos.has(f)) continue;
    // NUNCA apaga os `raw-` automaticamente: são a saída do Seedance (custam créditos)
    // e são a fonte pra re-encaixar/re-concatenar. Perdê-los = ter que gerar de novo.
    if (f.startsWith("raw-")) continue;
    try {
      const fp = path.join(dir, f);
      if (fs.statSync(fp).mtimeMs < limite) fs.rmSync(fp, { force: true });
    } catch { /* ignora */ }
  }
}

/** Escrita atômica: grava em .tmp e renomeia (nunca corrompe se morrer no meio). */
function atomicWriteJson(file: string, obj: unknown) {
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// ───────────────────────── assets (dehydrate / hydrate) ─────────────────────

/** Extrai o nome do arquivo de uma referência (URL /uploads, /projects, ou bare). */
function refFilename(ref: string): string {
  const m = ref.match(/\/([^/]+)$/);
  return m ? m[1] : ref;
}

/**
 * Converte uma referência de asset para o formato de DISCO (bare filename),
 * movendo o arquivo para assets/ quando necessário.
 */
function dehydrateRef(id: string, ref: string | undefined): string | undefined {
  if (!ref) return ref;
  if (ref.startsWith("data:")) return ref; // imagens de popup ficam como data URL

  const file = refFilename(ref);
  const dst = assetFsPath(id, file);
  if (fs.existsSync(dst)) return file; // já é asset do projeto

  // procura em uploads/ e move
  const fromUpload = path.join(UPLOAD_DIR, file);
  if (fs.existsSync(fromUpload)) {
    fs.mkdirSync(assetsDir(id), { recursive: true });
    fs.renameSync(fromUpload, dst);
    return file;
  }
  // não achou o arquivo — mantém o nome (pode já ter sido movido antes)
  return file;
}

/**
 * Dehidrata as refs de asset baseadas em ARQUIVO (vídeo fonte + .cube), movendo-as
 * de uploads/ para assets/. As imagens de popup ficam como DATA URL no documento
 * (o export já as externaliza), então não são tocadas aqui — evita re-hidratação.
 */
function dehydrateAssets(id: string, doc: EditorDocument): EditorDocument {
  fs.mkdirSync(assetsDir(id), { recursive: true });
  const d: EditorDocument = structuredClone(doc);
  d.sourceVideo = dehydrateRef(id, d.sourceVideo) ?? "";
  if (d.color?.lut?.file) d.color.lut.file = dehydrateRef(id, d.color.lut.file) ?? null;
  if (d.music?.file) d.music.file = dehydrateRef(id, d.music.file) ?? d.music.file;
  mapFlowRefs(d, dehydrateFlowRef); // FLOW: URL absoluta → "flow/<arquivo>"
  return d;
}

/** Converte as refs de arquivo (bare) para URLs servidas — vídeo, .cube, música e FLOW. */
function hydrateAssets(id: string, doc: EditorDocument): EditorDocument {
  const d: EditorDocument = structuredClone(doc);
  if (d.sourceVideo) d.sourceVideo = assetUrl(id, d.sourceVideo);
  if (d.color?.lut?.file) d.color.lut.file = assetUrl(id, d.color.lut.file);
  if (d.music?.file) d.music.file = assetUrl(id, d.music.file);
  mapFlowRefs(d, (r) => hydrateFlowRef(id, r)); // FLOW: "flow/<arquivo>" → URL absoluta
  return d;
}

// ───────────────────────── thumbnail ─────────────────────

/** Extrai 1 frame (~10% da duração), 320px, para thumb.jpg. Falha NÃO quebra o save. */
function gerarThumbnail(id: string, videoFile: string, durationSec: number) {
  const src = assetFsPath(id, videoFile);
  if (!fs.existsSync(src)) return;
  const t = Math.max(0, (durationSec || 1) * 0.1);
  const proc = spawn("ffmpeg", ["-y", "-ss", String(t), "-i", src,
    "-frames:v", "1", "-vf", "scale=320:-1", path.join(projDir(id), "thumb.jpg")]);
  proc.on("error", (e) => console.error(`[PROJECTS] thumb falhou (${id}):`, e.message));
}

// ───────────────────────── API do store ─────────────────────

export function listMetas(): ProjectMeta[] {
  const metas: ProjectMeta[] = [];
  for (const id of fs.readdirSync(ROOT)) {
    const f = projJson(id);
    if (!fs.existsSync(f)) continue;
    try {
      const pf = JSON.parse(fs.readFileSync(f, "utf8")) as ProjectFile;
      if (pf.meta) metas.push(pf.meta);
    } catch { /* projeto corrompido — ignora na listagem */ }
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Lê e MIGRA o projeto; hidrata as refs de asset para URLs servidas. */
export function readProject(id: string): ProjectFile {
  const f = projJson(id);
  if (!fs.existsSync(f)) throw new ProjectError("Projeto não encontrado.");
  const pf = migrateProject(JSON.parse(fs.readFileSync(f, "utf8")));
  pf.document = hydrateAssets(id, pf.document);
  return pf;
}

export function createProject(name: string, doc: EditorDocument): ProjectFile {
  const id = crypto.randomUUID();
  fs.mkdirSync(assetsDir(id), { recursive: true });
  const moved = dehydrateAssets(id, doc);
  pruneFlowAssets(id, moved); // remove gerações órfãs do FLOW
  const pf = novoProjeto(id, name || "Sem nome", moved);
  atomicWriteJson(projJson(id), pf);
  if (moved.sourceVideo) gerarThumbnail(id, moved.sourceVideo, moved.durationSec);
  return { ...pf, document: hydrateAssets(id, moved) };
}

/** Save recusado porque o projeto ja tem uma versao mais nova (outra sessao/computador salvou). */
export class ProjectConflictError extends Error {
  readonly serverUpdatedAt: number;
  constructor(serverUpdatedAt: number) {
    super("O projeto foi alterado em outra sessão. Recarregue para pegar a versão mais recente.");
    this.name = "ProjectConflictError";
    this.serverUpdatedAt = serverUpdatedAt;
  }
}

export function saveProject(id: string, doc: EditorDocument, baseUpdatedAt?: number): ProjectFile {
  const f = projJson(id);
  if (!fs.existsSync(f)) throw new ProjectError("Projeto não encontrado.");
  const antigo = JSON.parse(fs.readFileSync(f, "utf8")) as ProjectFile;
  // TRAVA DE CONCORRENCIA (last-write-wins seguro): se quem salva carregou uma versao mais
  // ANTIGA que a do disco, alguem salvou no meio — recusa em vez de sobrescrever (senao a
  // geracao/edicao do outro sumia). O front trata o 409: recarrega a versao nova.
  if (typeof baseUpdatedAt === "number" && antigo.meta.updatedAt > baseUpdatedAt) {
    throw new ProjectConflictError(antigo.meta.updatedAt);
  }
  const moved = dehydrateAssets(id, doc);
  pruneFlowAssets(id, moved); // remove gerações órfãs do FLOW
  const pf: ProjectFile = {
    meta: { ...antigo.meta, updatedAt: Date.now() },
    document: moved,
  };
  atomicWriteJson(f, pf);
  if (moved.sourceVideo) gerarThumbnail(id, moved.sourceVideo, moved.durationSec);
  return { ...pf, document: hydrateAssets(id, moved) };
}

export function renameProject(id: string, name: string): ProjectMeta {
  const f = projJson(id);
  if (!fs.existsSync(f)) throw new ProjectError("Projeto não encontrado.");
  const pf = JSON.parse(fs.readFileSync(f, "utf8")) as ProjectFile;
  pf.meta.name = name;
  pf.meta.updatedAt = Date.now();
  atomicWriteJson(f, pf);
  return pf.meta;
}

export function deleteProject(id: string): void {
  const dir = projDir(id);
  if (!fs.existsSync(dir)) throw new ProjectError("Projeto não encontrado.");
  fs.rmSync(dir, { recursive: true, force: true });
}

export const PROJECTS_ROOT = ROOT;
