import fs from "node:fs";
import { spawn } from "node:child_process";

/**
 * Abstração de geração de VÍDEO (image-to-video). Mesma filosofia do ImageProvider:
 * todo o FLOW depende só desta interface; trocar Google por outro é plugar outra impl.
 */
export interface GenerateVideoInput {
  imagePath: string;      // START frame LOCAL (para a entrada: o fundo vazio)
  lastFramePath?: string; // END frame LOCAL (o design final) — método start→end frame
  prompt: string;      // prompt técnico (em inglês) gerado pelo Claude
  aspectRatio?: string;
  durationHint?: number; // duração desejada (s) — o modelo tem limites próprios
}
export interface GenerateVideoResult { videoPath: string; duration: number; }

/**
 * TRAVA ANTI-INVENÇÃO (de lei): o Seedance só pode ANIMAR o que já existe nos frames.
 * Nada novo — nenhum texto, número, logo, imagem, objeto, forma, efeito ou pessoa que
 * não esteja visível nos frames pode aparecer. Anexado a TODO prompt + como negative.
 */
const NO_INVENT_SUFFIX = " STRICT RULE — animate ONLY what already exists in the given frame(s). NEVER add, invent, draw, imagine or introduce anything new at any moment: no new text, letters, words, numbers, percentages, logos, watermarks, images, photos, objects, icons, shapes, particles, effects, backgrounds, scenery or people. Nothing that is not already visible in the frames may ever appear. Keep every element's exact shape, color and position — only move, fade or scale what is already there.";

const NEGATIVE_PROMPT = "new text, new letters, new words, captions, subtitles, new numbers, percentages, new logo, watermark, signature, new image, new photo, new object, new element, new graphic, new icon, new shape, extra shapes, glass panel, glass card, translucent panel, frosted glass, card, container, box, rounded rectangle, frame, border, plate, tray, backdrop panel, button, badge, couch, sofa, furniture, table, particles, sparkles, glow, light beams, lens flare, new background, new scenery, new person, people, hands, characters, hallucination, invented content, ghost duplicate, double image, morphing content, changing the layout, redesign, recolor, restyle, added details, distortion, warping, gibberish text, text artifacts";

export interface VideoProvider {
  readonly name: string;
  /**
   * true = o provider anima a SAÍDA a partir do design (frame âncora) e o vídeo precisa
   * ser INVERTIDO no time-fit (caso Veo). false = o provider aceita start+end frame e já
   * devolve a ENTRADA pronta (caso Seedance/Higgsfield) — sem inversão.
   */
  readonly needsReverse: boolean;
  /** Gera o vídeo e grava em `outPath` (MP4). Devolve caminho + duração (s). */
  generate(input: GenerateVideoInput, outPath: string, signal?: AbortSignal): Promise<GenerateVideoResult>;
}

/**
 * Google Veo (image-to-video) via Gemini API.
 * ATENÇÃO: o nome do modelo e o shape exato da API do Veo mudam — CONFIRME na doc
 * atual do Google. Aqui usamos o fluxo `:predictLongRunning` + polling da operação,
 * com model/endpoint configuráveis por env. A saída é baixada e probeada; a
 * normalização final p/ 1920×1080 H.264 BT.709 acontece no time-fit (um encode só).
 */
export class GoogleVideoProvider implements VideoProvider {
  readonly name = "google-veo";
  readonly needsReverse = true; // anima a saída a partir do design; o time-fit inverte
  private readonly model = process.env.GOOGLE_VIDEO_MODEL ?? "veo-3.1-fast-generate-preview";
  private readonly base = process.env.GOOGLE_API_BASE ?? "https://generativelanguage.googleapis.com/v1beta";

  constructor(private readonly apiKey: string) {}

