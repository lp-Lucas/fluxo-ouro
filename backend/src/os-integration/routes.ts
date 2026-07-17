import { Router } from "express";
// sufixo .js obrigatorio: o build (tsc -> dist/) roda em Node ESM puro, que exige a
// extensao. Sem ela `npm run start` quebra em producao, mesmo o `tsx` do dev funcionando
// (moduleResolution: Bundler). Convencao do resto do backend.
import { exigeServiceToken } from "./auth.js";
import { enfileira, buscaJob, cancela, tiposSuportados, statusFila, type JobTipo } from "./queue.js";

// Contrato /jobs que o OS consome. Docs (monorepo do OS):
// Operacional-BlueOcean/docs/AGENTE-VIDEO-SERVICE.md secao 5.
//
//   GET  /health          -> { tipos: [...] }   (sem auth: e o probe do OS/nginx)
//   POST /jobs            -> { job_id, status }
//   GET  /jobs/:id        -> { job_id, tipo, status, progresso, result?, usage?, error? }
//   POST /jobs/:id/cancel -> { ok: true }
//
// Espelha 1:1 o lib/video/service.ts do OS. Estas rotas sao IRMAS das /api/* existentes do
// studio — nao as tocam. As /api/* seguem servindo o app no navegador; estas servem o OS.

export const osRouter = Router();

/**
 * Probe. SEM auth de proposito: o OS chama antes de ter contexto (o `tiposDoServico()` roda
 * no enqueue) e o nginx usa como healthcheck. Nao expoe nada sensivel — so quais tipos o
 * servico sabe rodar e a ocupacao da fila.
 */
osRouter.get("/health", (_req, res) => {
  res.json({ ok: true, service: "fluxo-ouro-service", tipos: tiposSuportados(), fila: statusFila() });
});

// Auth SO no /jobs — e o path tem que estar aqui.
// ARMADILHA (quebrou o studio uma vez): `osRouter.use(exigeServiceToken)` SEM path roda em
// TODA requisicao que entra no router. Como ele e montado na raiz (`app.use(osRouter)`),
// isso passou a exigir Bearer ate no /api/projects do studio -> 401 em tudo. Com o path,
// so /jobs* passa pelo gate; o resto segue pras rotas /api/* do studio intocado.
osRouter.use("/jobs", exigeServiceToken);

osRouter.post("/jobs", (req, res) => {
  const tipo = req.body?.tipo as JobTipo | undefined;
  const args = (req.body?.args ?? {}) as Record<string, unknown>;
  if (!tipo) {
    res.status(400).json({ error: "tipo obrigatorio" });
    return;
  }
  try {
    const job = enfileira(tipo, args);
    res.status(202).json({ job_id: job.job_id, status: job.status });
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    // 429 e' contratual: o OS mantem o job 'queued' e o polling redespacha depois.
    if (m === "FILA_CHEIA") {
      res.status(429).json({ error: "fila cheia" });
      return;
    }
    if (m === "TIPO_DESCONHECIDO") {
      res.status(400).json({ error: `tipo "${tipo}" nao suportado`, tipos: tiposSuportados() });
      return;
    }
    res.status(500).json({ error: m || "erro ao enfileirar" });
  }
});

osRouter.get("/jobs/:id", (req, res) => {
  const j = buscaJob(req.params.id);
  // 404 e' contratual: o OS trata como "job perdido" e reenfileira (ate MAX_TENTATIVAS).
  if (!j) {
    res.status(404).json({ error: "job nao encontrado" });
    return;
  }
  res.json({
    job_id: j.job_id,
    tipo: j.tipo,
    status: j.status,
    progresso: j.progresso,
    result: j.result ?? null,
    usage: j.usage ?? null,
    error: j.error,
  });
});

osRouter.post("/jobs/:id/cancel", (req, res) => {
  // 404 aqui o OS trata como sucesso (o estado canonico e a linha em video_jobs), mas
  // respondemos honesto: quem nao existe, nao foi cancelado por nos.
  if (!cancela(req.params.id)) {
    res.status(404).json({ error: "job nao encontrado" });
    return;
  }
  res.json({ ok: true });
});
