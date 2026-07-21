import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

// Auth do fluxo-ouro-service. Docs (no monorepo do OS):
// Operacional-BlueOcean/docs/AGENTE-VIDEO-SERVICE.md, secoes 5 e 8.
//
// HOJE O SERVICO NAO TEM AUTH NENHUMA: quem alcanca a porta, roda render. Em localhost
// tudo bem. Na KVM8 (maquina de PROD dos 220 clientes) isso seria a porta de entrada.
//
// Sao DOIS planos, com credenciais diferentes de proposito:
//   1. CONTROLE (OS -> servico): POST /jobs, GET /jobs/:id, cancel. Bearer estatico
//      (VIDEO_SERVICE_TOKEN). Servidor-pra-servidor, rede privada, bind 127.0.0.1.
//   2. APRESENTACAO (navegador -> studio): token HMAC curto emitido pelo OS, porque o
//      nginx REMOVE o cookie do OS antes de repassar. Espelha
//      OS-Assessoria/lib/video/studio-token.ts — mesmo formato, mesmo segredo.

/** Compara em tempo constante. `===` em segredo vaza por timing. */
function igual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Plano de CONTROLE. Sem VIDEO_SERVICE_TOKEN no ambiente o servico RECUSA tudo (503) em
 * vez de liberar: falhar fechado. Um deploy que esqueceu a env tem que quebrar barulhento,
 * nao virar endpoint aberto na maquina de producao.
 */
export function exigeServiceToken(req: Request, res: Response, next: NextFunction): void {
  const esperado = (process.env.VIDEO_SERVICE_TOKEN ?? "").trim();
  if (!esperado) {
    res.status(503).json({ error: "servico sem VIDEO_SERVICE_TOKEN configurado" });
    return;
  }
  const h = req.headers.authorization ?? "";
  const tok = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!tok || !igual(tok, esperado)) {
    res.status(401).json({ error: "nao autorizado" });
    return;
  }
  next();
}

export interface StudioSession {
  userId: string;
  clienteId: string;
  projetoId: string | null;
  exp: number;
}

/** Valida o token do handoff (formato identico ao lib/video/studio-token.ts do OS). */
export function verificaStudioToken(token: string | null | undefined): StudioSession | null {
  const key = (process.env.VIDEO_STUDIO_SESSION_SECRET ?? "").trim();
  if (!key || !token) return null;
  const partes = token.split(".");
  if (partes.length !== 2) return null;
  const [b64, sig] = partes;

  const esperado = crypto.createHmac("sha256", key).update(b64).digest("base64url");
  if (!igual(sig, esperado)) return null;

  let p: StudioSession;
  try {
    p = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as StudioSession;
  } catch {
    return null;
  }
  if (typeof p?.userId !== "string" || !p.userId) return null;
  if (typeof p?.clienteId !== "string" || !p.clienteId) return null;
  // FOLGA de validade: o OS emite o token com TTL curto (5min, feito p/ o load), mas o editor
  // usa o token durante TODA a edicao (proxy, autosave, export). Sem folga, a sessao morria em
  // 5min e a previa/timeline caiam. Estende a aceitacao aqui (a assinatura HMAC continua
  // exigida — isto so alonga a validade, nao afrouxa a autenticidade). Ajustavel por env.
  const graceSec = Number(process.env.VIDEO_STUDIO_TOKEN_GRACE_SEC) || 0;
  if (!Number.isFinite(p?.exp) || p.exp + graceSec < Math.floor(Date.now() / 1000)) return null;
  return p;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      studio?: StudioSession;
    }
  }
}

/**
 * Plano de APRESENTACAO. O token vem do ?t= (primeiro load do iframe) ou do header
 * X-Studio-Token (chamadas seguintes do app).
 *
 * DEV: sem VIDEO_STUDIO_SESSION_SECRET, libera — o studio local nao tem OS na frente e
 * exigir token quebraria o `npm run dev`. Em PROD a env EXISTE, entao este bypass nao
 * roda. E o mesmo padrao de env-gate do OS, com a diferenca de que aqui o gate LIBERA em
 * dev; por isso o deploy TEM que setar a env (ver systemd unit).
 */
export function exigeStudioSession(req: Request, res: Response, next: NextFunction): void {
  if (!(process.env.VIDEO_STUDIO_SESSION_SECRET ?? "").trim()) {
    next();
    return;
  }
  const t = (req.query.t as string | undefined) ?? (req.headers["x-studio-token"] as string | undefined);
  const s = verificaStudioToken(t);
  if (!s) {
    res.status(401).json({ error: "sessao do studio invalida ou expirada" });
    return;
  }
  req.studio = s;
  next();
}
