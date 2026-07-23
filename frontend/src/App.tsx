import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Cut, Zoom, Popup, Word, SupportPopup, FullscreenPopup, TranscriptSegment, Music, Caption } from "../../shared/timeline";
import { DEFAULT_POPUP_TRANSITION } from "../../shared/timeline";
import { ensureWordIds, syncCaptionsText, bootstrapCaptionWordIds, regroupByMaxWords } from "../../shared/captions";
import { TranscriptEditor } from "./modules/correcao/TranscriptEditor";
import { KaraokePreview } from "./modules/legenda/KaraokePreview";
import { Editor } from "./modules/editor/Editor";
import { ExportPanel } from "./modules/export/ExportPanel";
import { DEFAULT_STYLE, type CaptionStyle } from "../../shared/captionStyle";
import { DEFAULT_COLOR, type ColorSettings, type ColorPreset } from "../../shared/color";
import { DEFAULT_CHROMA, type ChromaSettings } from "../../shared/chroma";
import { emptyFlow, type FlowState, type FlowMoment } from "../../shared/flow";
import { parseCube, type ParsedLut } from "../../shared/lut";
import type { EditorDocument, ProjectFile } from "../../shared/project";
import { ColorPanel } from "./modules/color/ColorPanel";
import { ChromaPanel } from "./modules/chroma/ChromaPanel";
import { FlowPanel } from "./modules/flow/FlowPanel";
import { MusicPanel } from "./modules/music/MusicPanel";
import { ProjectsModal } from "./modules/projects/ProjectsModal";
import { Dock } from "./workspace/Dock";
import { CaptionControls } from "./modules/legenda/CaptionControls";
import { CaptionToolbar } from "./modules/legenda/CaptionToolbar";
import { CutTimeline } from "./modules/editor/CutTimeline";
import { TransportBus, type TransportState } from "./workspace/transport";
import { useHistory } from "./history/useHistory";
import { getClienteSlug, comBase } from "./os-session";
import { AssemblyEditor } from "./modules/assembly/AssemblyEditor";
import type { Assembly } from "../../shared/assembly";

/** Parte do documento coberta por undo/redo. */
interface Doc {
  transcript: TranscriptSegment[];
  cuts: Cut[];
  zooms: Zoom[];
  popups: Popup[];
  captionStyle: CaptionStyle;
  copy: string;
  color: ColorSettings;
  chroma: ChromaSettings;
  flow?: FlowState;
  music?: Music;
  /** Legendas com tempo manual. Vazio = derivadas da transcrição (ver shared/captions.ts). */
  captions: Caption[];
}
const EMPTY_DOC: Doc = {
  transcript: [], cuts: [], zooms: [], popups: [], captionStyle: DEFAULT_STYLE, copy: "",
  color: DEFAULT_COLOR, chroma: DEFAULT_CHROMA, flow: undefined, music: undefined, captions: [],
};
/** Metadados do vídeo/projeto que NÃO entram no undo (não mudam durante a edição). */
interface DocExtra { sourceVideo: string; durationSec: number; width: number; height: number; }

type Updater<V> = V | ((prev: V) => V);
type SaveState = "salvo" | "salvando" | "nao_salvo" | "erro" | "conflito";

function readVideoDims(src: string): Promise<{ w: number; h: number; dur: number }> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => resolve({ w: v.videoWidth, h: v.videoHeight, dur: v.duration });
    v.src = src;
  });
}

