import { comBase } from '../../os-session';
import { useEffect, useMemo, useRef, useState } from "react";
import type { TranscriptSegment, Cut, FullscreenPopup } from "../../../../shared/timeline";
import { DEFAULT_POPUP_TRANSITION } from "../../../../shared/timeline";
import {
  DESIGN_REF_TAGS, FLOW_LAYOUT_TEMPLATES, emptyFlow, getIdentity, identityToPrompt,
  IDENTITY_FONTES, IDENTITY_BOTOES, IDENTITY_ICONES,
  type FlowState, type FlowMoment, type FlowPhrase, type FlowAspect, type FlowDesignRef, type DesignRefTag,
  type FlowIdentity, type IdentityOption, type FlowChatMsg, type FlowAnimMode,
} from "../../../../shared/flow";
import { buildCutPlan, remapTime } from "../../../../shared/cutplan";
import { SketchCanvas } from "./SketchCanvas";

/**
 * Módulo 7 — FLOW. Wizard: detectar → design (proporção 9:16 + descrição + imagens
 * de referência com tags) → animar → posicionar. Estado no documento central (undo).
 * A IA decide por índice de palavra; os tempos são do whisper.
 */

async function startJob(url: string, body: unknown): Promise<string> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? "Falha ao iniciar");
  return d.jobId;
}
function pollJob(jobId: string, onProgress?: (p: number) => void): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const iv = setInterval(async () => {
      try {
        const r = await fetch(comBase(`/api/flow/progress/${jobId}`));
        const j = await r.json();
        onProgress?.(j.progress ?? 0);
        if (j.status === "done") { clearInterval(iv); resolve(j.result ?? {}); }
        else if (j.status === "error") { clearInterval(iv); reject(new Error(j.error ?? "Erro no job")); }
      } catch { /* segue */ }
    }, 1500);
  });
}
const readDataUrl = (file: File, cb: (s: string) => void) => { const r = new FileReader(); r.onload = () => cb(r.result as string); r.readAsDataURL(file); };
const uid = () => Math.random().toString(36).slice(2, 9);

/** Carrega as Google Fonts das opções de identidade (pro PREVIEW real no seletor). */
function ensureGoogleFonts() {
  if (document.getElementById("flow-gfonts")) return;
  const link = document.createElement("link");
  link.id = "flow-gfonts";
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@700&family=Montserrat:wght@700&family=Poppins:wght@700&family=Roboto:wght@700&family=Bebas+Neue&family=Oswald:wght@700&family=Anton&family=Nunito:wght@700&family=Playfair+Display:wght@700&family=DM+Serif+Display&display=swap";
  document.head.appendChild(link);
}

type JobUI = { kind: "design" | "designPrompt" | "motionPrompt" | "animate"; progress: number; jobId?: string };

