import fs from "node:fs";
import { registraExecutor } from "./queue.js";
import { readProject, assetFsPath } from "../projects/store.js";

// Executores dos jobs que o OS enfileira (AGENTE-VIDEO-SERVICE.md secao 5).
//
// O DESIGN, que nao era obvio:
//   O POST /api/render do studio recebe o video por multipart (o navegador manda o arquivo).
//   O POST /jobs do OS e' JSON — nao carrega arquivo. Entao COMO um job de render acha o
//   video?
//
//   Resposta: ele NAO recebe o video, ele recebe o `projeto_id`. O video ja esta no disco do
//   servico, em projects/<id>/assets/, e `document.sourceVideo` guarda o nome do arquivo
//   (o store move o asset de uploads/ pra la ao salvar). `assetFsPath(id, nome)` resolve.
//
//   Isso tem uma consequencia que vale registrar: **um job do OS so existe pra projeto ja
//   salvo**. Nao da pra o OS mandar renderizar um upload avulso — e nem faz sentido, porque
//   o vinculo com cliente/projeto e' justamente o que o OS quer rastrear.
//
// Cada executor recebe onProgress (0..100) e um signal de abort. O signal NAO e' decorativo:
// e' o que faz o cancelamento realmente matar o ffmpeg em vez de so mentir na UI.

export interface RenderArgs {
  projeto_id?: string;
  props?: Record<string, unknown>;
}

/**
 * Registra os executores. Chamado uma vez no boot do server.
 *
 * `render` recebe o renderFn de fora (injecao) pra este modulo nao importar o server.ts —
 * a funcao runRender vive la, acoplada ao ffmpeg/Remotion, e importar de volta criaria
 * ciclo (server -> executors -> server).
 */
export function registraExecutores(renderFn: RenderJobFn): void {
  registraExecutor("render", async (args, { onProgress, signal }) => {
    const a = args as RenderArgs;
    if (!a.projeto_id) throw new Error("render exige projeto_id (o video vem do projeto salvo)");

    // Le o projeto: valida que existe E resolve o video fonte. Falha aqui e' erro do job,
    // nao do servico — o OS mostra a mensagem pro usuario.
    const pf = readProject(a.projeto_id);
    const src = pf.document.sourceVideo;
    if (!src || typeof src !== "string") {
      throw new Error(`projeto ${a.projeto_id} nao tem video fonte (sourceVideo vazio)`);
    }
    // hydrateAssets devolve URL servida ("/projects/<id>/assets/<arq>"); o ffmpeg precisa do
    // CAMINHO no disco. Pega so o nome do arquivo e resolve.
    const nome = src.replace(/.*\//, "");
    const videoPath = assetFsPath(a.projeto_id, nome);
    if (!fs.existsSync(videoPath)) {
      throw new Error(`video do projeto nao encontrado no disco: ${nome}`);
    }

    const outPath = await renderFn({
      projetoId: a.projeto_id,
      videoPath,
      props: a.props ?? {},
      onProgress,
      signal,
    });

    return {
      output_path: outPath,
      result_data: { projeto_id: a.projeto_id, duracao_seg: pf.document.durationSec ?? null },
      // render e' CPU pura: nao chama LLM, entao nao tem usage de token. Devolver null e'
      // honesto — o polling do OS so loga telemetria de custo quando ha usage de verdade.
      usage: null,
    };
  });
}

export interface RenderJobInput {
  projetoId: string;
  videoPath: string;
  props: Record<string, unknown>;
  onProgress: (pct: number) => void;
  signal: AbortSignal;
}

/** Assinatura do render injetado pelo server.ts. Devolve o caminho do MP4 final. */
export type RenderJobFn = (input: RenderJobInput) => Promise<string>;