export function App() {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [lut, setLut] = useState<ParsedLut | null>(null);
  const [lutName, setLutName] = useState<string | null>(null);
  const [lutText, setLutText] = useState<string | null>(null);
  const [lutError, setLutError] = useState<string | null>(null);
  const [colorEnabled, setColorEnabled] = useState(true);

  const { state: doc, set: setDoc, reset, undo, redo, canUndo, canRedo } = useHistory<Doc>(EMPTY_DOC);

  // Projeto atual
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [docExtra, setDocExtra] = useState<DocExtra | null>(null);
  const [showProjects, setShowProjects] = useState(true);
  const [assembly, setAssembly] = useState<Assembly | undefined>(undefined); // Montador de origem
  const [showAssembly, setShowAssembly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("salvo");
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  const setField = <K extends keyof Doc>(key: K) => (v: Updater<Doc[K]>) =>
    setDoc((d) => ({ ...d, [key]: typeof v === "function" ? (v as (p: Doc[K]) => Doc[K])(d[key]) : v }));
  // Editar o roteiro reescreve o TEXTO das legendas materializadas na MESMA ação (por id,
  // sem mexer no timing) — é o que deixa corrigir a legenda mesmo depois de "Alinhar com a
  // fala". Sem legenda materializada, nada a sincronizar (ela já deriva do roteiro).
  const setTranscript = (v: Updater<Doc["transcript"]>) =>
    setDoc((d) => {
      const nt = typeof v === "function" ? (v as (p: Doc["transcript"]) => Doc["transcript"])(d.transcript) : v;
      return { ...d, transcript: nt, captions: d.captions.length ? syncCaptionsText(d.captions, nt) : d.captions };
    });
  const setCuts = setField("cuts");
  const setZooms = setField("zooms");
  const setPopups = setField("popups");
  const setCaptionStyle = setField("captionStyle");
  const setCopy = setField("copy");
  const setColor = setField("color");
  const setChroma = setField("chroma");
  const setFlow = setField("flow");
  const setMusic = setField("music");
  const setCaptions = setField("captions");

  const { transcript, cuts, zooms, popups, captionStyle, copy, color, chroma, flow, music, captions } = doc;

  // Mudança de estilo da legenda. Se mexeu em "palavras por linha" E já há legendas
  // materializadas, RE-AGRUPA junto (atômico) — senão o slider não valia depois de alinhar
  // (resolveCaptionLines usa as captions como estão e ignora o maxWords). O timing por palavra
  // é preservado; só a quebra de linhas muda.
  const onCaptionStyleChange = (next: CaptionStyle) => {
    if (next.maxWords !== captionStyle.maxWords && captions.length > 0) {
      setDoc((d) => ({ ...d, captionStyle: next, captions: regroupByMaxWords(d.captions, next.maxWords) }));
    } else {
      setCaptionStyle(next);
    }
  };
  // Insere/atualiza os popups do FLOW por flowPhraseId (recolocar não duplica).
  // clearIds extras: remove também popups antigos do mesmo momento (ex.: os por-frase
  // de antes do popup unificado por momento).
  const placeFlowPopups = (pops: Popup[], clearIds?: string[]) => setPopups((prev) => {
    const ids = new Set([...pops.map((p) => (p as { flowPhraseId?: string }).flowPhraseId), ...(clearIds ?? [])]);
    const kept = prev.filter((p) => !(p.type === "fullscreen" && (p as { flowPhraseId?: string }).flowPhraseId && ids.has((p as { flowPhraseId?: string }).flowPhraseId)));
    return [...kept, ...pops].sort((a, b) => a.at - b.at);
  });
  const [eyedropper, setEyedropper] = useState(false); // conta-gotas (chroma)
  const [showMask, setShowMask] = useState(false);      // ver máscara (chroma)
  const [anchoring, setAnchoring] = useState(false);    // alinhamento fino em andamento
  const [retranscribing, setRetranscribing] = useState(false); // retranscrição pulando cortes

  /**
   * Alinhamento FINO: o backend re-transcreve cada trecho de fala em janela curta
   * (timestamps locais não derivam) e adota os tempos novos onde o TEXTO casa com o
   * existente. Texto e linhas não mudam; fala sem legenda ganha linha nova. Leva ~30s.
   */
  async function realinharLegendas(base: Caption[]) {
    if (!projectId) { alert("Salve o projeto antes (a re-transcrição lê o vídeo do projeto no servidor)."); return; }
    setAnchoring(true);
    try {
      const r = await fetch(comBase("/api/realign-captions"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, captions: base, maxWords: captionStyle.maxWords }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Falha ao alinhar");
      setCaptions(data.captions as Caption[]);
      const extras = [
        data.added > 0 ? `${data.added} linha(s) nova(s) onde havia fala sem legenda` : "",
        data.removed > 0 ? `${data.removed} eco(s) duplicado(s) removido(s)` : "",
      ].filter(Boolean).join("; ");
      alert(`Legendas alinhadas com a fala: ${data.matched} de ${data.total} palavras casadas com a re-transcrição.${extras ? ` ${extras}.` : ""}`);
    } catch (e) {
      alert("Erro ao alinhar: " + (e as Error).message);
    } finally { setAnchoring(false); }
  }

  /**
   * RETRANSCREVER PULANDO OS CORTES: o backend renderiza só o áudio dos trechos mantidos na
   * timeline, transcreve e devolve o roteiro já no tempo de fonte. Troca o roteiro e LIMPA as
   * legendas materializadas (elas re-derivam do roteiro novo) — resolve legendas bugadas
   * depois de muitos cortes, sem palavra atravessando a borda de um corte.
   */
  async function retranscreverPulandoCortes() {
    if (!projectId) { alert("Salve o projeto antes (a transcrição lê o vídeo do projeto no servidor)."); return; }
    if (!confirm("Retranscrever só o áudio que sobrou na timeline (pulando os cortes)?\n\nIsso SUBSTITUI o roteiro atual e reconstrói as legendas. Os ajustes manuais de texto/tempo serão perdidos.")) return;
    setRetranscribing(true);
    try {
      const r = await fetch(comBase("/api/retranscribe-cut"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, cuts, durationSec: docExtra?.durationSec }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Falha ao retranscrever");
      const tr = ensureWordIds(data.transcript as TranscriptSegment[]);
      // roteiro novo (tempo de fonte) + legendas zeradas → re-derivam limpas do roteiro.
      setDoc((d) => ({ ...d, transcript: tr, captions: [] }));
    } catch (e) {
      alert("Erro ao retranscrever: " + (e as Error).message);
    } finally { setRetranscribing(false); }
  }
  // Ponte preview ↔ timeline fixa (barra inferior) — um objeto estável por sessão.
  const transport = useRef(new TransportBus()).current;

  // PREVIEW AUTOAJUSTADO: a largura da coluna é calculada pela ALTURA disponível ×
  // proporção do vídeo — o preview cabe INTEIRO, sem barra de rolagem interna.
  const bandRef = useRef<HTMLDivElement>(null);
  const [pvW, setPvW] = useState(420);
  useEffect(() => {
    const el = bandRef.current; if (!el || !docExtra?.width || !docExtra?.height) return;
    const calc = () => {
      const EXTRAS = 118; // controles sob o vídeo + paddings
      const aspect = docExtra.width / docExtra.height;
      const h = el.clientHeight - EXTRAS;
      setPvW(Math.round(Math.min(el.clientWidth * 0.55, Math.max(260, h * aspect + 26))));
    };
    const ro = new ResizeObserver(calc);
    ro.observe(el); calc();
    return () => ro.disconnect();
  }, [docExtra]);
  const effectiveColor = colorEnabled ? color : DEFAULT_COLOR;

  // refs sempre atuais (para autosave/reload-ao-focar lerem sem closure obsoleta)
  const latest = useRef({ doc, docExtra, projectId, lastSavedAt, saveState, videoFile, assembly });
  latest.current = { doc, docExtra, projectId, lastSavedAt, saveState, videoFile, assembly };

  // ───────── LUT (igual antes) ─────────
  async function loadLutFromText(text: string, name: string, intensity: number, colorForLut: ColorSettings) {
    const parsed = parseCube(text);
    const form = new FormData();
    form.append("lut", new Blob([text], { type: "text/plain" }), name);
    const res = await fetch(comBase("/api/lut"), { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Falha ao subir o .cube");
    setLut(parsed); setLutName(name); setLutText(text);
    setColor({ ...colorForLut, lut: { file: data.file, intensity } });
  }
  async function pickLut(file: File) {
    setLutError(null);
    try { await loadLutFromText(await file.text(), file.name, color.lut?.intensity ?? 1, color); }
    catch (e) { setLut(null); setLutName(null); setLutText(null); setLutError((e as Error).message); }
  }
  function clearLut() {
    setLut(null); setLutName(null); setLutText(null); setLutError(null);
    setColor({ ...color, lut: null });
  }
  async function applyColorPreset(preset: ColorPreset) {
    setLutError(null);
    if (preset.lutText) {
      try { await loadLutFromText(preset.lutText, `${preset.name}.cube`, preset.color.lut?.intensity ?? 1, preset.color); return; }
      catch (e) { setLutError((e as Error).message); }
    }
    setLut(null); setLutName(null); setLutText(null);
    setColor({ ...preset.color, lut: null });
  }
  const currentColorPreset = (name: string): ColorPreset => ({ name, color, lutText: lutText ?? undefined });

  // ───────── Projetos: carregar / criar / abrir / salvar ─────────
  function loadInto(pf: ProjectFile, file: File) {
    const d = pf.document;
    setDocExtra({ sourceVideo: d.sourceVideo, durationSec: d.durationSec, width: d.width, height: d.height });
    setAssembly(d.assembly);
    // Garante id em cada palavra e migra legendas antigas (sem id) para o novo esquema —
    // assim a sincronização de texto passa a valer também em projetos já legendados.
    const tr = ensureWordIds(d.transcript);
    // Liga cada palavra da legenda à sua da transcrição (por âncora + posição) e JÁ
    // sincroniza o texto — projetos alinhados antes desta correção passam a refletir as
    // edições do roteiro (o timing do alinhamento é preservado).
    const caps = syncCaptionsText(bootstrapCaptionWordIds(d.captions ?? [], tr), tr);
    reset({ transcript: tr, cuts: d.cuts, zooms: d.zooms, popups: d.popups, captionStyle: d.captionStyle, copy: d.copy, color: d.color, chroma: d.chroma ?? DEFAULT_CHROMA, flow: d.flow, music: d.music, captions: caps });
    setVideoFile(file);
    setProjectId(pf.meta.id); setProjectName(pf.meta.name);
    setSaveState("salvo"); setLastSavedAt(pf.meta.updatedAt);
    setShowProjects(false); setBusy(null);
  }

  async function criarProjeto(name: string, video: File) {
    setBusy("Transcrevendo o vídeo… (pode demorar)");
    try {
      const form = new FormData(); form.append("video", video);
      const r = await fetch(comBase("/api/transcribe"), { method: "POST", body: form });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Falha na transcrição");
      const url = URL.createObjectURL(video);
      const dims = await readVideoDims(url); URL.revokeObjectURL(url);
      const document: EditorDocument = {
        sourceVideo: data.videoFile, durationSec: data.durationSec ?? dims.dur,
        width: dims.w, height: dims.h, transcript: ensureWordIds(data.transcript),
        cuts: [], zooms: [], popups: [], captionStyle: DEFAULT_STYLE, color: DEFAULT_COLOR, chroma: DEFAULT_CHROMA, captions: [], copy: "",
      };
      const pr = await fetch(comBase("/api/projects"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, document }) });
      const pf = await pr.json();
      if (!pr.ok) throw new Error(pf.error ?? "Falha ao criar projeto");
      setLut(null); setLutName(null); setLutText(null);
      loadInto(pf, video);
    } catch (e) { setBusy(null); alert("Erro ao criar projeto: " + (e as Error).message); }
  }

  async function abrirProjeto(id: string) {
    if (!confirmarDescartar()) return;
    setBusy("Abrindo projeto…");
    try {
      // Cada passo nomeia a própria falha — "Failed to fetch" seco não diz se foi o
      // JSON do projeto ou o VÍDEO (grande: o Chrome materializa o blob em DISCO, e
      // com o disco cheio o fetch morre exatamente com esse erro genérico).
      const r = await fetch(comBase(`/api/projects/${id}`)).catch(() => {
        throw new Error("não consegui falar com o servidor (backend fora do ar? veja o terminal do npm run dev)");
      });
      const pf: ProjectFile = await r.json();
      if (!r.ok) throw new Error((pf as unknown as { error: string }).error ?? "Falha ao abrir");
      const vr = await fetch(comBase(pf.document.sourceVideo)).catch(() => {
        throw new Error("falha ao baixar o vídeo do projeto (conexão com o servidor caiu no meio?)");
      });
      if (!vr.ok) throw new Error(`vídeo do projeto respondeu HTTP ${vr.status} (asset faltando no servidor?)`);
      const blob = await vr.blob().catch(() => {
        throw new Error(
          "falha ao carregar o vídeo na memória — vídeo grande + pouco ESPAÇO EM DISCO no C: " +
          "(o navegador grava o vídeo em disco temporário). Libere alguns GB e tente de novo.",
        );
      });
      const file = new File([blob], "video.mp4", { type: blob.type || "video/mp4" });
      // LUT do projeto → parseia p/ o preview
      if (pf.document.color?.lut?.file) {
        try { const t = await (await fetch(comBase(pf.document.color.lut.file))).text(); setLut(parseCube(t)); setLutName("LUT do projeto"); setLutText(t); }
        catch { setLut(null); setLutName(null); setLutText(null); }
      } else { setLut(null); setLutName(null); setLutText(null); }
      loadInto(pf, file);
    } catch (e) { setBusy(null); alert("Erro ao abrir projeto: " + (e as Error).message); }
  }

  const buildDoc = (): EditorDocument => {
    const { doc: d, docExtra: e } = latest.current;
    return { ...(e as DocExtra), transcript: d.transcript, cuts: d.cuts, zooms: d.zooms, popups: d.popups, captionStyle: d.captionStyle, color: d.color, chroma: d.chroma, flow: d.flow, music: d.music, captions: d.captions, assembly: latest.current.assembly, copy: d.copy };
  };

  const salvar = useCallback(async () => {
    const id = latest.current.projectId;
    if (!id || !latest.current.docExtra) return;
    setSaveState("salvando");
    try {
      // baseUpdatedAt = a versao do servidor que ESTA sessao carregou/salvou por ultimo.
      // O servidor recusa (409) se ja tem uma versao mais nova — evita apagar o trabalho de outro.
      const r = await fetch(comBase(`/api/projects/${id}`), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ document: buildDoc(), baseUpdatedAt: latest.current.lastSavedAt }) });
      const pf = await r.json();
      if (r.status === 409) {
        // Outra sessao/computador salvou por cima. NAO sobrescreve; trava o autosave ("conflito").
        setSaveState("conflito");
        alert("⚠️ Este projeto foi alterado em OUTRO computador/sessão.\n\nSuas mudanças NÃO foram salvas, para não apagar o trabalho da outra pessoa. Recarregue a página (F5) para pegar a versão mais recente — as alterações locais desta sessão serão perdidas.");
        return;
      }
      if (!r.ok) throw new Error(pf.error ?? "Falha ao salvar");
      // updatedAt do SERVIDOR (nao Date.now() local): e o que o guard de concorrencia compara.
      setSaveState("salvo"); setLastSavedAt(pf.meta.updatedAt);
    } catch { setSaveState("erro"); }
  }, []);

  /**
   * MONTADOR concluído: o backend uniu tudo num MP4 novo e re-transcreveu. Troca o source +
   * transcrição, RESETA o que era cronometrado no vídeo antigo (cortes/zooms/popups/legendas/
   * FLOW) e salva. Mantém copy/cor/chroma/música (não dependem do tempo do source).
   */
  async function onAssemblyConcluir(result: { videoFile: string; durationSec: number; width: number; height: number; transcript: unknown }, asm: Assembly) {
    setShowAssembly(false);
    setBusy("Aplicando o novo vídeo…");
    try {
      const vr = await fetch(comBase(`/uploads/${result.videoFile}`));
      const blob = await vr.blob();
      const file = new File([blob], "video.mp4", { type: blob.type || "video/mp4" });
      const d = latest.current.doc;
      setDocExtra({ sourceVideo: result.videoFile, durationSec: result.durationSec, width: result.width, height: result.height });
      setAssembly(asm);
      reset({ transcript: ensureWordIds(result.transcript as TranscriptSegment[]), cuts: [], zooms: [], popups: [], captionStyle: d.captionStyle, copy: d.copy, color: d.color, chroma: d.chroma, flow: undefined, music: d.music, captions: [] });
      setVideoFile(file);
      setLut(null); setLutName(null); setLutText(null);
      setBusy(null);
      setTimeout(() => salvar(), 200); // persiste (move o MP4 + clipes pra assets/)
    } catch (e) { setBusy(null); alert("Erro ao aplicar o novo vídeo: " + (e as Error).message); }
  }

  // Marca "não salvo" quando o documento muda (após ter um projeto aberto).
  useEffect(() => {
    if (projectId) setSaveState((s) => (s === "salvo" ? "nao_salvo" : s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  // Autosave: 3s após a última mudança (debounce → não dispara durante o arrasto).
  useEffect(() => {
    if (!projectId || saveState !== "nao_salvo") return;
    const t = setTimeout(() => salvar(), 3000);
    return () => clearTimeout(t);
  }, [doc, projectId, saveState, salvar]);

  // Ctrl+S salva; Ctrl+Z/Shift+Z desfaz/refaz.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === "s") { e.preventDefault(); salvar(); return; }
      if (ctrl && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, salvar]);

  // Aviso ao fechar/recarregar com alterações não salvas.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (saveState !== "salvo") { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [saveState]);

  // RECARREGAR AO FOCAR: ao voltar pra aba/janela, se NAO ha pendencia local (saveState
  // "salvo"), busca o projeto no servidor; se outra pessoa salvou uma versao mais nova, puxa.
  // Assim a geracao/edicao feita em outro computador aparece aqui sem F5. Com pendencia local
  // NAO mexe (o guard de concorrencia do salvar avisa no proximo save).
  useEffect(() => {
    const puxarSeNovo = async () => {
      const L = latest.current;
      if (!L.projectId || L.saveState !== "salvo") return;
      try {
        const r = await fetch(comBase(`/api/projects/${L.projectId}`));
        if (!r.ok) return;
        const pf: ProjectFile = await r.json();
        if (pf.meta.updatedAt <= (L.lastSavedAt ?? 0)) return; // ja estou na versao atual
        if (pf.document.sourceVideo === L.docExtra?.sourceVideo && L.videoFile) {
          loadInto(pf, L.videoFile); // mesmo video → reusa o blob local (sem re-baixar)
        } else {
          abrirProjeto(pf.meta.id); // video mudou → recarrega completo
        }
      } catch { /* silencioso: focar nao pode quebrar a edicao */ }
    };
    const onVis = () => { if (document.visibilityState === "visible") puxarSeNovo(); };
    window.addEventListener("focus", puxarSeNovo);
    document.addEventListener("visibilitychange", onVis);
    return () => { window.removeEventListener("focus", puxarSeNovo); document.removeEventListener("visibilitychange", onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function confirmarDescartar(): boolean {
    if (saveState === "salvo" || !projectId) return true;
    return confirm("Há alterações não salvas. Deseja descartá-las?");
  }

  // ───────── edições ─────────
  const addCuts = (novos: Cut[]) => setCuts((prev) => [...prev, ...novos].sort((a, b) => a.start - b.start));
  // Substitui SÓ os cortes vindos da copy (prefixo cut-copy-), preservando os demais.
  const applyCopyCuts = (copyCuts: Cut[]) =>
    setCuts((prev) => [...prev.filter((c) => !c.id.startsWith("cut-copy-")), ...copyCuts].sort((a, b) => a.start - b.start));
  const addPopup = (word: Word) => {
    const p: SupportPopup = {
      id: `popup-${Date.now()}`, type: "support", at: +word.start.toFixed(3), duration: 2.5,
      source: "manual", transition: { ...DEFAULT_POPUP_TRANSITION }, preset: "keyword",
      content: { text: word.text }, layout: { x: 50, y: 30, scale: 1 },
    };
    setPopups((prev) => [...prev, p].sort((a, b) => a.at - b.at));
  };

  /**
   * MOTION manual (modo "motion" da transcrição, igual ao popup): o trecho selecionado
   * vira UM momento do FLOW com uma frase (status "detected" — segue o fluxo normal de
   * design/animação). Teto de 5 momentos no vídeo (detecção + manuais).
   */
  const addFlowMoment = (wordStart: number, wordEnd: number) => {
    const words = transcript.flatMap((s) => s.words);
    const text = words.slice(wordStart, wordEnd + 1).map((w) => w.text).join(" ").trim();
    if (!text) return;
    const cur = flow ?? emptyFlow();
    if (cur.moments.length >= 5) { alert("Máximo de 5 momentos de motion — remova um no painel FLOW antes de adicionar outro."); return; }
    const id = Date.now().toString(36);
    const m: FlowMoment = {
      id: `moment-man-${id}`, wordStart, wordEnd, reason: "Manual (escolhido na transcrição)",
      phrases: [{ id: `phrase-man-${id}`, wordStart, wordEnd, text, status: "detected" }],
    };
    setFlow({ ...cur, moments: [...cur.moments, m].sort((a, b) => a.wordStart - b.wordStart) });
  };

  const saveLabel: Record<SaveState, string> = {
    salvo: lastSavedAt ? `salvo às ${new Date(lastSavedAt).toLocaleTimeString("pt-BR")}` : "salvo",
    salvando: "salvando…", nao_salvo: "alterações não salvas", erro: "erro ao salvar",
    conflito: "⚠️ mudou em outro PC — recarregue (F5)",
  };

  return (
    <main style={{ fontFamily: "Inter, system-ui, sans-serif", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)", color: "var(--text)" }}>
      {/* CSS do shell: some com os títulos internos das etapas (a janela já tem título)
          e neutraliza as margens das <section> dos módulos dentro das janelas. */}
      <style>{`
        body { margin: 0; background: var(--bg); }
        .dock-body > section { margin-top: 4px !important; }
        .dock-body > section > h2, .preview-col > section > h2 { display: none; }
        .dock-body { color: var(--text); }
        .preview-col > section { margin-top: 0 !important; }
      `}</style>

      {showProjects && <ProjectsModal onOpen={abrirProjeto} onCreate={criarProjeto} busy={busy} />}

      {showAssembly && projectId && docExtra && (
        <AssemblyEditor projectId={projectId} width={docExtra.width} height={docExtra.height}
          sourceVideoUrl={docExtra.sourceVideo} sourceDurationSec={docExtra.durationSec}
          initial={assembly} onConclude={onAssemblyConcluir} onClose={() => setShowAssembly(false)} />
      )}

      {/* BARRA SUPERIOR — projeto, salvar, undo/redo. Compacta, sem poluição. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
        background: "var(--panel)", borderBottom: "1px solid var(--border)", position: "sticky", top: 0, zIndex: 50,
      }}>
        <img src="/logo.svg" alt="Studio" style={{ height: 22, width: "auto", display: "block" }} />
        {/* Cliente vindo do OS (?cliente=). Fora do OS nao aparece — o studio segue solto. */}
        {getClienteSlug() && (
          <span
            title="Cliente selecionado no Blue Ocean OS"
            style={{
              fontSize: 11, fontWeight: 600, letterSpacing: 0.3, textTransform: "uppercase",
              color: "var(--accent)", border: "1px solid var(--border)", borderRadius: 999,
              padding: "3px 10px", whiteSpace: "nowrap",
            }}
          >
            {getClienteSlug()}
          </span>
        )}
        {projectId && (
          <>
            <span style={{ fontSize: 13, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 260 }}>{projectName}</span>
            <span style={{ fontSize: 12, color: saveState === "erro" ? "var(--red)" : saveState === "salvo" ? "var(--green)" : "var(--accent)" }}>
              {saveLabel[saveState]}{saveState === "erro" && <button onClick={salvar} style={{ marginLeft: 8 }}>tentar de novo</button>}
            </span>
          </>
        )}
        <span style={{ flex: 1 }} />
        <button onClick={undo} disabled={!canUndo} title="Desfazer (Ctrl+Z)" style={{ ...topBtn, opacity: canUndo ? 1 : 0.35 }}>↶</button>
        <button onClick={redo} disabled={!canRedo} title="Refazer (Ctrl+Shift+Z)" style={{ ...topBtn, opacity: canRedo ? 1 : 0.35 }}>↷</button>
        {projectId && (
          <>
            <button onClick={salvar} style={topBtn}>Salvar</button>
            {videoFile && <button onClick={() => setShowAssembly(true)} style={topBtn} title="Unir vídeos e b-rolls (Montador de origem)">Montador</button>}
            <button onClick={() => { if (confirmarDescartar()) setShowProjects(true); }} style={topBtn}>Projetos</button>
          </>
        )}
      </div>

      {!projectId && !showProjects && (
        <p style={{ color: "var(--muted)", padding: 24 }}>Nenhum projeto aberto. <button onClick={() => setShowProjects(true)}>Abrir projetos</button></p>
      )}

      {videoFile && (
        <div ref={bandRef} style={{ display: "flex", gap: 12, padding: 12, alignItems: "stretch", flex: 1, minHeight: 0 }}>
          {/* PREVIEW — janela FIXA: dimensionada pra mostrar tudo, sem rolagem */}
          <div className="preview-col fo-card" style={{
            flex: "0 0 auto", width: pvW, overflow: "hidden",
            background: "var(--panel)", color: "var(--text)", borderRadius: 12, border: "1px solid var(--border)",
            padding: 12,
          }}>
            <KaraokePreview videoFile={videoFile} transcript={transcript} style={captionStyle} onStyleChange={setCaptionStyle}
              cuts={cuts} onCutsChange={setCuts} captions={captions} onCaptionsChange={setCaptions}
              zooms={zooms} popups={popups} onAddCuts={addCuts} color={effectiveColor} lut={lut} music={music}
              chroma={chroma} eyedropper={eyedropper} showMask={showMask} hideStyleControls transport={transport}
              onPickKeyColor={(rgb) => { setChroma({ ...chroma, keyColor: rgb }); setEyedropper(false); }} />
          </div>

          {/* ABAS (dock horizontal) — clique abre; arraste a aba pra realocar */}
          <div style={{ flex: 1, minWidth: 0, display: "flex" }}>
            <Dock panels={[
              { id: "roteiro", title: "1 · Roteiro & Correção", node: (
                <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
                  <div style={{ flex: 1, minHeight: 0 }}>
                    <TranscriptEditor transcript={transcript} onChange={setTranscript} copy={copy} onCopyChange={setCopy} onAddCuts={addCuts} onApplyCopyCuts={applyCopyCuts} onAddPopup={addPopup} onAddFlowMoment={addFlowMoment} />
                  </div>
                  {/* Ferramentas de TEMPO das legendas (alinhar com a fala, ±50ms, avisos) */}
                  <CaptionToolbar transcript={transcript} cuts={cuts} captions={captions} onCaptionsChange={setCaptions}
                    maxWords={captionStyle.maxWords} onAnchorToSpeech={realinharLegendas} anchoring={anchoring}
                    onRetranscribeCut={retranscreverPulandoCortes} retranscribing={retranscribing} />
                  {/* Estilo das legendas — recolhível, pra transcrição reinar na altura */}
                  <details style={{ flexShrink: 0, borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 8 }}>
                    <summary style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", cursor: "pointer", userSelect: "none" }}>
                      Estilo das legendas
                    </summary>
                    <div style={{ maxHeight: "42vh", overflowY: "auto", paddingTop: 8 }}>
                      <CaptionControls style={captionStyle} onChange={onCaptionStyleChange} />
                    </div>
                  </details>
                </div> ) },
              { id: "cortes", title: "2 · Cortes & Timeline", node: (
                <Editor transcript={transcript} onTranscriptChange={setTranscript} durationSec={docExtra?.durationSec ?? 0} copy={copy}
                  cuts={cuts} onCutsChange={setCuts} zooms={zooms} onZoomsChange={setZooms} popups={popups} onPopupsChange={setPopups}
                  videoFile={videoFile} transport={transport} /> ) },
              { id: "cor", title: "3 · Cor", startCollapsed: true, node: (
                <ColorPanel color={color} onChange={setColor} enabled={colorEnabled} onToggleEnabled={setColorEnabled}
                  onPickLut={pickLut} onClearLut={clearLut} lutName={lutName} lutError={lutError}
                  onApplyPreset={applyColorPreset} makePreset={currentColorPreset} /> ) },
              { id: "chroma", title: "4 · Chroma", startCollapsed: true, node: (
                <ChromaPanel chroma={chroma} onChange={setChroma}
                  eyedropper={eyedropper} onToggleEyedropper={setEyedropper}
                  showMask={showMask} onToggleShowMask={setShowMask} /> ) },
              { id: "musica", title: "5 · Música", startCollapsed: true, node: (
                <MusicPanel music={music} onChange={setMusic} /> ) },
              { id: "flow", title: "6 · FLOW — Motion Design", startCollapsed: true, node: (
                <FlowPanel transcript={transcript} cuts={cuts} durationSec={docExtra?.durationSec ?? 0} copy={copy}
                  projectId={projectId} flow={flow} onFlowChange={setFlow} onPlacePopups={placeFlowPopups}
                  flowPopups={popups.filter((p) => p.type === "fullscreen" && (p as { flowPhraseId?: string }).flowPhraseId) as FullscreenPopup[]}
                  onPatchFlowPopup={(id, patch) => setPopups((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))}
                  videoFile={videoFile} /> ) },
              { id: "export", title: "7 · Exportar", startCollapsed: true, node: (
                <ExportPanel videoFile={videoFile} transcript={transcript} style={captionStyle}
                  durationSec={docExtra?.durationSec ?? 0} cuts={cuts} zooms={zooms} popups={popups} color={effectiveColor} chroma={chroma} music={music} projectId={projectId} captions={captions} /> ) },
            ]} />
          </div>
        </div>
      )}

      {/* TIMELINE FIXA — barra inferior de largura total, sempre visível */}
      {videoFile && (
        <div style={{ flex: "0 0 auto", background: "var(--panel)", borderTop: "1px solid var(--border)", padding: "8px 16px 12px" }}>
          <TimelineDock bus={transport} videoFile={videoFile} cuts={cuts} onCutsChange={setCuts}
            words={transcript.flatMap((s) => s.words)}
            captions={captions} onCaptionsChange={setCaptions} transcript={transcript} maxWords={captionStyle.maxWords}
            motions={popups.filter((p): p is FullscreenPopup => p.type === "fullscreen").map((p) => ({ id: p.id, at: p.at, label: p.placeholder?.label }))}
            onMotionMove={(id, at) => setPopups((prev) => prev.map((p) => (p.id === id ? { ...p, at } : p)))} />
        </div>
      )}
    </main>
  );
}

/** Timeline dock: assina a ponte de transporte. P1 (fluidez): só re-renderiza quando
 *  duração/play MUDAM; o TEMPO flui por um adapter imperativo (playhead via DOM direto). */
function TimelineDock({ bus, videoFile, cuts, onCutsChange, words, captions, onCaptionsChange, transcript, maxWords, motions, onMotionMove }: {
  bus: TransportBus; videoFile: File; cuts: Cut[]; onCutsChange: (c: Cut[]) => void; words: Word[];
  captions: Caption[]; onCaptionsChange: (c: Caption[]) => void; transcript: TranscriptSegment[]; maxWords?: number;
  motions: { id: string; at: number; label?: string }[]; onMotionMove: (id: string, at: number) => void;
}) {
  const [meta, setMeta] = useState({ duration: bus.state.duration, playing: bus.state.playing });
  useEffect(() => bus.subscribe((s: TransportState) => {
    setMeta((m) => (m.duration === s.duration && m.playing === s.playing) ? m : { duration: s.duration, playing: s.playing });
  }), [bus]);
  // adapter: TransportBus → fonte de tempo imperativa do CutTimeline
  const clock = useMemo(() => ({
    get time() { return bus.state.time; },
    subscribe: (f: (t: number) => void) => bus.subscribe((s: TransportState) => f(s.time)),
  }), [bus]);
  if (meta.duration <= 0) return null;
  return (
    <CutTimeline videoFile={videoFile} duration={meta.duration} cuts={cuts} onCutsChange={onCutsChange}
      words={words} clock={clock} onSeek={(t) => bus.seek(t)} onPlayKept={() => bus.toggle()} playing={meta.playing}
      captions={captions} onCaptionsChange={onCaptionsChange} transcript={transcript} maxWords={maxWords}
      motions={motions} onMotionMove={onMotionMove} />
  );
}

/** Botão da barra superior (discreto, tema escuro). Altura mínima = alvo de clique confortável. */
const topBtn: React.CSSProperties = {
  background: "var(--panel3)", color: "var(--text)", border: "1px solid var(--border)",
  borderRadius: 8, padding: "4px 12px", fontSize: 13, cursor: "pointer", minHeight: 32,
};
