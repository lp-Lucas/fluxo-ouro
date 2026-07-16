/**
 * Sistema de projetos — schema + versionamento (fonte da verdade).
 *
 * Um PROJETO = documento do editor (JSON) + referências aos assets (vídeo fonte,
 * imagens de popup, LUT). Persistido no backend em projects/<id>/.
 * O histórico de undo/redo NÃO é persistido — só o documento atual.
 */

import type { TranscriptSegment, Cut, Zoom, Popup } from "./timeline";
import type { CaptionStyle } from "./captionStyle";
import type { ColorSettings } from "./color";
import type { ChromaSettings } from "./chroma";
import { DEFAULT_CHROMA } from "./chroma";
import type { FlowState } from "./flow";
import type { Music } from "./timeline";

/** Versão atual do schema de projeto. Incrementar a cada mudança que exija migração. */
export const SCHEMA_VERSION = 4; // v4: adiciona `music` (música de fundo) — opcional

/**
 * Documento do editor (estado persistido). As referências de asset são strings:
 *  - sourceVideo: nome do vídeo fonte em projects/<id>/assets/
 *  - popups[].content.imageUrl/logoUrl, color.lut.file: idem (resolvidos no render)
 */
export interface EditorDocument {
  sourceVideo: string;   // referência do vídeo fonte (asset)
  durationSec: number;
  width: number;
  height: number;
  transcript: TranscriptSegment[];
  cuts: Cut[];
  zooms: Zoom[];
  popups: Popup[];
  captionStyle: CaptionStyle;
  color: ColorSettings;
  chroma: ChromaSettings;
  /** FLOW — motion design por IA. Opcional (ausente em projetos sem FLOW). */
  flow?: FlowState;
  /** Música de fundo. Opcional. */
  music?: Music;
  copy: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;   // epoch ms
  updatedAt: number;   // epoch ms
  schemaVersion: number;
  thumbnail?: string;  // nome do arquivo de thumb (thumb.jpg)
}

export interface ProjectFile {
  meta: ProjectMeta;
  document: EditorDocument;
}

/** Erros de projeto com mensagem legível (PT-BR). */
export class ProjectError extends Error {}

/**
 * Valida e MIGRA um projeto lido do disco para a versão atual.
 * - Rejeita versão futura (nunca abrir silenciosamente perdendo dados).
 * - Migração por switch de versão (cada passo documentado em PT-BR).
 * Todo `open` passa por aqui.
 */
export function migrateProject(raw: unknown): ProjectFile {
  if (!raw || typeof raw !== "object") {
    throw new ProjectError("Projeto inválido: o conteúdo não é um objeto JSON.");
  }
  const obj = raw as Record<string, unknown>;
  const meta = obj.meta as Partial<ProjectMeta> | undefined;
  if (!meta || typeof meta.schemaVersion !== "number") {
    throw new ProjectError("Projeto inválido: metadados ou versão do schema ausentes.");
  }
  if (!obj.document || typeof obj.document !== "object") {
    throw new ProjectError("Projeto inválido: documento do editor ausente.");
  }

  let file = obj as unknown as ProjectFile;
  let v = meta.schemaVersion;

  if (v > SCHEMA_VERSION) {
    throw new ProjectError(
      `Este projeto foi criado numa versão mais nova do editor (schema ${v}) ` +
      `que a suportada aqui (${SCHEMA_VERSION}). Atualize o editor para abri-lo.`,
    );
  }

  // Migrações incrementais (v atual → v+1). Adicionar casos conforme evoluir.
  while (v < SCHEMA_VERSION) {
    switch (v) {
      case 1:
        // v1 → v2: adiciona `chroma` (chromakey) com o default (desligado).
        (file.document as { chroma?: ChromaSettings }).chroma ??= DEFAULT_CHROMA;
        v = 2;
        break;
      case 2:
        // v2 → v3: adiciona `flow` (FLOW). Ausente = undefined (sem quebra).
        (file.document as { flow?: FlowState }).flow ??= undefined;
        v = 3;
        break;
      case 3:
        // v3 → v4: adiciona `music` (música de fundo). Ausente = undefined.
        (file.document as { music?: Music }).music ??= undefined;
        v = 4;
        break;
      default:
        throw new ProjectError(`Não há migração definida a partir da versão ${v}.`);
    }
  }

  // Defensivo: garante `chroma` mesmo em docs v2 gerados antes do módulo (frontend
  // ainda pode não enviar chroma até a UI existir).
  (file.document as { chroma?: ChromaSettings }).chroma ??= DEFAULT_CHROMA;

  validarDocumento(file.document);
  file.meta.schemaVersion = SCHEMA_VERSION;
  return file;
}

/** Validação mínima do documento (campos essenciais). */
function validarDocumento(doc: unknown): void {
  if (!doc || typeof doc !== "object") throw new ProjectError("Documento do editor corrompido.");
  const d = doc as Record<string, unknown>;
  const faltando = (["sourceVideo", "transcript", "cuts", "zooms", "popups", "captionStyle", "color"] as const)
    .filter((k) => d[k] === undefined);
  if (faltando.length) {
    throw new ProjectError(`Documento do editor incompleto — campos faltando: ${faltando.join(", ")}.`);
  }
}

/** Cria um ProjectFile novo (vazio) para um vídeo recém-enviado. */
export function novoProjeto(id: string, name: string, doc: EditorDocument): ProjectFile {
  const agora = Date.now();
  return {
    meta: { id, name, createdAt: agora, updatedAt: agora, schemaVersion: SCHEMA_VERSION },
    document: doc,
  };
}