  async generate(input: GenerateVideoInput, outPath: string, signal?: AbortSignal): Promise<GenerateVideoResult> {
    if (!this.apiKey) {
      throw new Error("Credencial do Google (GOOGLE_VIDEO_API_KEY) ausente no backend — configure para gerar vídeos.");
    }
    const mimeOf = (p: string) => (p.endsWith(".jpg") || p.endsWith(".jpeg") ? "image/jpeg" : "image/png");
    const imgB64 = fs.readFileSync(input.imagePath).toString("base64");

    // instance: image = START frame; lastFrame = END frame (design), se houver.
    const instance: Record<string, unknown> = {
      prompt: input.prompt,
      image: { bytesBase64Encoded: imgB64, mimeType: mimeOf(input.imagePath) },
    };
    if (input.lastFramePath && fs.existsSync(input.lastFramePath)) {
      instance.lastFrame = {
        bytesBase64Encoded: fs.readFileSync(input.lastFramePath).toString("base64"),
        mimeType: mimeOf(input.lastFramePath),
      };
    }

    // 1) inicia a operação de longa duração
    const startRes = await fetch(`${this.base}/models/${this.model}:predictLongRunning?key=${this.apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instances: [instance],
        parameters: { aspectRatio: input.aspectRatio ?? "16:9", sampleCount: 1 },
      }),
      signal,
    });
    if (!startRes.ok) throw new Error(`Google Veo (início) ${startRes.status}: ${(await startRes.text()).slice(-400)}`);
    const op = await startRes.json();
    const opName: string | undefined = op?.name;
    if (!opName) throw new Error("Google Veo não retornou o nome da operação.");

    // 2) polling até done (vídeo demora: timeout generoso)
    const deadline = Date.now() + 10 * 60 * 1000; // 10 min
    let done = op?.done ? op : null;
    while (!done) {
      if (signal?.aborted) throw new Error("geração de vídeo cancelada");
      if (Date.now() > deadline) throw new Error("Google Veo excedeu o tempo limite (10 min).");
      await new Promise((r) => setTimeout(r, 8000));
      const pr = await fetch(`${this.base}/${opName}?key=${this.apiKey}`, { signal });
      if (!pr.ok) throw new Error(`Google Veo (polling) ${pr.status}: ${(await pr.text()).slice(-300)}`);
      const st = await pr.json();
      if (st?.error) throw new Error(`Google Veo erro: ${st.error.message ?? JSON.stringify(st.error)}`);
      if (st?.done) done = st;
    }

    // 3) extrai o vídeo (uri p/ baixar OU bytes inline) — cobre as duas formas comuns.
    const sample = done?.response?.generateVideoResponse?.generatedSamples?.[0]
      ?? done?.response?.generatedSamples?.[0]
      ?? done?.response?.videos?.[0];
    const uri: string | undefined = sample?.video?.uri ?? sample?.uri ?? sample?.video?.url;
    const bytes: string | undefined = sample?.video?.bytesBase64Encoded ?? sample?.bytesBase64Encoded;

    if (bytes) {
      fs.writeFileSync(outPath, Buffer.from(bytes, "base64"));
    } else if (uri) {
      const sep = uri.includes("?") ? "&" : "?";
      const dl = await fetch(`${uri}${sep}key=${this.apiKey}`, { signal });
      if (!dl.ok) throw new Error(`Google Veo (download) ${dl.status}`);
      fs.writeFileSync(outPath, Buffer.from(await dl.arrayBuffer()));
    } else {
      throw new Error("Google Veo: resposta sem vídeo (uri/bytes ausentes) — confira o modelo/API.");
    }

    // duração é probeada por quem chama (time-fit). Devolve 0 se ainda não medida.
    return { videoPath: outPath, duration: input.durationHint ?? 0 };
  }
}

/**
 * Higgsfield (Seedance 2.0) via CLI `higgsfield` — o executor do MotionIA/FlowStudio.
 * Usa o método START→END FRAME de verdade (o Seedance interpola entre dois frames):
 * `--start-image` (fundo vazio) + `--end-image` (o design) + prompt de MOVIMENTO.
 * Auth: sessão logada do CLI (`higgsfield auth login`). Trava de custo antes de gerar
 * (HIGGSFIELD_CREDIT_LIMIT, default 30 créditos), como no FlowStudio original.
 */
export class HiggsfieldVideoProvider implements VideoProvider {
  readonly name = "higgsfield-seedance";
  readonly needsReverse = false; // start→end frame: o vídeo JÁ é a entrada, sem inversão
  private readonly model = process.env.HIGGSFIELD_MODEL ?? "seedance_2_0";
  private readonly resolution = process.env.HIGGSFIELD_RESOLUTION ?? "1080p";
  private readonly creditLimit = Number(process.env.HIGGSFIELD_CREDIT_LIMIT ?? 30);

  /** Roda o CLI e devolve o stdout. No Windows o shim é .cmd → shell + args citados. */
  private run(args: string[], signal: AbortSignal | undefined, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const win = process.platform === "win32";
      // aspas/quebras de linha quebram o cmd.exe — o prompt é saneado antes, aqui só cita.
      const quoted = win ? args.map((a) => (/[\s]/.test(a) ? `"${a.replace(/"/g, "'")}"` : a)) : args;
      const proc = spawn("higgsfield", quoted, { shell: win });
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* */ } reject(new Error("higgsfield excedeu o tempo limite")); }, timeoutMs);
      const onAbort = () => { clearTimeout(timer); try { proc.kill(); } catch { /* */ } reject(new Error("geração cancelada")); };
      signal?.addEventListener("abort", onAbort, { once: true });
      let out = "", err = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.stderr.on("data", (d) => (err += d));
      proc.on("error", (e) => { clearTimeout(timer); reject(e); });
      proc.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (code !== 0) {
          const msg = (err + out).slice(-400);
          if (/session expired|not authenticated/i.test(msg)) {
            reject(new Error("Higgsfield deslogado — rode `higgsfield auth login` no terminal e tente de novo."));
          } else reject(new Error(`higgsfield saiu com código ${code}: ${msg}`));
          return;
        }
        resolve(out);
      });
    });
  }

  /** Acha a URL do .mp4 na resposta (JSON em qualquer formato + fallback regex), como no FlowStudio. */
  private extractVideoUrl(raw: string): string | null {
    const dig = (o: unknown): string | null => {
      if (typeof o === "string") return /^https?:\/\/\S+\.(mp4|mov|webm)/i.test(o) ? o : null;
      if (Array.isArray(o)) { for (const v of o) { const r = dig(v); if (r) return r; } return null; }
      if (o && typeof o === "object") {
        const rec = o as Record<string, unknown>;
        for (const k of ["url", "video_url", "result_url", "output_url", "download_url", "src"]) {
          const v = rec[k];
          if (typeof v === "string" && v.startsWith("http")) return v;
        }
        for (const v of Object.values(rec)) { if (v && typeof v === "object") { const r = dig(v); if (r) return r; } }
      }
      return null;
    };
    // o CLI pode imprimir linhas não-JSON antes do payload → tenta de trás pra frente
    for (const line of raw.split("\n").reverse()) {
      const t = line.trim();
      if (t.startsWith("{") || t.startsWith("[")) {
        try { const r = dig(JSON.parse(t)); if (r) return r; } catch { /* tenta a próxima */ }
      }
    }
    const m = raw.match(/https?:\/\/[^\s'"<>]+\.(?:mp4|mov|webm)[^\s'"<>]*/i);
    return m ? m[0] : null;
  }

  async generate(input: GenerateVideoInput, outPath: string, signal?: AbortSignal): Promise<GenerateVideoResult> {
    // prompt numa linha só, sem aspas duplas (vai como argumento de shell no Windows)
    // + trava anti-invenção SEMPRE anexada (o CLI não tem campo negative separado)
    const prompt = (input.prompt.replace(/"/g, "'").replace(/\s*\n+\s*/g, " ").trim() + NO_INVENT_SUFFIX.replace(/"/g, "'"));
    // Seedance só gera 5s ou 10s. Escolhe o MAIS PRÓXIMO da fala, preferindo 5s até
    // 7.5s: assim o time-fit DESACELERA (motion cheio) em vez de acelerar (motion corrido).
    const dur = (input.durationHint ?? 5) > 7.5 ? 10 : 5;
    const media = input.lastFramePath && fs.existsSync(input.lastFramePath)
      ? ["--start-image", input.imagePath, "--end-image", input.lastFramePath]
      : ["--image", input.imagePath];
    const params = [
      ...media,
      "--aspect_ratio", input.aspectRatio ?? "9:16",
      "--duration", String(dur),
      "--resolution", this.resolution,
      "--generate_audio", "false", // o áudio do vídeo final é a fala; motion é mudo
      "--json", "--no-color",
    ];

    // trava de custo (como o FlowStudio): estima antes; acima do limite, bloqueia.
    try {
      const costOut = await this.run(["generate", "cost", this.model, "--prompt", prompt, ...params], signal, 60_000);
      const m = costOut.match(/"(?:credits|cost|total)"\s*:\s*([\d.]+)/);
      const credits = m ? parseFloat(m[1]) : null;
      if (credits !== null && credits > this.creditLimit) {
        throw new Error(`Custo estimado (${credits} créditos) acima do limite de ${this.creditLimit} — reduza a duração ou a resolução (HIGGSFIELD_RESOLUTION=720p).`);
      }
    } catch (e) {
      if ((e as Error).message.includes("acima do limite")) throw e;
      // estimativa falhou (formato/timeout): segue — a geração em si ainda valida créditos.
    }

    const out = await this.run(
      ["generate", "create", this.model, "--prompt", prompt, ...params, "--wait", "--wait-timeout", "15m", "--wait-interval", "8s"],
      signal, 16 * 60 * 1000,
    );
    const url = this.extractVideoUrl(out);
    if (!url) throw new Error(`Higgsfield não retornou a URL do vídeo. Saída: ${out.slice(-300)}`);
    const dl = await fetch(url, { signal });
    if (!dl.ok) throw new Error(`Higgsfield (download) ${dl.status}`);
    fs.writeFileSync(outPath, Buffer.from(await dl.arrayBuffer()));
    return { videoPath: outPath, duration: input.durationHint ?? 0 };
  }
}

/**
 * fal.ai (Seedance 2.0) via API de fila (queue). Método START→END FRAME:
 * `image_url` (start) + `end_image_url` (end) + prompt de MOVIMENTO — o modelo
 * interpola, igual ao Higgsfield, então needsReverse=false. Auth por FAL_KEY.
 * Modelo/resolução configuráveis por env (o slug do Seedance 2.0 no fal muda —
 * confira em fal.ai/models e ajuste FAL_VIDEO_MODEL).
 */
export class FalVideoProvider implements VideoProvider {
  readonly name = "fal-seedance";
  readonly needsReverse = false; // start→end frame: o vídeo já é a entrada
  private readonly model = process.env.FAL_VIDEO_MODEL ?? "fal-ai/bytedance/seedance/v1/pro/image-to-video";
  private readonly resolution = process.env.FAL_RESOLUTION ?? "1080p";
  private readonly key = process.env.FAL_KEY ?? process.env.FAL_API_KEY ?? "";

  /** data URI (base64) do arquivo — o fal aceita como image_url nos modelos de vídeo. */
  private dataUri(p: string): string {
    const b64 = fs.readFileSync(p).toString("base64");
    const mime = p.endsWith(".jpg") || p.endsWith(".jpeg") ? "image/jpeg" : "image/png";
    return `data:${mime};base64,${b64}`;
  }

  /** Acha a URL do vídeo no resultado do fal (shape varia por modelo). */
  private extractVideoUrl(o: unknown): string | null {
    if (typeof o === "string") return /^https?:\/\/\S+\.(mp4|mov|webm)/i.test(o) ? o : null;
    if (Array.isArray(o)) { for (const v of o) { const r = this.extractVideoUrl(v); if (r) return r; } return null; }
    if (o && typeof o === "object") {
      const rec = o as Record<string, unknown>;
      for (const k of ["url", "video_url", "output_url"]) {
        const v = rec[k]; if (typeof v === "string" && v.startsWith("http")) return v;
      }
      for (const v of Object.values(rec)) { if (v && typeof v === "object") { const r = this.extractVideoUrl(v); if (r) return r; } }
    }
    return null;
  }

  async generate(input: GenerateVideoInput, outPath: string, signal?: AbortSignal): Promise<GenerateVideoResult> {
    if (!this.key) throw new Error("FAL_KEY ausente no backend — configure a chave do fal.ai para gerar vídeos.");
    // trava anti-invenção SEMPRE anexada + negative_prompt (dupla garantia)
    const prompt = (input.prompt.replace(/\s*\n+\s*/g, " ").trim() + NO_INVENT_SUFFIX);
    const dur = (input.durationHint ?? 5) > 7.5 ? 10 : 5; // Seedance: 5s ou 10s
    const payload: Record<string, unknown> = {
      prompt,
      negative_prompt: NEGATIVE_PROMPT,
      image_url: this.dataUri(input.imagePath),
      resolution: this.resolution,
      duration: String(dur),
      aspect_ratio: input.aspectRatio ?? "9:16",
      enable_safety_checker: false,
    };
    if (input.lastFramePath && fs.existsSync(input.lastFramePath)) {
      payload.end_image_url = this.dataUri(input.lastFramePath); // método start→end frame
    }
    const headers = { "content-type": "application/json", authorization: `Key ${this.key}` };

    // 1) enfileira o pedido
    const sub = await fetch(`https://queue.fal.run/${this.model}`, { method: "POST", headers, body: JSON.stringify(payload), signal });
    if (!sub.ok) throw new Error(`fal.ai (submit) ${sub.status}: ${(await sub.text()).slice(-400)}`);
    const q = await sub.json() as { request_id?: string; status_url?: string; response_url?: string };
    const base = `https://queue.fal.run/${this.model}/requests/${q.request_id}`;
    const statusUrl = q.status_url ?? `${base}/status`;
    const resultUrl = q.response_url ?? base;
    if (!q.request_id && !q.status_url) throw new Error("fal.ai não retornou o request_id da fila.");

    // 2) polling até COMPLETED (vídeo demora: timeout generoso)
    const deadline = Date.now() + 12 * 60 * 1000;
    for (;;) {
      if (signal?.aborted) throw new Error("geração de vídeo cancelada");
      if (Date.now() > deadline) throw new Error("fal.ai excedeu o tempo limite (12 min).");
      await new Promise((r) => setTimeout(r, 5000));
      const st = await fetch(statusUrl, { headers, signal });
      if (!st.ok) throw new Error(`fal.ai (status) ${st.status}: ${(await st.text()).slice(-300)}`);
      const sj = await st.json() as { status?: string };
      if (sj.status === "COMPLETED") break;
      if (sj.status === "FAILED" || sj.status === "ERROR") throw new Error(`fal.ai falhou: ${JSON.stringify(sj).slice(-300)}`);
    }

    // 3) resultado → URL do vídeo → baixa
    const res = await fetch(resultUrl, { headers, signal });
    if (!res.ok) throw new Error(`fal.ai (resultado) ${res.status}: ${(await res.text()).slice(-300)}`);
    const url = this.extractVideoUrl(await res.json());
    if (!url) throw new Error("fal.ai: resposta sem URL de vídeo — confira o FAL_VIDEO_MODEL.");
    const dl = await fetch(url, { signal });
    if (!dl.ok) throw new Error(`fal.ai (download) ${dl.status}`);
    fs.writeFileSync(outPath, Buffer.from(await dl.arrayBuffer()));
    return { videoPath: outPath, duration: input.durationHint ?? 0 };
  }
}

/**
 * Replicate — SEEDANCE 2.0 REAL da ByteDance (`bytedance/seedance-2.0`). Método
 * start→end frame nativo: `image` (1º frame) + `last_frame_image` (frame final) →
 * o modelo interpola a ENTRADA (`needsReverse=false`). Duração EXATA em segundos
 * (até 15s), então o time-fit quase não precisa acelerar. Auth: REPLICATE_API_TOKEN.
 */
export class ReplicateVideoProvider implements VideoProvider {
  readonly name = "replicate-seedance2";
  readonly needsReverse = false;
  private readonly model = process.env.REPLICATE_VIDEO_MODEL ?? "bytedance/seedance-2.0";
  private readonly resolution = process.env.REPLICATE_RESOLUTION ?? "720p";
  private readonly token = process.env.REPLICATE_API_TOKEN ?? "";

  private dataUri(p: string): string {
    const b64 = fs.readFileSync(p).toString("base64");
    const mime = p.endsWith(".jpg") || p.endsWith(".jpeg") ? "image/jpeg" : "image/png";
    return `data:${mime};base64,${b64}`;
  }
  private extractVideoUrl(o: unknown): string | null {
    if (typeof o === "string") return /^https?:\/\/\S+\.(mp4|mov|webm)/i.test(o) ? o : (o.startsWith("http") ? o : null);
    if (Array.isArray(o)) { for (const v of o) { const r = this.extractVideoUrl(v); if (r) return r; } return null; }
    if (o && typeof o === "object") {
      const rec = o as Record<string, unknown>;
      for (const v of Object.values(rec)) { const r = this.extractVideoUrl(v); if (r) return r; }
    }
    return null;
  }

  async generate(input: GenerateVideoInput, outPath: string, signal?: AbortSignal): Promise<GenerateVideoResult> {
    if (!this.token) throw new Error("REPLICATE_API_TOKEN ausente no backend — configure a chave do Replicate para gerar vídeos.");
    const prompt = (input.prompt.replace(/\s*\n+\s*/g, " ").trim() + NO_INVENT_SUFFIX).slice(0, 3900);
    const dur = Math.max(4, Math.min(15, Math.round(input.durationHint ?? 5))); // Seedance 2.0: 4–15s
    const inputBody: Record<string, unknown> = {
      prompt,
      image: this.dataUri(input.imagePath),
      duration: dur,
      resolution: this.resolution,
      aspect_ratio: input.aspectRatio ?? "9:16",
      generate_audio: false,
    };
    if (input.lastFramePath && fs.existsSync(input.lastFramePath)) {
      inputBody.last_frame_image = this.dataUri(input.lastFramePath); // método start→end frame
    }
    const headers = { "content-type": "application/json", authorization: `Bearer ${this.token}` };

    // 1) cria a predição no modelo oficial (usa a última versão automaticamente)
    const sub = await fetch(`https://api.replicate.com/v1/models/${this.model}/predictions`, {
      method: "POST", headers, body: JSON.stringify({ input: inputBody }), signal,
    });
    if (!sub.ok) throw new Error(`Replicate (criar) ${sub.status}: ${(await sub.text()).slice(-400)}`);
    let pred = await sub.json() as { id?: string; status?: string; output?: unknown; error?: string; urls?: { get?: string } };
    const getUrl = pred.urls?.get ?? `https://api.replicate.com/v1/predictions/${pred.id}`;

    // 2) polling até succeeded (vídeo demora)
    const deadline = Date.now() + 12 * 60 * 1000;
    while (pred.status !== "succeeded") {
      if (signal?.aborted) throw new Error("geração de vídeo cancelada");
      if (pred.status === "failed" || pred.status === "canceled") throw new Error(`Replicate falhou: ${pred.error ?? pred.status}`);
      if (Date.now() > deadline) throw new Error("Replicate excedeu o tempo limite (12 min).");
      await new Promise((r) => setTimeout(r, 5000));
      const st = await fetch(getUrl, { headers, signal });
      if (!st.ok) throw new Error(`Replicate (status) ${st.status}: ${(await st.text()).slice(-300)}`);
      pred = await st.json();
    }

    // 3) baixa o vídeo do output
    const url = this.extractVideoUrl(pred.output);
    if (!url) throw new Error("Replicate: resposta sem URL de vídeo — confira o REPLICATE_VIDEO_MODEL.");
    const dl = await fetch(url, { signal });
    if (!dl.ok) throw new Error(`Replicate (download) ${dl.status}`);
    fs.writeFileSync(outPath, Buffer.from(await dl.arrayBuffer()));
    return { videoPath: outPath, duration: input.durationHint ?? 0 };
  }
}

/** Seleção do provider de vídeo por env (`VIDEO_PROVIDER`, default google). */
export function getVideoProvider(): VideoProvider {
  // trim + lowercase: env editado no servidor costuma vir com espaco/CR (`replicate\r`) ou
  // maiuscula — sem normalizar, o switch nao casa e estoura "provider desconhecido".
  const provider = (process.env.VIDEO_PROVIDER ?? "google").trim().toLowerCase();
  switch (provider) {
    case "google":
      return new GoogleVideoProvider(process.env.GOOGLE_VIDEO_API_KEY ?? process.env.GEMINI_API_KEY ?? "");
    case "higgsfield":
      return new HiggsfieldVideoProvider();
    case "fal":
      return new FalVideoProvider();
    case "replicate":
      return new ReplicateVideoProvider();
    default:
      throw new Error(`VIDEO_PROVIDER invalido: "${provider}". Use "google", "replicate", "fal" ou "higgsfield" no backend/.env (ou /etc/fluxo-ouro/env em PROD).`);
  }
}