export function FlowPanel({
  transcript, cuts, durationSec, copy, projectId, flow, onFlowChange, onPlacePopups,
  flowPopups = [], onPatchFlowPopup, videoFile,
}: {
  transcript: TranscriptSegment[]; cuts: Cut[]; durationSec: number; copy: string;
  projectId: string | null; flow: FlowState | undefined;
  // aceita updater funcional: patches de jobs paralelos partem SEMPRE do estado atual
  onFlowChange: (f: FlowState | ((prev: FlowState | undefined) => FlowState)) => void;
  onPlacePopups: (pops: FullscreenPopup[], clearIds?: string[]) => void;
  // motions JÁ colocados na timeline principal + como reposicioná-los (mudar o `at`)
  flowPopups?: FullscreenPopup[];
  onPatchFlowPopup?: (id: string, patch: Partial<FullscreenPopup>) => void;
  videoFile?: File; // fonte de ÁUDIO pro playback no editor de motions
}) {
  const [detecting, setDetecting] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null); // imagem ampliada
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setLightbox(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);
  const [jobs, setJobs] = useState<Record<string, JobUI>>({});
  const words = useMemo(() => transcript.flatMap((s) => s.words), [transcript]);
  const plan = useMemo(() => buildCutPlan(durationSec, cuts), [durationSec, cuts]);

  const setJob = (id: string, j: JobUI | null) =>
    setJobs((prev) => { const n = { ...prev }; if (j) n[id] = j; else delete n[id]; return n; });

  function phraseTimes(ph: FlowPhrase) {
    const st = words[ph.wordStart]?.start ?? 0;
    const en = words[ph.wordEnd]?.end ?? st;
    const os = remapTime(st, plan), oe = remapTime(en, plan);
    const fala = os != null && oe != null ? Math.max(0.3, oe - os) : Math.max(0.3, en - st);
    // tempo de tela: manual (o usuário força) tem prioridade; senão, a duração da fala.
    const target = ph.overrideDuration && ph.overrideDuration > 0 ? ph.overrideDuration : fala;
    return { srcStart: st, srcDur: Math.max(0.3, en - st), target };
  }

  // Jobs longos (1-2 min) rodam EM PARALELO em várias telas: quem termina não pode
  // gravar por cima de um snapshot velho do flow (apagaria o progresso das outras).
  // patchPhrase é um UPDATER: o React entrega o estado atual na hora de aplicar.
  const flowRef = useRef(flow);
  flowRef.current = flow;

  // REGERAR: cada geração (imagem/vídeo) grava aqui COMO refazê-la com os MESMOS inputs
  // (closure). O card de erro mostra um botão que chama isto. `kind` = o que falhou (a
  // última tentativa é a que falhou quando status vira "error"). Não é persistido.
  const retryFns = useRef<Record<string, { kind: "image" | "video"; fn: () => void }>>({}).current;

  function patchPhrase(phraseId: string, patch: Partial<FlowPhrase>) {
    onFlowChange((prev) => {
      const cur = prev ?? emptyFlow();
      return { ...cur, moments: cur.moments.map((m) => ({ ...m, phrases: m.phrases.map((p) => (p.id === phraseId ? { ...p, ...patch } : p)) })) };
    });
  }

  /** Lê a versão ATUAL de uma frase (pra não usar closures velhas em jobs longos). */
  const currentPhrase = (phraseId: string): FlowPhrase | undefined =>
    flowRef.current?.moments.flatMap((m) => m.phrases).find((p) => p.id === phraseId);

  /** Identidade efetiva do projeto (migra brandRefs antigos). */
  const identity = getIdentity(flow);
  const patchIdentity = (p: Partial<FlowIdentity>) =>
    onFlowChange({ ...(flow ?? emptyFlow()), identity: { ...identity, ...p } });

  /** Converte uma URL (asset) em data URL pra mandar como referência. */
  async function urlToDataUrl(url: string): Promise<string | null> {
    try {
      const blob = await (await fetch(url)).blob();
      return await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.readAsDataURL(blob); });
    } catch { return null; }
  }

  const [analyzing, setAnalyzing] = useState(false);
  /** Analisa a(s) imagem(ns) de estilo por visão → descrição cacheada na identidade. */
  async function analisarEstilo() {
    const estilos = identity.refs.filter((r) => r.tag === "estilo" && r.src.startsWith("data:"));
    if (!estilos.length) { setError("Anexe uma imagem de estilo primeiro."); return; }
    setAnalyzing(true); setError(null);
    try {
      const r = await fetch(comBase("/api/flow/analyze-style"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ refs: estilos.map((e) => ({ tag: e.tag, src: e.src })) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Falha na análise");
      patchIdentity({ styleDesc: d.styleDesc });
    } catch (e) { setError((e as Error).message); }
    finally { setAnalyzing(false); }
  }

  async function detectar() {
    setDetecting(true); setError(null);
    try {
      const jobId = await startJob("/api/flow/detect", { transcript, copy });
      const res = await pollJob(jobId);
      onFlowChange({ ...(flow ?? emptyFlow()), moments: (res.moments as FlowMoment[]) ?? [] });
    } catch (e) { setError((e as Error).message); }
    finally { setDetecting(false); }
  }

  /**
   * CHAT DE DESIGN (estilo ChatGPT): manda o texto do usuário VERBATIM + imagens
   * anexadas (+ o último resultado, se "continuar" estiver ligado) pro gpt-image.
   */
  async function enviarChat(ph: FlowPhrase, texto: string, imagens: string[], usarIdentidade: boolean, continuar: boolean) {
    if (!projectId) { setError("Salve o projeto antes de gerar (os assets ficam no projeto)."); return; }
    retryFns[ph.id] = { kind: "image", fn: () => enviarChat(ph, texto, imagens, usarIdentidade, continuar) };
    const msgs = ph.designChat ?? [];
    let imgs = [...imagens];
    if (continuar) {
      const last = [...msgs].reverse().find((m) => m.role === "assistant" && m.images?.length);
      if (last) { const d = await urlToDataUrl(last.images![0]); if (d) imgs = [d, ...imgs]; }
    }
    const idBlock = usarIdentidade ? identityToPrompt(identity) : "";
    const promptFinal = (idBlock ? idBlock + "\n\n" : "") + texto.trim();
    const userMsg: FlowChatMsg = { id: uid(), role: "user", text: texto.trim(), images: imagens };
    patchPhrase(ph.id, { designChat: [...msgs, userMsg], status: "designing", error: undefined });
    setJob(ph.id, { kind: "design", progress: 0 });
    try {
      const jobId = await startJob("/api/flow/design-chat", { projectId, phraseId: ph.id, prompt: promptFinal, images: imgs, aspect: ph.aspect ?? "9:16" });
      setJob(ph.id, { kind: "design", progress: 0, jobId });
      const res = await pollJob(jobId, (p) => setJob(ph.id, { kind: "design", progress: p, jobId }));
      const botMsg: FlowChatMsg = { id: uid(), role: "assistant", images: [res.imagePath as string] };
      // lê o chat ATUAL (outras gerações podem ter mexido no flow enquanto essa rodava)
      const chatNow = currentPhrase(ph.id)?.designChat ?? [...msgs, userMsg];
      patchPhrase(ph.id, { designChat: [...chatNow, botMsg], status: "design_ready" });
    } catch (e) { patchPhrase(ph.id, { status: "error", error: (e as Error).message }); }
    finally { setJob(ph.id, null); }
  }
  /**
   * GERAR DESIGN (R3 — fluxo NOVO): 2 slots por geração (LAYOUT + ESTILO) + prompt + cores
   * (COLOR LAW, do campo `cores` do projeto) → /api/flow/gerar-design. O Claude escreve o prompt,
   * o GPT-5 vê as 2 imagens e gera. Sem identidade de projeto, sem chat, sem tags.
   */
  async function enviarGerarDesign(ph: FlowPhrase, layoutSrc: string | undefined, estiloSrc: string | undefined, prompt: string, modo: "restyle" | "esboco" = "restyle", elementos: string[] = []) {
    if (!projectId) { setError("Salve o projeto antes de gerar (os assets ficam no projeto)."); return; }
    retryFns[ph.id] = { kind: "image", fn: () => enviarGerarDesign(ph, layoutSrc, estiloSrc, prompt, modo, elementos) };
    const userMsg: FlowChatMsg = { id: uid(), role: "user", text: prompt.trim() || "(gerar)", images: [layoutSrc, estiloSrc, ...elementos].filter(Boolean) as string[] };
    patchPhrase(ph.id, { designChat: [...(ph.designChat ?? []), userMsg], status: "designing", error: undefined });
    setJob(ph.id, { kind: "design", progress: 0 });
    try {
      const jobId = await startJob("/api/flow/gerar-design", { projectId, phraseId: ph.id, texto: ph.text, layout: layoutSrc, estilo: estiloSrc, prompt, cores: identity.cores ?? "", aspect: ph.aspect ?? "9:16", modo, elementos });
      setJob(ph.id, { kind: "design", progress: 0, jobId });
      const res = await pollJob(jobId, (p) => setJob(ph.id, { kind: "design", progress: p, jobId }));
      const botMsg: FlowChatMsg = { id: uid(), role: "assistant", images: [res.imagePath as string] };
      const chatNow = currentPhrase(ph.id)?.designChat ?? [];
      patchPhrase(ph.id, { designChat: [...chatNow, botMsg], status: "design_ready" });
    } catch (e) { patchPhrase(ph.id, { status: "error", error: (e as Error).message }); }
    finally { setJob(ph.id, null); }
  }

  /** Para a geração em andamento (aborta a chamada no servidor). */
  async function pararGeracao(ph: FlowPhrase) {
    const j = jobs[ph.id];
    if (j?.jobId) { try { await fetch(comBase(`/api/flow/cancel/${j.jobId}`), { method: "POST" }); } catch { /* */ } }
  }
  /** Escolhe uma imagem do chat como o design da frase. */
  const usarDesign = (ph: FlowPhrase, url: string) =>
    patchPhrase(ph.id, { imagePath: url, imageApproved: false, status: "design_ready" });
  /** Sobe um design pronto (sem IA): salva no projeto, ajusta a proporção e usa. */
  async function subirDesign(ph: FlowPhrase, dataUrl: string) {
    if (!projectId) { setError("Salve o projeto antes de subir o design."); return; }
    setJob(ph.id, { kind: "design", progress: 0.5 });
    try {
      const r = await fetch(comBase("/api/flow/upload-design"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, phraseId: ph.id, image: dataUrl, aspect: ph.aspect ?? "9:16" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Falha no upload");
      const msgs = currentPhrase(ph.id)?.designChat ?? ph.designChat ?? [];
      const botMsg: FlowChatMsg = { id: uid(), role: "assistant", images: [d.imagePath as string] };
      patchPhrase(ph.id, {
        designChat: [...msgs, botMsg],
        imagePath: d.imagePath as string, imageApproved: false, status: "design_ready", error: undefined,
      });
    } catch (e) { patchPhrase(ph.id, { error: (e as Error).message }); }
    finally { setJob(ph.id, null); }
  }
  /** Descarta a imagem escolhida (o chat continua lá pra iterar). */
  const descartarDesign = (ph: FlowPhrase) =>
    patchPhrase(ph.id, { imagePath: undefined, imageApproved: false, status: "detected" });

  /**
   * ANIMAÇÃO CONTÍNUA (método MotionIA): no momento em modo "continua", o design da
   * frase ANTERIOR é o START frame do clipe desta frase — a emenda some por construção.
   * A 1ª frase do momento continua sendo uma ENTRADA normal (fundo vazio → design).
   */
  function prevPhraseDesign(ph: FlowPhrase): string | undefined {
    const m = flow?.moments.find((mm) => mm.phrases.some((p) => p.id === ph.id));
    if (!m || (m.animMode ?? "solta") !== "continua") return undefined;
    const i = m.phrases.findIndex((p) => p.id === ph.id);
    return i > 0 ? m.phrases[i - 1].imagePath : undefined;
  }
  const setAnimMode = (momentId: string, mode: FlowAnimMode) =>
    flow && onFlowChange({ ...flow, moments: flow.moments.map((m) => (m.id === momentId ? { ...m, animMode: mode } : m)) });

  /** Remove um momento (se já houver popup dele na timeline, remova-o lá também). */
  function removerMomento(momentId: string) {
    flow && onFlowChange({ ...flow, moments: flow.moments.filter((m) => m.id !== momentId) });
  }

  /**
   * JUNTA a frase com a PRÓXIMA do mesmo momento → vira UMA tela / UM clipe de motion.
   * O design/motion existentes são resetados (a frase mudou — a tela precisa ser refeita);
   * preserva o que é do usuário: proporção, refs e o histórico do chat.
   */
  function juntarFrases(momentId: string, phraseId: string) {
    flow && onFlowChange({
      ...flow,
      moments: flow.moments.map((m) => {
        if (m.id !== momentId) return m;
        const i = m.phrases.findIndex((p) => p.id === phraseId);
        if (i < 0 || i >= m.phrases.length - 1) return m;
        const a = m.phrases[i], b = m.phrases[i + 1];
        const merged: FlowPhrase = {
          id: a.id, wordStart: a.wordStart, wordEnd: b.wordEnd,
          text: `${a.text} ${b.text}`.trim(), aspect: a.aspect,
          designUserPrompt: a.designUserPrompt, designRefs: a.designRefs, designChat: a.designChat,
          status: "detected",
        };
        return { ...m, phrases: [...m.phrases.slice(0, i), merged, ...m.phrases.slice(i + 2)] };
      }),
    });
  }

  /** Modo "texto": anima LOCAL por ffmpeg (design sobe + fade, sem IA). */
  function isTextMode(ph: FlowPhrase): boolean {
    const m = flow?.moments.find((mm) => mm.phrases.some((p) => p.id === ph.id));
    return (m?.animMode ?? "solta") === "texto";
  }

  /**
   * Piso de duração do motion (2s) — CONDICIONAL, não vale pra toda frase:
   *  • ÚLTIMA frase do momento → precisa de ar no fim (a tela fica um instante a mais);
   *  • frase GRANDE comprimida em tempo curto (≥6 palavras num alvo <2s) → senão a
   *    animação fica rápida demais.
   * Frase naturalmente curta (ex.: "tira dúvidas") NÃO recebe piso — duração da fala.
   */
  function motionMin(ph: FlowPhrase): number {
    // tempo manual = honra EXATO (o usuário decidiu); sem piso automático.
    if (ph.overrideDuration && ph.overrideDuration > 0) return 0;
    const m = flow?.moments.find((mm) => mm.phrases.some((p) => p.id === ph.id));
    if (!m) return 0;
    const isLast = m.phrases[m.phrases.length - 1].id === ph.id;
    const words = ph.wordEnd - ph.wordStart + 1;
    const { target } = phraseTimes(ph);
    const comprimida = words >= 6 && target < 2;
    return (isLast || comprimida) ? 2 : 0;
  }

  async function gerarPromptMotion(ph: FlowPhrase) {
    setJob(ph.id, { kind: "motionPrompt", progress: 0 });
    try {
      const { target } = phraseTimes(ph);
      const r = await fetch(comBase("/api/flow/motion-prompt"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          texto: ph.text, presetId: ph.designPresetId, pedido: ph.motionUserPrompt ?? "", duracaoAlvo: target,
          modo: prevPhraseDesign(ph) ? "transicao" : "entrada",
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Falha");
      patchPhrase(ph.id, { motionModelPrompt: d.motionModelPrompt });
    } catch (e) { patchPhrase(ph.id, { error: (e as Error).message }); }
    finally { setJob(ph.id, null); }
  }

  /**
   * AJUSTE DE TEMPO DE TELA: muda a duração do motion e RE-ENCAIXA na hora (só time-fit,
   * local, sem custo de API — acelera/desacelera o vídeo bruto já gerado). Se o momento
   * já está na timeline, re-concatena pra atualizar a duração do popup.
   */
  async function ajustarTempo(ph: FlowPhrase, novaDuracao: number | undefined) {
    patchPhrase(ph.id, { overrideDuration: novaDuracao });
    if (!ph.videoPath || !projectId) return; // sem vídeo bruto ainda: só guarda o valor
    setJob(ph.id, { kind: "animate", progress: 0.3 });
    try {
      const cur = { ...ph, overrideDuration: novaDuracao };
      const jobId = await startJob("/api/flow/refit", {
        projectId, phraseId: ph.id, rawVideo: ph.videoPath,
        targetDuration: phraseTimes(cur).target, aspect: ph.aspect ?? "9:16", minDuration: motionMin(cur),
      });
      const res = await pollJob(jobId);
      patchPhrase(ph.id, { fittedVideoPath: res.fittedVideoPath as string, fitInfo: res.fitInfo as FlowPhrase["fitInfo"] });
      // se já colocado, re-concatena o momento pra a timeline refletir o novo tempo
      const m = flowRef.current?.moments.find((mm) => mm.phrases.some((p) => p.id === ph.id));
      if (m && m.phrases.some((p) => p.id === ph.id && p.status === "placed")) await colocar(m);
    } catch (e) { patchPhrase(ph.id, { error: (e as Error).message }); }
    finally { setJob(ph.id, null); }
  }

  async function gerarVideo(ph: FlowPhrase) {
    if (!projectId) { setError("Salve o projeto antes de gerar."); return; }
    if (!ph.imagePath || !ph.motionModelPrompt) return;
    retryFns[ph.id] = { kind: "video", fn: () => gerarVideo(ph) };
    const { target } = phraseTimes(ph);
    setJob(ph.id, { kind: "animate", progress: 0 });
    patchPhrase(ph.id, { status: "animating", error: undefined });
    try {
      const jobId = await startJob("/api/flow/animate", {
        projectId, phraseId: ph.id, image: ph.imagePath, motionModelPrompt: ph.motionModelPrompt,
        targetDuration: target, aspect: ph.aspect ?? "9:16", minDuration: motionMin(ph),
        prevImage: prevPhraseDesign(ph), // modo contínuo: design anterior = start frame
        localText: isTextMode(ph),       // modo "texto": animação local por ffmpeg (sem IA)
        // "Regerar": já existe um vídeo → força um take novo (ignora o cache, mesmo com a mesma imagem).
        regenNonce: ph.fittedVideoPath ? Date.now().toString(36) : undefined,
      });
      const res = await pollJob(jobId, (p) => setJob(ph.id, { kind: "animate", progress: p }));
      patchPhrase(ph.id, { videoPath: res.videoPath as string, fittedVideoPath: res.fittedVideoPath as string, fitInfo: res.fitInfo as FlowPhrase["fitInfo"], status: "video_ready" });
    } catch (e) { patchPhrase(ph.id, { status: "error", error: (e as Error).message }); }
    finally { setJob(ph.id, null); }
  }

  /**
   * COLOCAR NA TIMELINE: junta os clipes do momento num ÚNICO vídeo contínuo (concat
   * no servidor) e coloca UM popup de tela cheia começando no início da 1ª frase. O
   * popup IGNORA cortes: sua duração é o tamanho REAL do vídeo concatenado — toca por
   * inteiro (cortes internos não o encurtam; o motion segue contínuo).
   */
  async function colocar(m: FlowMoment) {
    if (!flow || !projectId) return;
    const done = m.phrases.filter((ph) => ph.fittedVideoPath);
    if (done.length === 0) return;
    if (done.length < m.phrases.length) {
      setError(`${m.phrases.length - done.length} frase(s) deste momento ainda sem vídeo — coloco só as prontas.`);
    }
    try {
      const jobId = await startJob("/api/flow/concat-moment", {
        projectId, momentId: m.id, videos: done.map((ph) => ph.fittedVideoPath),
      });
      const res = await pollJob(jobId);
      // preserva a posição (at) se o usuário já reposicionou este motion; senão, começa na fala.
      const existing = flowPopups.find((p) => p.flowPhraseId === m.id);
      const srcStart = existing ? existing.at : phraseTimes(done[0]).srcStart;
      // duração = tamanho real do concat (tempo de tela, ignora cortes)
      const pop: FullscreenPopup = {
        id: `flow-${m.id}`, type: "fullscreen", at: +srcStart.toFixed(3), duration: +(res.duration as number).toFixed(3),
        source: "auto", transition: { inType: "none", outType: "none", inDuration: 0, outDuration: 0, easing: "ease" },
        media: { kind: "video", src: res.videoPath as string }, flowPhraseId: m.id,
      };
      // remove popups antigos deste momento (tanto o unificado quanto os por-frase de antes)
      onPlacePopups([pop], [m.id, ...m.phrases.map((p) => p.id)]);
      onFlowChange((prev) => {
        const cur = prev ?? emptyFlow();
        return {
          ...cur,
          placedPopupIds: [...new Set([...cur.placedPopupIds, pop.id])],
          moments: cur.moments.map((mm) => mm.id !== m.id ? mm : { ...mm, phrases: mm.phrases.map((p) => p.fittedVideoPath ? { ...p, status: "placed" } : p) }),
        };
      });
    } catch (e) { setError((e as Error).message); }
  }

  async function resync() {
    if (!flow || !projectId) return;
    setResyncing(true); setError(null);
    try {
      const updates: Record<string, Partial<FlowPhrase>> = {};
      const pops: FullscreenPopup[] = [];
      for (const m of flow.moments) for (const ph of m.phrases) {
        if (ph.status !== "placed" || !ph.videoPath) continue;
        const { srcStart, srcDur, target } = phraseTimes(ph);
        const jobId = await startJob("/api/flow/refit", { projectId, phraseId: ph.id, rawVideo: ph.videoPath, targetDuration: target, aspect: ph.aspect ?? "9:16", minDuration: motionMin(ph) });
        const res = await pollJob(jobId);
        updates[ph.id] = { fittedVideoPath: res.fittedVideoPath as string, fitInfo: res.fitInfo as FlowPhrase["fitInfo"] };
        pops.push({ id: `flow-${ph.id}`, type: "fullscreen", at: +srcStart.toFixed(3), duration: +srcDur.toFixed(3), source: "auto", transition: DEFAULT_POPUP_TRANSITION, media: { kind: "video", src: res.fittedVideoPath as string }, flowPhraseId: ph.id });
      }
      onFlowChange({ ...flow, moments: flow.moments.map((m) => ({ ...m, phrases: m.phrases.map((p) => (updates[p.id] ? { ...p, ...updates[p.id] } : p)) })) });
      if (pops.length) onPlacePopups(pops);
    } catch (e) { setError((e as Error).message); }
    finally { setResyncing(false); }
  }

  const moments = flow?.moments ?? [];
  const anyPlaced = moments.some((m) => m.phrases.some((p) => p.status === "placed"));

  // MotionStudio (modal): um chat/fluxo POR VEZ — nada de vários chats na tela.
  const [studioOpen, setStudioOpen] = useState(false);
  const [selPhraseId, setSelPhraseId] = useState<string | null>(null);
  const [realocGlobal, setRealocGlobal] = useState(false); // editor de motions na timeline do vídeo
  const allPhrases = moments.flatMap((m) => m.phrases);
  const selPhrase = allPhrases.find((p) => p.id === selPhraseId) ?? allPhrases[0] ?? null;
  // progresso global: telas com vídeo pronto (pro header do studio e o resumo)
  const withVideo = allPhrases.filter((p) => p.fittedVideoPath || p.status === "video_ready" || p.status === "placed").length;
  useEffect(() => {
    if (!studioOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setStudioOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [studioOpen]);

  return (
    <section style={{ marginTop: 24 }}>
      <style>{`
        /* animações do FLOW (badges pulsantes, spinner e barra indeterminada) */
        .fo-pulse { width: 7px; height: 7px; border-radius: 50%; display: inline-block; animation: fo-pulse 1.1s ease-in-out infinite; }
        @keyframes fo-pulse { 0%, 100% { opacity: .35; transform: scale(.85); } 50% { opacity: 1; transform: scale(1); } }
        .fo-spin { width: 14px; height: 14px; flex: 0 0 auto; border-radius: 50%; border: 2px solid var(--panel3); border-top-color: var(--text); animation: fo-rot .9s linear infinite; }
        @keyframes fo-rot { to { transform: rotate(360deg); } }
        .fo-indet { animation: fo-slide 1.2s ease-in-out infinite; }
        @keyframes fo-slide { 0% { margin-left: -30%; } 100% { margin-left: 100%; } }
        .fo-clamp2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      `}</style>
      <h2>7. FLOW — motion design por IA</h2>
      <p style={{ fontSize: 13, color: "var(--muted)", margin: "4px 0 8px" }}>
        A IA acha 3 momentos, segmenta em frases e cada frase vira um vídeo de motion sincronizado.
        No design você escolhe a proporção (9:16 padrão), descreve a tela e anexa referências (logo, estilo, esboço).
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={detectar} disabled={detecting || transcript.length === 0} style={{ background: "var(--accent)", color: "#1a1a1a", fontWeight: 600 }}>
          {detecting ? "detectando…" : "Detectar momentos de motion (IA)"}
        </button>
        {anyPlaced && <button onClick={resync} disabled={resyncing} title="Refaz o time-fit das frases posicionadas (após mexer nos cortes). Sem regenerar.">
          {resyncing ? "re-sincronizando…" : "Re-sincronizar FLOW"}
        </button>}
        {!projectId && <span style={{ fontSize: 12, color: "var(--accent-text)" }}>salve o projeto p/ gerar imagens/vídeos</span>}
      </div>
      {error && <p style={{ color: "var(--red)", fontSize: 13 }}>{error}</p>}

      {/* estado vazio: orienta o primeiro passo em vez de deixar a seção "morta" */}
      {moments.length === 0 && !detecting && (
        <div style={{ marginTop: 16, border: "1px dashed var(--border)", borderRadius: 12, padding: "16px 20px", display: "flex", gap: 12, alignItems: "center", color: "var(--muted)", fontSize: 13 }}>
          <span style={{ fontSize: 18, color: "var(--faint)" }}>✦</span>
          <span>
            Nenhum momento ainda. Clique em <strong style={{ color: "var(--text)" }}>Detectar momentos</strong> — a IA encontra de 3 a 5
            trechos onde motion design agrega e já os separa em telas prontas para desenhar.
            {transcript.length === 0 && <em style={{ color: "var(--faint)" }}> (transcreva o vídeo primeiro)</em>}
          </span>
        </div>
      )}

      {/* IDENTIDADE DO PROJETO — escolhida PRIMEIRO, peso MÁXIMO em todos os designs */}
      <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 16, padding: "24px 20px", marginTop: 16 }}>
        <div className="fo-sec">
          <div className="t">Identidade do projeto</div>
          <div className="s">Definida uma vez — aplicada em todas as telas do vídeo.</div>
        </div>

        <div className="fo-field" style={{ marginBottom: 16 }}>
          <label>Cores do projeto</label>
          <input value={identity.cores ?? ""} onChange={(e) => patchIdentity({ cores: e.target.value })}
            placeholder="Ex. fundo azul-marinho escuro, acento azul elétrico, texto branco" />
        </div>

        <div className="fo-row3">
          <FontSelect value={identity.fonteId} onChange={(v) => patchIdentity({ fonteId: v })} />
          <IdentitySelect label="Botões" options={IDENTITY_BOTOES} value={identity.botoesId} onChange={(v) => patchIdentity({ botoesId: v })} />
          <IdentitySelect label="Ícones" options={IDENTITY_ICONES} value={identity.iconesId} onChange={(v) => patchIdentity({ iconesId: v })} />
        </div>

        <hr className="fo-divider" />

        <div className="fo-sec">
          <div className="t">Imagens da marca</div>
          <div className="s">Telas de estilo da marca e a logo do cliente.</div>
        </div>
        <RefUploader refs={identity.refs} onZoom={setLightbox} tags={["estilo", "logo"]} defaultTag="estilo"
          onChange={(r) => patchIdentity({ refs: r })} />

        {identity.refs.some((r) => r.tag === "estilo") && (
          <>
            <hr className="fo-divider" />
            <div className="fo-sec" style={{ marginBottom: 12 }}>
              <div className="t">Análise de estilo</div>
              <div className="s">Extrai o estilo da referência como texto — a imagem não vai pro gerador (evita cópia do conteúdo).</div>
            </div>
            <button onClick={analisarEstilo} disabled={analyzing} style={{ background: "var(--accent)", color: "#1a1a1a", fontWeight: 600 }}>
              {analyzing ? "Analisando estilo…" : identity.styleDesc ? "Re-analisar estilo" : "Analisar estilo"}
            </button>
            {identity.styleDesc && (
              <div className="fo-field" style={{ marginTop: 16 }}>
                <label>Estilo extraído (editável)</label>
                <textarea value={identity.styleDesc} onChange={(e) => patchIdentity({ styleDesc: e.target.value })} rows={4}
                  style={{ fontSize: 12.5 }} />
              </div>
            )}
          </>
        )}
      </div>

      {/* RESUMO COMPACTO — as telas viram chips; o trabalho acontece no MotionStudio */}
      {moments.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={() => setStudioOpen(true)}
              style={{ background: "linear-gradient(180deg, #f6f6f6, #d9d9d9)", color: "#1a1a1a", fontWeight: 600, padding: "12px 24px", borderRadius: 999, fontSize: 14 }}>
              Abrir MotionStudio
            </button>
            {flowPopups.length > 0 && (
              <button onClick={() => setRealocGlobal(true)}
                style={{ padding: "12px 20px", borderRadius: 999, fontSize: 13 }}
                title="posicione e ajuste a velocidade dos motions na timeline do vídeo, ouvindo o áudio">
                Ajustar motions na timeline
              </button>
            )}
            {/* visão geral: quanto do trabalho já virou vídeo */}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)" }}>
              <span style={{ width: 72, height: 4, borderRadius: 999, background: "var(--panel3)", overflow: "hidden", display: "inline-block" }}>
                <span style={{ display: "block", width: `${allPhrases.length ? Math.round((100 * withVideo) / allPhrases.length) : 0}%`, height: "100%", background: "var(--green)", transition: "width .3s" }} />
              </span>
              {moments.length} momento{moments.length > 1 ? "s" : ""} · {allPhrases.length} tela{allPhrases.length > 1 ? "s" : ""} · <span style={{ color: withVideo === allPhrases.length ? "var(--green)" : "var(--muted)" }}>{withVideo} com vídeo</span>
            </span>
          </div>
          {moments.map((m, i) => (
            <div key={m.id} style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 8 }}>
                <strong style={{ color: "var(--text)" }}>Momento {i + 1}</strong> · {m.reason}
                <button onClick={() => removerMomento(m.id)} title="remover este momento"
                  style={{ width: 18, height: 18, lineHeight: "16px", padding: 0, fontSize: 12, borderRadius: "50%", border: "none", background: "transparent", color: "var(--red)", cursor: "pointer" }}>×</button>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                {m.phrases.map((ph) => (
                  <span key={ph.id} onClick={() => { setSelPhraseId(ph.id); setStudioOpen(true); }} className="fo-card"
                    title="abrir no MotionStudio"
                    style={{ cursor: "pointer", display: "inline-flex", gap: 8, alignItems: "center", background: "var(--panel2)", border: "1px solid var(--border)", borderRadius: 12, padding: "4px 12px 4px 4px", fontSize: 12 }}>
                    {ph.imagePath
                      ? <img src={comBase(ph.imagePath)} alt="" style={{ width: 22, height: 32, objectFit: "cover", borderRadius: 8, flex: "0 0 auto" }} />
                      : <span style={{ width: 22, height: 32, borderRadius: 8, flex: "0 0 auto", border: "1px dashed var(--border)", display: "grid", placeItems: "center", fontSize: 11, color: "var(--faint)" }}>✦</span>}
                    <StatusBadge status={ph.status} />
                    <span style={{ maxWidth: 220, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>"{ph.text}"</span>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ───────────────── MOTIONSTUDIO — popup por cima do layout ───────────────── */}
      {studioOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 900, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
          onClick={() => setStudioOpen(false)}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: "min(1240px, 96vw)", height: "90vh", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 16, boxShadow: "0 24px 80px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column", overflow: "hidden" }}>

            {/* header */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", background: "var(--panel)", borderBottom: "1px solid var(--border)" }}>
              <strong style={{ fontSize: 15 }}>MotionStudio</strong>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>criação das telas e geração do motion</span>
              <span style={{ flex: 1 }} />
              {allPhrases.length > 0 && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)" }} title="telas com vídeo pronto">
                  <span style={{ width: 90, height: 4, borderRadius: 999, background: "var(--panel3)", overflow: "hidden", display: "inline-block" }}>
                    <span style={{ display: "block", width: `${Math.round((100 * withVideo) / allPhrases.length)}%`, height: "100%", background: "var(--green)", transition: "width .3s" }} />
                  </span>
                  {withVideo}/{allPhrases.length} com vídeo
                </span>
              )}
              <button onClick={() => setStudioOpen(false)} title="fechar (Esc)"
                style={{ width: 32, height: 32, borderRadius: 8, padding: 0, display: "grid", placeItems: "center", fontSize: 16 }}>×</button>
            </div>

            <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
              {/* sidebar: telas do vídeo */}
              <div style={{ width: 280, flex: "0 0 auto", borderRight: "1px solid var(--border)", overflowY: "auto", padding: 12, background: "var(--panel)" }}>
                {moments.map((m, i) => {
                  const allReady = m.phrases.every((p) => p.status === "video_ready" || p.status === "placed");
                  const placed = m.phrases.some((p) => p.status === "placed");
                  return (
                    <div key={m.id} style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 11, color: "var(--faint)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>
                        Momento {i + 1}
                      </div>
                      {m.phrases.map((ph, phIdx) => {
                        const active = selPhrase?.id === ph.id;
                        return (
                          <div key={ph.id}>
                            <div onClick={() => setSelPhraseId(ph.id)} className={active ? undefined : "fo-card"}
                              style={{ cursor: "pointer", borderRadius: 12, padding: "8px 12px", marginBottom: 4, display: "flex", gap: 8, alignItems: "center", border: `1px solid ${active ? "var(--border-active)" : "transparent"}`, background: active ? "var(--active-grad)" : "transparent", boxShadow: active ? "var(--shadow-active)" : undefined }}>
                              {/* miniatura do design: reconhecimento visual imediato da tela */}
                              {ph.imagePath
                                ? <img src={comBase(ph.imagePath)} alt="" style={{ width: 30, height: 44, objectFit: "cover", borderRadius: 8, flex: "0 0 auto", border: "1px solid var(--border)" }} />
                                : <span style={{ width: 30, height: 44, borderRadius: 8, flex: "0 0 auto", border: "1px dashed var(--border)", display: "grid", placeItems: "center", fontSize: 12, color: "var(--faint)" }}>✦</span>}
                              <div style={{ minWidth: 0 }}>
                                <div className="fo-clamp2" style={{ fontSize: 12.5, color: active ? "var(--text)" : "var(--muted)", lineHeight: 1.4, marginBottom: 4 }}>"{ph.text}"</div>
                                <StatusBadge status={ph.status} />
                              </div>
                            </div>
                            {/* JUNTAR com a próxima: as duas frases viram UMA tela / UM clipe */}
                            {phIdx < m.phrases.length - 1 && (
                              <div style={{ textAlign: "center", margin: "-2px 0 4px" }}>
                                <button onClick={() => juntarFrases(m.id, ph.id)}
                                  title="junta esta frase com a de baixo — vira um único vídeo (o design é refeito)"
                                  style={{ fontSize: 10, padding: "1px 12px", borderRadius: 999, border: "1px dashed var(--border)", background: "transparent", color: "var(--muted)", cursor: "pointer" }}>
                                  ⇣ juntar
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                        <select value={m.animMode ?? "solta"} onChange={(e) => setAnimMode(m.id, e.target.value as FlowAnimMode)}
                          title="solta: entrada por IA · contínua: transição encadeada (IA) · texto: animação local (ffmpeg), sem IA — ideal só p/ texto" style={{ fontSize: 11 }}>
                          <option value="solta">animação solta</option>
                          <option value="continua">animação contínua</option>
                          <option value="texto">só texto (ffmpeg, sem IA)</option>
                        </select>
                        <button onClick={() => colocar(m)} disabled={!allReady}
                          style={{ fontSize: 11, padding: "4px 12px", background: allReady ? "var(--green)" : undefined, color: allReady ? "#fff" : undefined }}>
                          {placed ? "recolocar" : "→ timeline"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* área principal: o fluxo da tela selecionada (UM chat por vez) */}
              <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "8px 20px 20px" }}>
                {selPhrase ? (
                  <PhraseCard ph={selPhrase} job={jobs[selPhrase.id]} patch={patchPhrase} times={phraseTimes(selPhrase)} onZoom={setLightbox}
                    onSendChat={enviarChat} onGerarDesign={enviarGerarDesign} cores={identity.cores}
                    onUseDesign={usarDesign} onUpload={subirDesign} onDescartar={descartarDesign} onCancel={pararGeracao}
                    onApprove={(ph) => patchPhrase(ph.id, { imageApproved: true, status: "approved" })}
                    onGenMotion={gerarPromptMotion} onAnimate={gerarVideo} onAjustarTempo={ajustarTempo}
                    retryKind={retryFns[selPhrase.id]?.kind} onRetry={() => retryFns[selPhrase.id]?.fn()} />
                ) : (
                  <p style={{ color: "var(--muted)", padding: 20 }}>Nenhuma tela — detecte os momentos primeiro.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {realocGlobal && onPatchFlowPopup && (
        <MotionEditor durationSec={durationSec} cuts={cuts} moments={moments} popups={flowPopups}
          getTimes={phraseTimes} jobs={jobs} videoFile={videoFile}
          onAjustar={ajustarTempo} onPatch={onPatchFlowPopup} onClose={() => setRealocGlobal(false)} />
      )}

      {lightbox && (
        <div onClick={() => setLightbox(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out" }}>
          <img src={comBase(lightbox)} alt="" style={{ maxWidth: "92vw", maxHeight: "92vh", borderRadius: 8, boxShadow: "0 8px 40px rgba(0,0,0,0.6)" }} />
          <button onClick={(e) => { e.stopPropagation(); setLightbox(null); }}
            style={{ position: "fixed", top: 16, right: 20, fontSize: 22, background: "rgba(0,0,0,0.5)", color: "#fff", border: "none", borderRadius: 8, width: 40, height: 40, cursor: "pointer" }}>×</button>
        </div>
      )}
    </section>
  );
}


const ASPECTS: FlowAspect[] = ["9:16", "16:9", "1:1"];

function PhraseCard({ ph, job, patch, times, onZoom, onSendChat, onGerarDesign, cores, onUseDesign, onUpload, onDescartar, onCancel, onApprove, onGenMotion, onAnimate, onAjustarTempo, retryKind, onRetry }: {
  ph: FlowPhrase; job?: JobUI; patch: (phraseId: string, p: Partial<FlowPhrase>) => void;
  times: { srcStart: number; srcDur: number; target: number }; onZoom: (src: string) => void;
  onSendChat: (ph: FlowPhrase, texto: string, imagens: string[], usarIdentidade: boolean, continuar: boolean) => void;
  onGerarDesign: (ph: FlowPhrase, layoutSrc: string | undefined, estiloSrc: string | undefined, prompt: string, modo?: "restyle" | "esboco", elementos?: string[]) => void;
  cores?: string;
  onUseDesign: (ph: FlowPhrase, url: string) => void;
  onUpload: (ph: FlowPhrase, dataUrl: string) => void;
  onDescartar: (ph: FlowPhrase) => void; onCancel: (ph: FlowPhrase) => void; onApprove: (ph: FlowPhrase) => void;
  onGenMotion: (ph: FlowPhrase) => void; onAnimate: (ph: FlowPhrase) => void;
  onAjustarTempo: (ph: FlowPhrase, novaDuracao: number | undefined) => void;
  retryKind?: "image" | "video"; onRetry: () => void;
}) {
  const busy = !!job;

  return (
    <div style={{ paddingTop: 8 }}>
      {/* título da tela + status */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <strong style={{ fontSize: 15, lineHeight: 1.45, flex: 1, minWidth: 0 }}>“{ph.text}”</strong>
        <span style={{ flex: "0 0 auto", marginTop: 2 }}><StatusBadge status={ph.status} /></span>
      </div>

      {/* etapas à esquerda · controles da tela à direita */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", margin: "8px 0 4px" }}>
        <Stepper ph={ph} />
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: "var(--faint)" }} title="duração alvo (tempo da fala; ajustável depois no vídeo)">alvo {times.target.toFixed(1)}s</span>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>proporção{" "}
          <select value={ph.aspect ?? "9:16"} onChange={(e) => patch(ph.id, { aspect: e.target.value as FlowAspect })}>
            {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label title="suba um design pronto (sem gerar por IA) — ele vira o design desta tela"
          style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer",
            background: "var(--panel3)", border: "1px solid var(--border)", borderRadius: 12, padding: "4px 12px", color: "var(--text)" }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" />
          </svg>
          Subir design
          <input type="file" accept="image/*" style={{ display: "none" }} disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) readDataUrl(f, (src) => onUpload(ph, src)); e.target.value = ""; }} />
        </label>
      </div>
      {/* FALHA na geração (imagem ou vídeo não saiu) → banner claro + botão REGERAR.
          `kind` = a última tentativa (a que falhou); sem registro, deduz pela presença da imagem. */}
      {ph.status === "error" && !busy ? (() => {
        const kind = retryKind ?? (ph.imagePath ? "video" : "image");
        const alvo = kind === "video" ? "vídeo" : "imagem";
        return (
          <div style={{ background: "rgba(230,70,70,0.10)", border: "1px solid var(--red)", borderRadius: 8,
            padding: "8px 12px", margin: "8px 0", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, color: "var(--red)", flex: 1, minWidth: 140 }}>
              {kind === "video" ? "O vídeo não foi gerado." : "A imagem não foi gerada."}
              {ph.error ? <span style={{ color: "var(--muted)" }}> — {ph.error}</span> : null}
            </span>
            <button onClick={onRetry} style={{ background: "var(--accent)", color: "#1a1a1a", fontWeight: 600, whiteSpace: "nowrap" }}>
              ⟳ Regerar {alvo}
            </button>
          </div>
        );
      })() : ph.error ? (
        <p style={{ color: "var(--red)", fontSize: 12, margin: "4px 0" }}>{ph.error}</p>
      ) : null}

      {/* DESIGN: 3 opções — Layout+Estilo · Esboço (canvas) · Freestyle (chat) */}
      <DesignChat ph={ph} busy={busy} job={job} onZoom={onZoom} onSend={onSendChat} onGerarDesign={onGerarDesign} cores={cores} onUse={onUseDesign} onCancel={onCancel} onPatch={(p) => patch(ph.id, p)} />

      {/* progresso do job ATIVO — colado no fluxo, com % e parar */}
      {job && (job.kind === "design" || job.kind === "animate") && (
        <JobProgress label={job.kind === "design" ? "Gerando a tela… (~1–2 min)" : "Gerando o vídeo de motion… (~1–3 min)"}
          progress={job.progress || 0} onCancel={() => onCancel(ph)} />
      )}

      {/* DESIGN ESCOLHIDO — card com a imagem + aprovação (libera a animação) */}
      {ph.imagePath && (
        <div style={{ marginTop: 12, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, padding: 12, display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <img src={comBase(ph.imagePath)} alt="" onClick={() => onZoom(ph.imagePath!)} title="clique p/ ampliar"
            style={{ maxHeight: 230, borderRadius: 8, border: "1px solid var(--border)", display: "block", cursor: "zoom-in", flex: "0 0 auto" }} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--faint)", marginBottom: 8 }}>Design escolhido</div>
            {!ph.imageApproved ? (
              <>
                <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 12px", lineHeight: 1.5 }}>
                  Gostou? Aprove para liberar a <strong style={{ color: "var(--text)" }}>animação</strong>.
                  Se não, gere outra versão acima ou descarte.
                </p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={() => onApprove(ph)} style={{ background: "var(--green)", color: "#fff", fontWeight: 600 }}>✓ Aprovar design</button>
                  <button onClick={() => onDescartar(ph)} disabled={busy} style={{ color: "var(--red)" }} title="descarta esta imagem (o chat continua)">Descartar</button>
                </div>
              </>
            ) : (
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ color: "var(--green)", fontSize: 13 }}>✓ aprovado — siga para a animação abaixo</span>
                <button onClick={() => onDescartar(ph)} disabled={busy} style={{ color: "var(--red)", fontSize: 12 }} title="descarta esta imagem (o chat continua)">Descartar</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ANIMAÇÃO — só aparece com design aprovado */}
      {ph.imageApproved && (
        <div style={{ marginTop: 12, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, padding: 12 }}>
          <div style={{ fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--faint)", marginBottom: 8 }}>Animação</div>
          <label style={{ fontSize: 12.5, color: "var(--muted)" }}>O que aparece na tela (elementos a animar)</label>
          <textarea value={ph.motionUserPrompt ?? ""} onChange={(e) => patch(ph.id, { motionUserPrompt: e.target.value })}
            placeholder="ex: um card central com o número 3, três ícones em linha, a logo no topo e uma legenda embaixo"
            rows={2} style={{ width: "100%", font: "inherit", fontSize: 13, boxSizing: "border-box", marginTop: 4, borderRadius: 8 }} />
          <div style={{ fontSize: 11, color: "var(--faint)", margin: "4px 0 12px" }}>A coreografia premium (estilo Apple) é sempre a mesma — aqui você só diz QUAIS elementos animar.</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={() => onGenMotion(ph)} disabled={busy}
              style={!ph.motionModelPrompt ? { background: "var(--accent)", color: "#1a1a1a", fontWeight: 600 } : undefined}>
              {job?.kind === "motionPrompt" ? "gerando…" : ph.motionModelPrompt ? "Regerar prompt de motion" : "Gerar prompt de motion (IA)"}
            </button>
            {ph.motionModelPrompt && (
              <button onClick={() => onAnimate(ph)} disabled={busy} style={{ background: "var(--accent)", color: "#1a1a1a", fontWeight: 600 }}>
                {job?.kind === "animate" ? "gerando vídeo…" : ph.fittedVideoPath ? "▶ Regerar vídeo" : "▶ Gerar vídeo"}
              </button>
            )}
          </div>
          {ph.motionModelPrompt && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ fontSize: 12, color: "var(--muted)", cursor: "pointer" }}>ver/editar o prompt técnico</summary>
              <textarea value={ph.motionModelPrompt} onChange={(e) => patch(ph.id, { motionModelPrompt: e.target.value })} rows={3}
                style={{ width: "100%", font: "inherit", fontSize: 12, boxSizing: "border-box", marginTop: 8, borderRadius: 8 }} />
            </details>
          )}
        </div>
      )}

      {/* MOTION FINAL — o clipe que vai pra timeline */}
      {ph.fittedVideoPath && (
        <div style={{ marginTop: 12, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, padding: 12 }}>
          <div style={{ fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--faint)", marginBottom: 8 }}>Motion final</div>
          <video src={comBase(ph.fittedVideoPath)} controls muted style={{ maxHeight: 260, borderRadius: 8, border: "1px solid var(--border)" }} />
          {ph.fitInfo && <p style={{ fontSize: 11, color: "var(--muted)", margin: "4px 0 0" }}>time-fit: {ph.fitInfo.strategy} · {ph.fitInfo.rawDuration}s → {ph.fitInfo.targetDuration}s (×{ph.fitInfo.speed})</p>}
          <DurationControl ph={ph} target={times.target} busy={busy} onAjustar={onAjustarTempo} />
        </div>
      )}
    </div>
  );
}

/**
 * ETAPAS da tela (Design → Aprovação → Animação → Timeline): orientação imediata de
 * onde a frase está e o que falta. Derivado dos artefatos/status — sem estado próprio.
 */
function Stepper({ ph }: { ph: FlowPhrase }) {
  const done = [
    !!ph.imagePath,
    !!ph.imageApproved,
    !!ph.fittedVideoPath || ph.status === "video_ready" || ph.status === "placed",
    ph.status === "placed",
  ];
  const labels = ["Design", "Aprovação", "Animação", "Timeline"];
  const current = done.findIndex((d) => !d); // -1 = tudo concluído
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap" }} title="etapas desta tela">
      {labels.map((l, i) => {
        const isDone = done[i], isCur = i === current;
        return (
          <div key={l} style={{ display: "flex", alignItems: "center" }}>
            {i > 0 && <span style={{ width: 18, height: 1, background: done[i - 1] ? "rgba(88,196,120,0.45)" : "var(--border)", margin: "0 8px" }} />}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: isCur ? 600 : 400,
              color: isDone ? "var(--green)" : isCur ? "var(--text)" : "var(--faint)" }}>
              <span style={{ width: 16, height: 16, borderRadius: "50%", display: "grid", placeItems: "center", fontSize: 9.5, fontWeight: 700,
                background: isDone ? "rgba(88,196,120,0.16)" : isCur ? "var(--active-grad)" : "transparent",
                border: `1px solid ${isDone ? "rgba(88,196,120,0.5)" : isCur ? "var(--border-active)" : "var(--border)"}`,
                color: isDone ? "var(--green)" : isCur ? "var(--text)" : "var(--faint)" }}>
                {isDone ? "✓" : i + 1}
              </span>
              {l}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Progresso de um job (tela/vídeo): spinner + barra viva + % + parar. */
function JobProgress({ label, progress, onCancel }: { label: string; progress: number; onCancel?: () => void }) {
  const pct = Math.round((progress || 0) * 100);
  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 16px", marginTop: 12, display: "flex", alignItems: "center", gap: 12 }}>
      <span className="fo-spin" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5, marginBottom: 8 }}>
          <span style={{ color: "var(--text)" }}>{label}</span>
          <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>{pct > 0 ? `${pct}%` : "iniciando…"}</span>
        </div>
        <div style={{ height: 5, background: "var(--panel3)", borderRadius: 999, overflow: "hidden" }}>
          <div className={pct === 0 ? "fo-indet" : undefined}
            style={{ width: pct === 0 ? "30%" : `${pct}%`, height: "100%", borderRadius: 999, background: "linear-gradient(90deg, #bdbdbd, #f2f2f2)", transition: "width .4s" }} />
        </div>
      </div>
      {onCancel && (
        <button onClick={onCancel} style={{ fontSize: 12, color: "var(--red)", background: "transparent", border: "1px solid var(--border)", padding: "4px 16px", flex: "0 0 auto" }}>
          parar
        </button>
      )}
    </div>
  );
}

/**
 * Controle de TEMPO DE TELA do motion: o usuário arrasta/digita os segundos e o vídeo
 * re-encaixa por velocidade (só time-fit — instantâneo, sem gerar de novo). "auto"
 * volta pro tempo da fala.
 */
function DurationControl({ ph, target, busy, onAjustar }: {
  ph: FlowPhrase; target: number; busy: boolean; onAjustar: (ph: FlowPhrase, d: number | undefined) => void;
}) {
  const manual = ph.overrideDuration && ph.overrideDuration > 0;
  const [val, setVal] = useState(target);
  useEffect(() => { setVal(target); }, [target]);
  const aplicar = (d: number) => { const clamp = Math.max(0.5, Math.min(30, +d.toFixed(1))); setVal(clamp); onAjustar(ph, clamp); };

  return (
    <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>Tempo de tela</span>
      <input type="range" min={0.5} max={15} step={0.1} value={val} disabled={busy}
        onChange={(e) => setVal(+e.target.value)} onMouseUp={(e) => aplicar(+(e.target as HTMLInputElement).value)}
        onTouchEnd={(e) => aplicar(+(e.target as HTMLInputElement).value)}
        style={{ flex: 1, minWidth: 120, accentColor: "var(--accent)" }} />
      <input type="number" min={0.5} max={30} step={0.1} value={val} disabled={busy}
        onChange={(e) => setVal(+e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") aplicar(+(e.target as HTMLInputElement).value); }}
        onBlur={(e) => aplicar(+e.target.value)}
        style={{ width: 64, fontSize: 12, textAlign: "right" }} />
      <span style={{ fontSize: 12, color: "var(--faint)" }}>s</span>
      {manual
        ? <button onClick={() => onAjustar(ph, undefined)} disabled={busy} style={{ fontSize: 11.5, background: "transparent", color: "var(--muted)" }}>auto (fala)</button>
        : <span style={{ fontSize: 11, color: "var(--faint)" }}>= fala</span>}
      {busy && <span style={{ fontSize: 11, color: "var(--green)" }}>encaixando…</span>}
    </div>
  );
}

/**
 * EDITOR DE MOTIONS NA TIMELINE — tudo junto: a timeline do VÍDEO (com cortes) e os
 * MOTIONS como blocos. Em cada motion, os clipes aparecem em sequência:
 *  • arrastar o CORPO de um clipe move o motion inteiro no tempo do vídeo (muda o `at`);
 *  • arrastar a BORDA direita de um clipe muda a velocidade dele (acelera/desacelera,
 *    re-encaixa por time-fit — nunca corta) e o motion se re-concatena.
 * O ▶ toca SÓ O ÁUDIO (sem imagem, leve) com um cursor cruzando a timeline, pra você
 * acertar o tempo exato ouvindo a fala.
 */
function MotionEditor({ durationSec, cuts, moments, popups, getTimes, jobs, videoFile, onAjustar, onPatch, onClose }: {
  durationSec: number; cuts: Cut[]; moments: FlowMoment[]; popups: FullscreenPopup[];
  getTimes: (ph: FlowPhrase) => { srcStart: number; srcDur: number; target: number };
  jobs: Record<string, JobUI>; videoFile?: File;
  onAjustar: (ph: FlowPhrase, d: number | undefined) => void;
  onPatch: (id: string, patch: Partial<FullscreenPopup>) => void;
  onClose: () => void;
}) {
  const dur = Math.max(0.1, durationSec);
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackW, setTrackW] = useState(960);
  useEffect(() => {
    const el = trackRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth));
    ro.observe(el); setTrackW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const pps = trackW / dur;

  // relaciona cada popup colocado ao seu momento (popup.flowPhraseId === moment.id)
  const blocks = popups.map((p) => {
    const m = moments.find((mm) => mm.id === p.flowPhraseId);
    const clips = m ? m.phrases.filter((ph) => ph.fittedVideoPath) : [];
    return { p, clips };
  }).filter((b) => b.clips.length > 0);

  // estado vivo: posição por popup, duração por clipe (drag mexe; ao soltar, aplica)
  const [ats, setAts] = useState<Record<string, number>>({});
  const [durs, setDurs] = useState<Record<string, number>>({});
  useEffect(() => { setAts(Object.fromEntries(popups.map((p) => [p.id, p.at]))); }, [popups]);
  useEffect(() => {
    setDurs(Object.fromEntries(blocks.flatMap((b) => b.clips.map((ph) => [ph.id, getTimes(ph).target]))));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moments, popups]);
  const clipDur = (ph: FlowPhrase) => durs[ph.id] ?? getTimes(ph).target;
  const blockTotal = (clips: FlowPhrase[]) => clips.reduce((a, ph) => a + clipDur(ph), 0);

  // ── PLAYBACK só de áudio ──
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioUrl, setAudioUrl] = useState<string>();
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  useEffect(() => {
    if (!videoFile) return;
    const u = URL.createObjectURL(videoFile); setAudioUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [videoFile]);
  useEffect(() => {
    let raf = 0;
    const tick = () => { const a = audioRef.current; if (a) setTime(a.currentTime); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, []);
  const togglePlay = () => {
    const a = audioRef.current; if (!a) return;
    if (a.paused) { a.play().catch(() => {}); setPlaying(true); } else { a.pause(); setPlaying(false); }
  };
  const seek = (clientX: number) => {
    const el = trackRef.current, a = audioRef.current; if (!el || !a) return;
    const x = clientX - el.getBoundingClientRect().left;
    a.currentTime = Math.max(0, Math.min(dur, x / pps));
    setTime(a.currentTime);
  };

  // ── DRAG (mover motion / redimensionar clipe) ──
  const drag = useRef<{ kind: "move" | "resize"; popupId: string; phraseId?: string; startX: number; startVal: number; total: number } | null>(null);
  const startMove = (e: React.PointerEvent, popupId: string, at: number, total: number) => {
    e.preventDefault(); e.stopPropagation();
    drag.current = { kind: "move", popupId, startX: e.clientX, startVal: at, total };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const startResize = (e: React.PointerEvent, popupId: string, ph: FlowPhrase) => {
    e.preventDefault(); e.stopPropagation();
    drag.current = { kind: "resize", popupId, phraseId: ph.id, startX: e.clientX, startVal: clipDur(ph), total: 0 };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current; if (!d) return;
      const delta = (e.clientX - d.startX) / pps;
      if (d.kind === "move") {
        const nat = Math.max(0, Math.min(dur - d.total, +(d.startVal + delta).toFixed(2)));
        setAts((prev) => ({ ...prev, [d.popupId]: nat }));
      } else {
        const nd = Math.max(0.5, Math.min(30, +(d.startVal + delta).toFixed(1)));
        setDurs((prev) => ({ ...prev, [d.phraseId!]: nd }));
      }
    };
    const up = () => {
      const d = drag.current; if (!d) return; drag.current = null;
      if (d.kind === "move") {
        const nat = ats[d.popupId];
        if (nat != null && Math.abs(nat - d.startVal) > 0.02) onPatch(d.popupId, { at: nat });
      } else {
        const ph = blocks.flatMap((b) => b.clips).find((c) => c.id === d.phraseId);
        const nd = durs[d.phraseId!];
        if (ph && nd != null && Math.abs(nd - d.startVal) > 0.05) onAjustar(ph, nd);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  });

  const activeCuts = cuts.filter((c) => c.enabled);
  const step = dur > 60 ? 10 : dur > 20 ? 5 : 2;
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const anyBusy = blocks.some((b) => b.clips.some((c) => jobs[c.id]?.kind === "animate"));

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(6px)", display: "grid", placeItems: "center" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: "min(1180px, 96vw)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 16, boxShadow: "0 24px 80px rgba(0,0,0,0.6)", padding: "20px 24px" }}>
        {audioUrl && <audio ref={audioRef} src={audioUrl} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />}

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <strong style={{ fontSize: 15 }}>Ajustar motions na timeline</strong>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>arraste o corpo pra mover · a borda direita pra acelerar/desacelerar</span>
          <span style={{ flex: 1 }} />
          {anyBusy && <span style={{ fontSize: 11, color: "var(--green)" }}>encaixando…</span>}
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 8, padding: 0, fontSize: 15 }}>×</button>
        </div>

        {/* transporte: play SÓ do áudio */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <button onClick={togglePlay} disabled={!audioUrl} title={audioUrl ? "tocar áudio (sem imagem)" : "áudio indisponível"}
            style={{ width: 38, height: 38, borderRadius: "50%", padding: 0, display: "grid", placeItems: "center", background: "var(--accent)", color: "#1a1a1a" }}>
            {playing ? "❚❚" : "▶"}
          </button>
          <span style={{ fontSize: 12, color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>{fmt(time)} / {fmt(dur)}</span>
          <span style={{ fontSize: 11, color: "var(--faint)" }}>tocando só o áudio (sem vídeo) — clique na régua pra pular</span>
        </div>

        <div ref={trackRef} style={{ position: "relative" }}>
          {/* régua (clicável = seek) */}
          <div onClick={(e) => seek(e.clientX)} style={{ position: "relative", height: 16, marginBottom: 4, cursor: "text" }}>
            {Array.from({ length: Math.floor(dur / step) + 1 }).map((_, i) => (
              <span key={i} style={{ position: "absolute", left: i * step * pps, fontSize: 9, color: "var(--faint)", transform: "translateX(-50%)" }}>{fmt(i * step)}</span>
            ))}
          </div>

          {/* FAIXA vídeo (cortes) */}
          <div style={{ fontSize: 10, color: "var(--faint)", textTransform: "uppercase", letterSpacing: 0.6, margin: "2px 0 3px" }}>Vídeo</div>
          <div onClick={(e) => seek(e.clientX)} style={{ position: "relative", height: 38, background: "var(--panel2)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", cursor: "text" }}>
            {activeCuts.map((c) => (
              <div key={c.id} title={`corte ${c.start.toFixed(1)}–${c.end.toFixed(1)}s`}
                style={{ position: "absolute", top: 0, bottom: 0, left: c.start * pps, width: Math.max(1, (c.end - c.start) * pps),
                  background: "repeating-linear-gradient(45deg, rgba(255,93,93,0.25) 0 6px, rgba(255,93,93,0.10) 6px 12px)", borderLeft: "1px solid var(--red)", borderRight: "1px solid var(--red)" }} />
            ))}
          </div>

          {/* FAIXA motion (blocos = clipes em sequência) */}
          <div style={{ fontSize: 10, color: "var(--faint)", textTransform: "uppercase", letterSpacing: 0.6, margin: "12px 0 3px" }}>Motion</div>
          <div style={{ position: "relative", height: 64, background: "var(--panel2)", border: "1px solid var(--border)", borderRadius: 8 }}>
            {blocks.map(({ p, clips }, bi) => {
              const at = ats[p.id] ?? p.at;
              const total = blockTotal(clips);
              let acc = 0;
              return (
                <div key={p.id} style={{ position: "absolute", top: 4, bottom: 4, left: at * pps, width: Math.max(24, total * pps) }}>
                  {clips.map((ph) => {
                    const d = clipDur(ph);
                    const left = acc; acc += d;
                    const busy = jobs[ph.id]?.kind === "animate";
                    const raw = ph.fitInfo?.rawDuration ?? d;
                    const speed = raw / Math.max(0.1, d);
                    return (
                      <div key={ph.id} onPointerDown={(e) => startMove(e, p.id, at, total)}
                        title={`Motion ${bi + 1} · "${ph.text}" · ${d.toFixed(1)}s ×${speed.toFixed(2)}`}
                        style={{ position: "absolute", top: 0, bottom: 0, left: left * pps, width: Math.max(18, d * pps),
                          background: "var(--active-grad)", border: "1px solid var(--border-active)", borderRadius: 8, cursor: "grab",
                          boxShadow: "var(--shadow-active)", overflow: "hidden", opacity: busy ? 0.6 : 1 }}>
                        {ph.fittedVideoPath && <video src={comBase(ph.fittedVideoPath)} muted preload="metadata"
                          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.4, pointerEvents: "none" }} />}
                        <span style={{ position: "absolute", left: 6, top: 5, fontSize: 10, color: "var(--text)", fontWeight: 600, whiteSpace: "nowrap", textShadow: "0 1px 3px rgba(0,0,0,0.6)" }}>{d.toFixed(1)}s</span>
                        <span style={{ position: "absolute", left: 6, bottom: 4, fontSize: 9, color: speed > 1.5 || speed < 0.7 ? "#ffb0b0" : "var(--faint)", textShadow: "0 1px 3px rgba(0,0,0,0.6)" }}>×{speed.toFixed(2)}</span>
                        {/* alça de borda direita = velocidade deste clipe */}
                        <div onPointerDown={(e) => startResize(e, p.id, ph)}
                          style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: 12, cursor: "ew-resize", display: "grid", placeItems: "center" }}>
                          <span style={{ width: 3, height: 26, borderRadius: 2, background: "var(--accent)" }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {/* cursor de reprodução */}
            <div style={{ position: "absolute", top: -60, bottom: -4, left: time * pps, width: 2, background: "var(--accent)", pointerEvents: "none", boxShadow: "0 0 6px rgba(255,255,255,0.4)" }} />
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 16 }}>
          <span style={{ fontSize: 11.5, color: "var(--faint)" }}>Faixas vermelhas = cortes (o motion ignora e segue tocando). Corpo do clipe move o motion; borda direita muda a velocidade.</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={{ fontSize: 12.5, background: "var(--accent)", color: "#1a1a1a", fontWeight: 600, padding: "8px 20px", borderRadius: 12 }}>Concluir</button>
        </div>
      </div>
    </div>
  );
}

/**
 * CHAT DE DESIGN — imita o ChatGPT: anexa imagens (upload ou presets de layout),
 * escreve o que quer, envia; a resposta é uma imagem. Dá pra iterar em cima do
 * último resultado ("continuar") e escolher qualquer resposta como o design.
 */
function DesignChat({ ph, busy, job, onZoom, onSend, onGerarDesign, cores, onUse, onCancel, onPatch }: {
  ph: FlowPhrase; busy: boolean; job?: JobUI; onZoom: (src: string) => void;
  onSend: (ph: FlowPhrase, texto: string, imagens: string[], usarIdentidade: boolean, continuar: boolean) => void;
  onGerarDesign: (ph: FlowPhrase, layoutSrc: string | undefined, estiloSrc: string | undefined, prompt: string, modo?: "restyle" | "esboco", elementos?: string[]) => void;
  cores?: string;
  onUse: (ph: FlowPhrase, url: string) => void;
  onCancel: (ph: FlowPhrase) => void;
  onPatch: (p: Partial<FlowPhrase>) => void;
}) {
  const [text, setText] = useState("");
  const [attach, setAttach] = useState<{ id: string; src: string; name?: string }[]>([]);
  const [layoutSrc, setLayoutSrc] = useState<string | undefined>();  // slot LAYOUT (esquerda)
  const [estiloSrc, setEstiloSrc] = useState<string | undefined>();  // slot ESTILO (direita)
  const [delta, setDelta] = useState("");                            // o prompt (o que ter/não ter/mudanças)
  // 3 OPÇÕES de geração: layout+estilo (restyle) · esboço (canvas → blueprint) · chat (freestyle)
  const [genMode, setGenMode] = useState<"layout" | "esboco" | "chat">("layout");
  const [sketchOpen, setSketchOpen] = useState(false);
  const [sketchPng, setSketchPng] = useState<string | undefined>();  // PNG exportado do canvas (sessão)
  // ELEMENTOS (referências secundárias, até 4): objetos replicados fielmente na tela
  // (nota amassada, logo, produto…) — o LUGAR deles vem do prompt/esboço.
  const [elementos, setElementos] = useState<{ id: string; src: string }[]>([]);
  const [tab, setTab] = useState<"chat" | "presets">("chat");
  const [usarIdentidade, setUsarIdentidade] = useState(true);
  const [continuar, setContinuar] = useState(true);
  const msgs = ph.designChat ?? [];
  const hasResult = msgs.some((m) => m.role === "assistant" && m.images?.length);

  // COMPORTAMENTO DE CHAT: sempre mostrar a ÚLTIMA mensagem (rolado no fim), não o início.
  // Re-rola ao abrir a aba, ao chegar mensagem e quando as imagens carregam (mudam a altura).
  const chatRef = useRef<HTMLDivElement>(null);
  const scrollBottom = () => { const el = chatRef.current; if (el) el.scrollTop = el.scrollHeight; };
  useEffect(() => { if (genMode === "chat") scrollBottom(); }, [genMode, msgs.length, job?.kind, ph.id]);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach((f) => readDataUrl(f, (src) => setAttach((v) => [...v, { id: uid(), src, name: f.name }])));
  };
  const addPreset = async (url: string, nome: string) => {
    try {
      const blob = await (await fetch(url)).blob();
      const src = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.readAsDataURL(blob); });
      setAttach((v) => [...v, { id: uid(), src, name: nome }]);
      setTab("chat");
    } catch { /* preset ausente */ }
  };
  const enviar = () => {
    if (!text.trim() || busy) return;
    onSend(ph, text, attach.map((a) => a.src), usarIdentidade, continuar && hasResult);
    setText(""); setAttach([]);
  };

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 12, marginTop: 8, background: "var(--panel)" }}>
      <style>{`
        .fo-msg { display: flex; margin-bottom: 8px; }
        .fo-msg.in  { justify-content: flex-start; }
        .fo-msg.out { justify-content: flex-end; }
        .fo-bubble {
          max-width: 78%; padding: 12px 16px; font-size: 13px; line-height: 1.55;
          border-radius: 16px; white-space: pre-wrap;
        }
        .fo-msg.out .fo-bubble {
          background: linear-gradient(180deg, #f6f6f6, #d9d9d9); color: #1a1a1a;
          border-bottom-right-radius: 6px;
        }
        .fo-msg.in .fo-bubble {
          background: var(--panel3); color: var(--text);
          border-bottom-left-radius: 6px;
        }
        .fo-designcard {
          max-width: 78%; background: var(--panel3); border-radius: 16px;
          border-bottom-left-radius: 6px; padding: 12px;
        }
        .fo-designcard img { display: block; cursor: zoom-in; border-radius: 10px; }
        .fo-usebtn {
          display: flex; align-items: center; justify-content: center; gap: 8px;
          width: 100%; margin-top: 8px; padding: 8px 12px; border: none; border-radius: 10px;
          background: var(--panel2); color: var(--text); font-size: 12.5px; cursor: pointer;
        }
        .fo-usebtn:hover { background: #333; }
        .fo-usebtn[data-on="true"] { background: linear-gradient(180deg, #f6f6f6, #d9d9d9); color: #1a1a1a; font-weight: 600; }
        .fo-typing { display: inline-flex; gap: 4px; align-items: center; }
        .fo-typing i {
          width: 6px; height: 6px; border-radius: 50%; background: var(--muted);
          animation: fo-blink 1.2s infinite ease-in-out;
        }
        .fo-typing i:nth-child(2) { animation-delay: 0.2s; }
        .fo-typing i:nth-child(3) { animation-delay: 0.4s; }
        @keyframes fo-blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
      `}</style>

      {/* GERAÇÃO — 3 OPÇÕES: Layout+Estilo (restyle) · Esboço (blueprint) · Freestyle (chat) */}
      <div style={{ padding: "12px 16px", borderBottom: genMode === "chat" ? undefined : "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>Gerar tela</div>
          <div style={{ display: "inline-flex", background: "var(--panel2)", border: "1px solid var(--border)", borderRadius: 12, padding: 2, gap: 2 }}>
            {([["layout", "Layout + Estilo"], ["esboco", "Esboço"], ["chat", "Freestyle (chat)"]] as const).map(([id, label]) => (
              <button key={id} onClick={() => setGenMode(id)}
                style={{ border: "none", borderRadius: 8, padding: "4px 12px", fontSize: 11.5, cursor: "pointer",
                  background: genMode === id ? "var(--active-grad)" : "transparent",
                  color: genMode === id ? "var(--text)" : "var(--muted)", fontWeight: genMode === id ? 600 : 400 }}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {genMode !== "chat" && (
          <>
            <div style={{ display: "flex", gap: 12, alignItems: "stretch" }}>
              {genMode === "layout" ? (
                /* slot LAYOUT: um design PRONTO cuja composição é preservada (restyle) */
                <label title="LAYOUT: um design pronto — a composição dele é preservada"
                  style={{ width: 84, minHeight: 120, flexShrink: 0, borderRadius: 8, border: "1px dashed var(--border)", display: "grid", placeItems: "center", cursor: "pointer", overflow: "hidden", background: "var(--panel3)", position: "relative" }}>
                  {layoutSrc
                    ? <img src={comBase(layoutSrc)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    : <span style={{ fontSize: 11, color: "var(--muted)", textAlign: "center", lineHeight: 1.4 }}>+ LAYOUT<br />(design)</span>}
                  <input type="file" accept="image/*" style={{ display: "none" }} disabled={busy}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) readDataUrl(f, (s) => setLayoutSrc(s)); e.target.value = ""; }} />
                  {layoutSrc && <button onClick={(e) => { e.preventDefault(); setLayoutSrc(undefined); }}
                    style={{ position: "absolute", top: 2, right: 2, width: 16, height: 16, lineHeight: "14px", padding: 0, fontSize: 11, borderRadius: "50%", border: "none", background: "var(--red)", color: "#fff", cursor: "pointer" }}>×</button>}
                </label>
              ) : (
                /* slot ESBOÇO: abre o canvas; o PNG exportado é o blueprint GEOMÉTRICO */
                <button onClick={() => setSketchOpen(true)} disabled={busy}
                  title="abrir o canvas do esboço — desenhe ONDE cada coisa fica"
                  style={{ width: 84, minHeight: 120, flexShrink: 0, borderRadius: 8, border: "1px dashed var(--purple)", display: "grid", placeItems: "center", cursor: "pointer", overflow: "hidden", background: "var(--panel3)", padding: 0 }}>
                  {sketchPng
                    ? <img src={comBase(sketchPng)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    : <span style={{ fontSize: 11, color: "var(--purple)", textAlign: "center", lineHeight: 1.4 }}>✏ ESBOÇO<br />(abrir canvas)</span>}
                </button>
              )}
              {/* slot ESTILO (comum aos dois): só a linguagem visual */}
              <label title="ESTILO: tipografia / material / luz — nunca a composição"
                style={{ width: 84, minHeight: 120, flexShrink: 0, borderRadius: 8, border: "1px dashed var(--border)", display: "grid", placeItems: "center", cursor: "pointer", overflow: "hidden", background: "var(--panel3)", position: "relative" }}>
                {estiloSrc
                  ? <img src={comBase(estiloSrc)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  : <span style={{ fontSize: 11, color: "var(--muted)", textAlign: "center", lineHeight: 1.4 }}>+ ESTILO<br />(visual)</span>}
                <input type="file" accept="image/*" style={{ display: "none" }} disabled={busy}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) readDataUrl(f, (s) => setEstiloSrc(s)); e.target.value = ""; }} />
                {estiloSrc && <button onClick={(e) => { e.preventDefault(); setEstiloSrc(undefined); }}
                  style={{ position: "absolute", top: 2, right: 2, width: 16, height: 16, lineHeight: "14px", padding: 0, fontSize: 11, borderRadius: "50%", border: "none", background: "var(--red)", color: "#fff", cursor: "pointer" }}>×</button>}
              </label>
              <textarea value={delta} onChange={(e) => setDelta(e.target.value)}
                placeholder={genMode === "esboco"
                  ? "prompt — o CONTEÚDO: textos, branding, ajustes. A geometria vem do esboço; o estilo, da referência."
                  : "prompt — o que ter, o que não ter, mudanças no design e no estilo. Ex.: personagem à esquerda, sino de notificação; sem texto extra."}
                style={{ flex: 1, minHeight: 120, resize: "vertical", fontSize: 13, padding: 12, borderRadius: 8, background: "var(--panel3)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit" }} />
            </div>
            {/* ELEMENTOS: referências secundárias que DEVEM aparecer na tela (réplica fiel).
                Cite-os no prompt ("elemento 1 no canto") — o lugar vem do prompt/esboço. */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "var(--faint)" }}>elementos:</span>
              {elementos.map((el, i) => (
                <span key={el.id} style={{ position: "relative", width: 44, height: 44, borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)" }}
                  title={`ELEMENTO ${i + 1} — replicado fielmente na tela; cite no prompt onde ele vai`}>
                  <img src={comBase(el.src)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  <button onClick={() => setElementos((v) => v.filter((x) => x.id !== el.id))}
                    style={{ position: "absolute", top: 0, right: 0, width: 14, height: 14, lineHeight: "12px", padding: 0, fontSize: 10, border: "none", background: "var(--red)", color: "#fff", cursor: "pointer" }}>×</button>
                  <span style={{ position: "absolute", bottom: 0, left: 0, fontSize: 9, fontWeight: 700, background: "rgba(0,0,0,0.7)", color: "#fff", padding: "0 4px", borderTopRightRadius: 4 }}>{i + 1}</span>
                </span>
              ))}
              {elementos.length < 4 && (
                <label title="anexar um objeto que deve aparecer na tela (nota, logo, produto…) — réplica fiel"
                  style={{ width: 44, height: 44, borderRadius: 8, border: "1px dashed var(--border)", display: "grid", placeItems: "center", cursor: "pointer", fontSize: 16, color: "var(--muted)", background: "var(--panel3)" }}>
                  +
                  <input type="file" accept="image/*" multiple style={{ display: "none" }} disabled={busy}
                    onChange={(e) => {
                      Array.from(e.target.files ?? []).slice(0, 4 - elementos.length)
                        .forEach((f) => readDataUrl(f, (src) => setElementos((v) => v.length < 4 ? [...v, { id: uid(), src }] : v)));
                      e.target.value = "";
                    }} />
                </label>
              )}
              <span style={{ fontSize: 10, color: "var(--faint)" }}>objetos a replicar (ex.: nota, logo) — diga no prompt onde cada um vai</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
              <span style={{ fontSize: 11, color: cores?.trim() ? "var(--faint)" : "var(--muted)" }}>
                {cores?.trim() ? `COLOR LAW: ${cores}` : "sem cores definidas — a paleta virá da imagem de estilo"}
              </span>
              <button disabled={busy}
                onClick={() => {
                  const els = elementos.map((e) => e.src);
                  if (genMode === "esboco") {
                    if (!sketchPng) { setSketchOpen(true); return; } // sem esboço → abre o canvas
                    onGerarDesign(ph, sketchPng, estiloSrc, delta, "esboco", els);
                  } else onGerarDesign(ph, layoutSrc, estiloSrc, delta, "restyle", els);
                }}
                style={{ marginLeft: "auto", background: "var(--accent)", color: "#1a1a1a", fontWeight: 600, fontSize: 13, padding: "8px 16px", borderRadius: 12, border: "none", cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }}>
                {busy ? "Gerando…" : genMode === "esboco" && !sketchPng ? "Abrir esboço" : "Gerar tela"}
              </button>
            </div>
          </>
        )}
      </div>

      {/* CANVAS DO ESBOÇO (tldraw): o snapshot persiste na frase; o PNG vira o blueprint */}
      {sketchOpen && (
        <SketchCanvas aspect={ph.aspect ?? "9:16"} snapshot={ph.esboco} phraseId={ph.id}
          onUse={(png, snap) => { setSketchPng(png); onPatch({ esboco: snap }); setSketchOpen(false); }}
          onClose={() => setSketchOpen(false)} />
      )}

      {/* FREESTYLE (chat): o texto vai verbatim + imagens anexadas — controle total do usuário.
          Fica MONTADO (display) pra preservar histórico/scroll ao alternar de aba. */}
      <div style={{ display: genMode === "chat" ? "block" : "none" }}>
      {/* histórico — bolhas de chat: você à direita (clara), a IA à esquerda (card) */}
      <div ref={chatRef} style={{ maxHeight: 460, overflowY: "auto", padding: "16px 16px 8px", display: "flex", flexDirection: "column" }}>
        {msgs.length === 0 && (
          <span style={{ fontSize: 12, color: "var(--faint)", textAlign: "center", padding: "12px 0 16px" }}>
            anexe imagens, descreva a tela que você quer e envie
          </span>
        )}
        {msgs.map((m) => m.role === "user" ? (
          <div key={m.id} className="fo-msg out">
            <div className="fo-bubble">
              {m.text}
              {(m.images?.length ?? 0) > 0 && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                  {m.images!.map((src, i) => (
                    <img key={i} src={comBase(src)} alt="" onClick={() => onZoom(src)} onLoad={scrollBottom}
                      style={{ height: 46, borderRadius: 8, cursor: "zoom-in", display: "block" }} />
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div key={m.id} className="fo-msg in">
            <div className="fo-designcard">
              {m.images?.map((src, i) => (
                <div key={i}>
                  <img src={comBase(src)} alt="" onClick={() => onZoom(src)} onLoad={scrollBottom} title="clique p/ ampliar" style={{ maxHeight: 300 }} />
                  <button onClick={() => onUse(ph, src)} className="fo-usebtn" data-on={ph.imagePath === src}>
                    {ph.imagePath === src ? "✓ em uso" : "usar este design"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
        {job?.kind === "design" && (
          <div className="fo-msg in">
            <div className="fo-bubble" style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span className="fo-typing"><i /><i /><i /></span>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>gerando… ~1-2 min</span>
              <a onClick={() => onCancel(ph)} style={{ color: "var(--red)", cursor: "pointer", fontSize: 12 }}>parar</a>
            </div>
          </div>
        )}
      </div>

      {/* entrada — caixa única com rodapé de dicas, estilo Claude Code */}
      <div style={{ padding: "0 12px 12px" }}>
        {tab === "presets" && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "8px 2px" }}>
            {FLOW_LAYOUT_TEMPLATES.map((t) => (
              <div key={t.id} onClick={() => addPreset(t.url, t.nome)} title={`anexar ${t.nome}`} className="fo-card"
                style={{ cursor: "pointer", width: 78, border: "1px solid var(--border)", borderRadius: 12, padding: 2, background: "var(--panel2)" }}>
                <div style={{ position: "relative", width: "100%", height: 110, borderRadius: 8, background: "var(--panel3)", display: "grid", placeItems: "center", overflow: "hidden" }}>
                  <span style={{ fontSize: 10, color: "var(--faint)" }}>{t.nome}</span>
                  <img src={comBase(t.url)} alt={t.nome} onError={(e) => { e.currentTarget.style.display = "none"; }}
                    style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
                </div>
              </div>
            ))}
          </div>
        )}
        {attach.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "8px 2px" }}>
            {attach.map((a) => (
              <div key={a.id} style={{ position: "relative" }} title={a.name}>
                <img src={comBase(a.src)} alt="" style={{ height: 48, borderRadius: 8, border: "1px solid var(--border)" }} />
                <button onClick={() => setAttach((v) => v.filter((x) => x.id !== a.id))}
                  style={{ position: "absolute", top: -6, right: -6, width: 16, height: 16, lineHeight: "13px", padding: 0, fontSize: 11, borderRadius: "50%", border: "none", background: "var(--red)", color: "#fff", cursor: "pointer" }}>×</button>
              </div>
            ))}
          </div>
        )}

        {/* caixa de entrada — design da referência, nas cores do editor */}
        <div className="fo-inputbox">
          <style>{`
            .fo-inputbox {
              background: var(--panel2);
              border: 1px solid var(--border);
              border-radius: 16px;
              box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
              padding: 16px 16px 12px;
              transition: border-color 0.18s ease, box-shadow 0.18s ease;
            }
            .fo-inputbox:focus-within {
              border-color: var(--border-active);
              box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.05), 0 8px 24px rgba(0, 0, 0, 0.3);
            }
            .fo-chip {
              display: inline-flex; align-items: center; gap: 8px;
              background: var(--panel3); border: 1px solid var(--border); border-radius: 999px;
              padding: 4px 12px; font-size: 12px; font-weight: 500; color: var(--muted);
              cursor: pointer; white-space: nowrap; transition: background 0.18s, color 0.18s;
            }
            .fo-chip:hover { background: #2c2c36; color: var(--text); transform: none; box-shadow: none; }
            .fo-chip[data-on="true"] { color: var(--text); border-color: var(--border-active); background: var(--active-grad); box-shadow: var(--shadow-active); }
            .fo-action {
              display: inline-flex; align-items: center; gap: 8px;
              background: none; border: none; font-size: 13px; color: var(--muted);
              cursor: pointer; padding: 4px 0; border-radius: 0; transition: color 0.18s;
            }
            .fo-action:hover { color: var(--text); transform: none; box-shadow: none; background: none; }
            .fo-send {
              width: 34px; height: 34px; border: none; border-radius: 999px;
              background: linear-gradient(180deg, #f6f6f6, #d9d9d9);
              color: #1a1a1a; display: inline-flex; align-items: center; justify-content: center;
              cursor: pointer; padding: 0; transition: transform 0.18s, opacity 0.18s;
            }
            .fo-send:hover:not(:disabled) { transform: scale(1.06); box-shadow: none; background: linear-gradient(180deg, #f6f6f6, #d9d9d9); }
            .fo-send:disabled { opacity: 0.35; }
          `}</style>

          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <textarea value={text}
              onChange={(e) => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); } }}
              placeholder="Descreva a tela que você quer…"
              rows={1} maxLength={1000}
              style={{ flex: 1, background: "transparent", border: "none", outline: "none", resize: "none", boxShadow: "none",
                fontFamily: "inherit", fontSize: 14, color: "var(--text)", lineHeight: 1.5, minHeight: 44, padding: 0 }} />
            <button className="fo-chip" data-on={usarIdentidade} onClick={() => setUsarIdentidade(!usarIdentidade)}
              title="injeta cores/fonte da identidade do projeto no prompt">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 3a15 15 0 0 1 0 18" /></svg>
              Identidade
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
              <label className="fo-action" title="anexar imagens (referência, layout, elementos)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
                Anexar
                <input type="file" accept="image/*" multiple style={{ display: "none" }} onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
              </label>
              <button className="fo-action" onClick={() => setTab(tab === "presets" ? "chat" : "presets")}
                style={{ color: tab === "presets" ? "var(--accent-text)" : undefined }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>
                Presets
              </button>
              {hasResult && (
                <button className="fo-action" data-on={continuar} onClick={() => setContinuar(!continuar)}
                  style={{ color: continuar ? "var(--accent-text)" : undefined }}
                  title="anexa o último resultado — bom pra pedir ajustes">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
                  Continuar do último
                </button>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12, color: "var(--faint)" }}>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{text.length}/1000</span>
              <button className="fo-send" onClick={enviar} disabled={busy || !text.trim()} aria-label="enviar" title="enviar (⏎)">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

/** Seletor de FONTE REAL — campo com label acima + preview vivo (Google Fonts). */
function FontSelect({ value, onChange }: { value?: string; onChange: (v: string | undefined) => void }) {
  useEffect(() => { ensureGoogleFonts(); }, []);
  const sel = IDENTITY_FONTES.find((f) => f.id === value);
  return (
    <div className="fo-field">
      <label>Fonte</label>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">Escolher…</option>
        {IDENTITY_FONTES.map((f) => <option key={f.id} value={f.id} style={{ fontFamily: f.css }}>{f.nome}</option>)}
      </select>
      {sel && (
        <div title={sel.nome} style={{ fontFamily: sel.css, fontWeight: 700, fontSize: 17, lineHeight: 1, padding: "8px 12px", marginTop: 8, background: "var(--field)", border: "1px solid var(--field-border)", borderRadius: 8, display: "inline-block" }}>
          Aa Bb 123
        </div>
      )}
    </div>
  );
}

/** Select da identidade — campo com label acima (sistema de formulário). */
function IdentitySelect({ label, options, value, onChange }: {
  label: string; options: IdentityOption[]; value?: string; onChange: (v: string | undefined) => void;
}) {
  return (
    <div className="fo-field">
      <label>{label}</label>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">Escolher…</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}
      </select>
    </div>
  );
}

/** Uploader de referências (imagens com tag), reutilizado na marca e por frase. */
function RefUploader({ refs, onChange, onZoom, tags, defaultTag }: {
  refs: FlowDesignRef[]; onChange: (refs: FlowDesignRef[]) => void; onZoom: (src: string) => void;
  tags: DesignRefTag[]; defaultTag: DesignRefTag;
}) {
  const [tag, setTag] = useState<DesignRefTag>(defaultTag);
  const opts = DESIGN_REF_TAGS.filter((t) => tags.includes(t.id));
  const add = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach((f) => readDataUrl(f, (src) => onChange([...refs, { id: uid(), tag, src, name: f.name }])));
  };
  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>anexar como:</span>
        <select value={tag} onChange={(e) => setTag(e.target.value as DesignRefTag)} style={{ fontSize: 12 }}>
          {opts.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <input type="file" accept="image/*" multiple style={{ fontSize: 12 }} onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
      </div>
      {refs.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          {(() => { let el = 0; return refs.map((r) => {
            const elNum = r.tag === "referencia" ? ++el : 0;
            return (
              <div key={r.id} style={{ position: "relative", width: 96 }} title={r.name ?? ""}>
                <img src={comBase(r.src)} alt="" onClick={() => onZoom(r.src)} title="clique p/ ampliar"
                  style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)", cursor: "zoom-in" }} />
                {elNum > 0 && (
                  <span style={{ position: "absolute", top: 4, left: 4, fontSize: 10, fontWeight: 700, background: "var(--accent)", color: "#1a1a1a", borderRadius: 4, padding: "1px 4px", pointerEvents: "none" }}>
                    elemento {elNum}
                  </span>
                )}
                <select value={r.tag} onChange={(e) => onChange(refs.map((x) => (x.id === r.id ? { ...x, tag: e.target.value as DesignRefTag } : x)))}
                  style={{ fontSize: 10, width: "100%", marginTop: 2 }} title="papel desta imagem">
                  {opts.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
                <button onClick={() => onChange(refs.filter((x) => x.id !== r.id))} style={{ position: "absolute", top: -6, right: -6, width: 16, height: 16, lineHeight: "14px", padding: 0, fontSize: 11, borderRadius: "50%", border: "none", background: "var(--red)", color: "#fff", cursor: "pointer" }}>×</button>
              </div>
            );
          }); })()}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: FlowPhrase["status"] }) {
  // badges SUAVES: fundo translúcido + texto na cor. Cores por FASE (cinza → azul →
  // roxo → verde) e ponto PULSANTE nos estados em andamento — dá pra ler o pipeline
  // de longe sem decorar rótulos.
  const map: Record<FlowPhrase["status"], [string, string, boolean?]> = {
    detected: ["detectada", "143,143,143"],
    designing: ["desenhando…", "154,164,200", true],
    design_ready: ["aguardando aprovação", "154,164,200"],
    approved: ["aprovada", "179,163,207"],
    animating: ["animando…", "179,163,207", true],
    video_ready: ["vídeo pronto", "88,196,120"],
    placed: ["na timeline", "88,196,120"],
    error: ["erro", "233,117,117"],
  };
  const [label, rgb, pulse] = map[status];
  const solid = status === "placed"; // na timeline = concluída (preenchimento mais forte)
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, padding: "2px 8px", borderRadius: 999,
      background: `rgba(${rgb},${solid ? 0.28 : 0.14})`, color: `rgb(${rgb})`, border: `1px solid rgba(${rgb},${solid ? 0.5 : 0.25})`, whiteSpace: "nowrap" }}>
      {pulse && <i className="fo-pulse" style={{ background: `rgb(${rgb})` }} />}
      {label}
    </span>
  );
}
