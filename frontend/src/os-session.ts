// Sessao do OS dentro do studio (docs no monorepo: AGENTE-VIDEO-SERVICE.md, secoes 2 e 8).
//
// O studio abre num iframe do Blue Ocean OS, sob o dominio dele, e o OS manda dois
// parametros na URL:
//   ?t=<token>     handoff de sessao (HMAC curto, assinado pelo OS). O nginx REMOVE o
//                  cookie do OS antes de chegar aqui, entao ESTE token e' a unica prova de
//                  quem e' o usuario.
//   ?cliente=<slug> cliente selecionado no OS. Todo trabalho no studio pertence a ele.
//
// POR QUE UM INTERCEPTOR e nao passar o header em cada fetch: sao ~32 chamadas em 10
// arquivos. Header a header, alguem esquece uma — e a que esquecerem vira 401 em producao,
// provavelmente no caminho menos testado. Aqui e' um ponto so.
//
// FORA DO OS (npm run dev direto no 5174): nao ha ?t= e o backend em dev nao exige token
// (VIDEO_STUDIO_SESSION_SECRET vazio). Tudo segue funcionando como sempre.

const params = new URLSearchParams(window.location.search);

/** Token do handoff, ou null quando o studio roda solto (dev). */
const token: string | null = params.get("t");
/** Slug do cliente selecionado no OS, ou null. */
const clienteSlug: string | null = params.get("cliente");

/** Estamos embutidos no OS? (iframe + token) */
export function dentroDoOs(): boolean {
  return token !== null;
}

export function getClienteSlug(): string | null {
  return clienteSlug;
}

export function getStudioToken(): string | null {
  return token;
}

/**
 * Injeta o X-Studio-Token em toda chamada pra /api/* deste servico.
 *
 * So mexe em request de MESMA ORIGEM e que comeca com /api — nunca vaza o token pra
 * terceiros (um fetch pra outro dominio sairia com a credencial se a gente fosse
 * ingenuo aqui). Chamado uma vez, no boot, antes de qualquer componente montar.
 */
// Prefixo do subpath (base do Vite). Em PROD: "/agente-video/studio"; em dev: "".
// import.meta.env.BASE_URL termina com "/" — tiro a barra final pra concatenar limpo.
const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

// Os 3 prefixos que o backend do studio serve. Sob subpath, uma request absoluta a "/api"
// bate na RAIZ do dominio do OS (404) em vez do proxy do studio — por isso reescrevo com o BASE.
const PREFIXOS = ["/api", "/uploads", "/projects"] as const;

/** Aplica o subpath a uma URL de mesma origem que aponta pra um dos prefixos do backend. */
export function comBase(url: string): string {
  if (!BASE) return url; // dev (base "/") — nada a fazer
  const origem = window.location.origin;
  for (const p of PREFIXOS) {
    // relativa "/api/..." ainda sem o prefixo
    if (url.startsWith(p) && !url.startsWith(BASE + p)) return BASE + url;
    // absoluta "https://host/api/..." na mesma origem
    if (url.startsWith(origem + p) && !url.startsWith(origem + BASE + p)) {
      return origem + BASE + url.slice(origem.length);
    }
  }
  return url;
}

/**
 * Instala o interceptor de fetch. Faz DUAS coisas, e SEMPRE roda (mesmo sem token), porque a
 * reescrita de subpath e necessaria em PROD independente da sessao:
 *   1. reescreve /api|/uploads|/projects pro subpath (base do Vite) — assets/API/video no iframe;
 *   2. injeta X-Studio-Token nas chamadas de /api quando ha token (handoff do OS).
 * Chamado uma vez, no boot, antes de qualquer componente montar.
 */
export function instalaInterceptorDeSessao(): void {
  const original = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.toString();
    else url = input.url;

    const novaUrl = comBase(url);
    const ehApi = novaUrl.startsWith(`${BASE}/api`) || novaUrl.startsWith(`${window.location.origin}${BASE}/api`);

    // Nada a fazer: URL nao mudou e nao ha token pra injetar.
    if (novaUrl === url && !(token && ehApi)) return original(input, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (token && ehApi) headers.set("X-Studio-Token", token);
    // Se a URL mudou, uso a string reescrita (descarta o Request original, se houver — os
    // callers do studio usam string; o corpo/metodo vem do init).
    return original(novaUrl, { ...init, headers });
  };
}

/** Limpa o ?t= da barra de endereco depois de guardado (o token nao precisa ficar visivel). */
export function limpaTokenDaUrl(): void {
  if (!token) return;
  const u = new URL(window.location.href);
  u.searchParams.delete("t");
  window.history.replaceState({}, "", u.toString());
}
