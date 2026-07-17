import crypto from "crypto";

// Fila do fluxo-ouro-service. Docs (monorepo do OS):
// Operacional-BlueOcean/docs/AGENTE-VIDEO-SERVICE.md, secoes 5 e 7.
//
// POR QUE ISTO EXISTE: hoje o render e' `POST /api/render` -> `const jobs = new Map()`, sem
// limite de concorrencia. Dois renders simultaneos disputam todos os nucleos. Na KVM8 (8
// vCPU, compartilhada com a PRODUCAO dos 220 clientes) isso derruba o painel. A regra do
// Paulo e' explicita: "um render nunca pode consumir os 8 nucleos".
//
// A defesa e' em DUAS camadas, e as duas sao necessarias:
//   1. AQUI (app): no maximo WORKERS jobs rodando; o resto espera em fila.
//   2. NO SO (systemd): CPUQuota no slice inteiro. Sem isso, 2 workers x ffmpeg -threads N
//      ainda estouram. A cota do SO e' o teto real; esta fila e' so educacao.
//
// Estado em memoria (como o Map de hoje). Reiniciar o processo perde a fila — e ACEITAVEL
// porque a FONTE DA VERDADE e a tabela video_jobs no OS: o polling do OS detecta o job
// perdido (404 daqui) e reenfileira. Persistir aqui duplicaria a fonte da verdade.

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";
export type JobTipo = "transcribe" | "decupagem" | "render" | "flow-design";

export interface Job {
  job_id: string;
  tipo: JobTipo;
  args: Record<string, unknown>;
  status: JobStatus;
  progresso: number;
  result?: { output_path: string | null; result_data: Record<string, unknown> | null };
  usage?: Record<string, unknown> | null;
  error?: string;
  criadoEm: number;
  abort: AbortController;
}

/** Executor de um tipo de job. Recebe onProgress (0..100) e um signal pra abortar. */
export type Executor = (
  args: Record<string, unknown>,
  ctx: { onProgress: (pct: number) => void; signal: AbortSignal },
) => Promise<{ output_path?: string | null; result_data?: Record<string, unknown> | null; usage?: Record<string, unknown> | null }>;

/**
 * Jobs pesados rodando ao mesmo tempo. 2 e' o default do doc: com CPUQuota=400% (4 nucleos)
 * e ffmpeg -threads 2, dois renders cabem no teto sem sufocar o OS. NAO subir sem o spike
 * V0.3 medir — o numero e' hipotese ate la.
 */
const WORKERS = Math.max(1, Number(process.env.VIDEO_WORKERS ?? 2));
/** Fila cheia -> 429 e o OS mantem 'queued' e redespacha. Melhor que aceitar infinito. */
const FILA_MAX = Math.max(1, Number(process.env.VIDEO_FILA_MAX ?? 50));
/** Job concluido some daqui depois disso (o resultado ja foi persistido no OS). */
const TTL_MS = Number(process.env.VIDEO_JOB_TTL_MS ?? 6 * 3600_000);

const jobs = new Map<string, Job>();
const espera: string[] = [];
const executores = new Map<JobTipo, Executor>();
let rodando = 0;

export function registraExecutor(tipo: JobTipo, fn: Executor): void {
  executores.set(tipo, fn);
}

export function tiposSuportados(): JobTipo[] {
  return [...executores.keys()];
}

export function buscaJob(id: string): Job | undefined {
  return jobs.get(id);
}

/** Enfileira. Lanca "FILA_CHEIA" (-> 429) ou "TIPO_DESCONHECIDO" (-> 400). */
export function enfileira(tipo: JobTipo, args: Record<string, unknown>): Job {
  if (!executores.has(tipo)) throw new Error("TIPO_DESCONHECIDO");
  if (espera.length >= FILA_MAX) throw new Error("FILA_CHEIA");
  const job: Job = {
    job_id: crypto.randomUUID(),
    tipo,
    args,
    status: "queued",
    progresso: 0,
    criadoEm: Date.now(),
    abort: new AbortController(),
  };
  jobs.set(job.job_id, job);
  espera.push(job.job_id);
  setImmediate(bombeia);
  return job;
}

/**
 * Cancela. Job na fila sai sem rodar; job rodando recebe o abort (o executor decide como
 * parar — no render, matar o processo do ffmpeg). Job ja fechado: noop (idempotente).
 */
export function cancela(id: string): boolean {
  const j = jobs.get(id);
  if (!j) return false;
  if (j.status === "queued") {
    const i = espera.indexOf(id);
    if (i >= 0) espera.splice(i, 1);
    j.status = "cancelled";
    return true;
  }
  if (j.status === "running") {
    j.abort.abort();
    j.status = "cancelled";
    return true;
  }
  return true;
}

/** Puxa da fila enquanto houver vaga. Unico ponto que incrementa `rodando`. */
function bombeia(): void {
  while (rodando < WORKERS && espera.length > 0) {
    const id = espera.shift()!;
    const job = jobs.get(id);
    if (!job || job.status !== "queued") continue;
    rodando++;
    executa(job).finally(() => {
      rodando--;
      limpaVelhos();
      setImmediate(bombeia);
    });
  }
}

/**
 * Le o status "de fora" do fluxo. Existe pro TS parar de estreitar: depois de
 * `job.status = "running"` ele conclui que comparar com "cancelled" e' impossivel — mas
 * NAO e': o cancela() muda o status durante o await, de outra chamada HTTP. Essa e'
 * exatamente a corrida que os checks abaixo pegam. Sem isto, o compilador "provaria" que
 * o cancelamento nao existe e o job cancelado seria sobrescrito com done/error.
 */
function statusAtual(job: Job): JobStatus {
  return job.status;
}

async function executa(job: Job): Promise<void> {
  const fn = executores.get(job.tipo);
  if (!fn) {
    job.status = "error";
    job.error = "executor nao registrado";
    return;
  }
  job.status = "running";
  try {
    const r = await fn(job.args, {
      onProgress: (pct) => {
        // clamp: o OS tem CHECK 0..100 na coluna; estourar aqui quebraria o insert la
        job.progresso = Math.max(0, Math.min(100, Math.round(pct)));
      },
      signal: job.abort.signal,
    });
    // cancelado no meio: nao sobrescreve o status (o cancel ja venceu a corrida)
    if (statusAtual(job) === "cancelled") return;
    job.status = "done";
    job.progresso = 100;
    job.result = { output_path: r.output_path ?? null, result_data: r.result_data ?? null };
    job.usage = r.usage ?? null;
  } catch (e) {
    if (statusAtual(job) === "cancelled") return;
    job.status = "error";
    job.error = e instanceof Error ? e.message.slice(0, 500) : "erro desconhecido";
  }
}

function limpaVelhos(): void {
  const corte = Date.now() - TTL_MS;
  for (const [id, j] of jobs) {
    if (j.criadoEm < corte && j.status !== "running" && j.status !== "queued") jobs.delete(id);
  }
}

/** Diagnostico pro /health. */
export function statusFila(): { rodando: number; naFila: number; workers: number } {
  return { rodando, naFila: espera.length, workers: WORKERS };
}

// ---------------------------------------------------------------------------
// Vaga compartilhada (semaforo)
// ---------------------------------------------------------------------------
// POR QUE ISTO EXISTE: o teto so vale se TODO trabalho pesado passar por ele. O botao
// "Renderizar MP4" do studio chama POST /api/render direto — nao o /jobs do OS. Se so a
// fila do OS respeitasse o limite, o teto seria teatro: um editor clicando no studio
// levaria os 8 nucleos da KVM8 (a maquina de PROD dos 220 clientes) do mesmo jeito.
//
// Entao o /api/render existente passa a pedir vaga AQUI, no MESMO contador `rodando` que a
// fila do OS usa. Um teto, duas portas de entrada.

const filaVagas: Array<() => void> = [];

/**
 * Roda `fn` so quando houver vaga dentro do teto (WORKERS). Enquanto nao ha, espera —
 * NAO recusa: o usuario do studio ja apertou o botao e a UI dele espera resposta.
 * Libera a vaga aconteca o que acontecer (finally), senao um erro vazaria uma vaga pra
 * sempre e o servico ia parando aos poucos ate travar de vez.
 */
export async function comVaga<T>(fn: () => Promise<T>): Promise<T> {
  if (rodando >= WORKERS) {
    await new Promise<void>((resolve) => filaVagas.push(resolve));
  }
  rodando++;
  try {
    return await fn();
  } finally {
    rodando--;
    const proximo = filaVagas.shift();
    if (proximo) proximo();
    else setImmediate(bombeia); // sobrou vaga: deixa a fila do OS aproveitar
  }
}
