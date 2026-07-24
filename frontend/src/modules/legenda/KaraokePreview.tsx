import { comBase } from '../../os-session';
import { useEffect, useMemo, useRef, useState } from "react";
import type { TranscriptSegment, Cut, Zoom, Popup, Music, Caption } from "../../../../shared/timeline";
import { activeLine, buildCaptionLines, resolveCaptionLines, stripCutsFromTranscript } from "../../../../shared/captions";
import { CaptionControls } from "./CaptionControls";
import { wordFx, hexToRgba, shadowCss, type CaptionStyle } from "../../../../shared/captionStyle";
import { PopupsOverlay } from "./PopupsOverlay";
import { PersonMatteCanvas } from "./PersonMatteCanvas";
import { ColorCanvas } from "../color/ColorCanvas";
import { CutTimeline } from "../editor/CutTimeline";
import { buildCutPlan } from "../../../../shared/cutplan";
import { isColorNeutral, type ColorSettings } from "../../../../shared/color";
import { isChromaActive, type ChromaSettings, type RGB255 } from "../../../../shared/chroma";
import type { ParsedLut } from "../../../../shared/lut";
import type { TransportBus } from "../../workspace/transport";
import { FrameClock, useFrameTime } from "../../workspace/frameClock";


/** Escala de zoom ativa (degrau); a transição CSS 0.4s anima suave no compositor. */
function zoomScaleAt(zooms: Zoom[], t: number): number {
  const z = zooms.find((z) => z.scale !== 1 && t >= z.at && t < z.at + z.duration);
  return z?.scale ?? 1;
}

/** Cap Full HD (mesmo do export): lado maior ≤ 1920, menor ≤ 1080, pares. */
function capFullHD(w: number, h: number) {
  const s = Math.min(1920 / Math.max(w, h), 1080 / Math.min(w, h), 1);
  const even = (n: number) => Math.max(2, Math.round((n * s) / 2) * 2);
  return { w: even(w), h: even(h) };
}

/**
 * Etapa 4: Legenda karaokê com editor de estilo em tempo real.
 * Toca o vídeo local e renderiza a legenda conforme o estilo escolhido.
 * Render final é interno (Remotion) depois — mesmo CaptionStyle.
 */
export function KaraokePreview({
  videoFile,
  videoUrl,
  durationSec,
  projectId,
  sourceAsset,
  transcript,
  style,
  onStyleChange,
  cuts,
  onCutsChange,
  captions,
  onCaptionsChange,
  zooms,
  popups,
  onAddCuts,
  color,
  lut,
  chroma,
  music,
  eyedropper = false,
  showMask = false,
  onPickKeyColor,
  hideStyleControls = false,
  transport,
}: {
  videoFile: File | null;
  /** URL do vídeo (servidor/blob) — o preview STREAMA daqui quando não há blob local. */
  videoUrl: string;
  /** duração do projeto (JSON) — semeia o preview/timeline SEM esperar o metadata do <video>. */
  durationSec?: number;
  /** projeto atual: com projectId + sourceAsset o proxy é gerado SERVER-SIDE (sem upload). */
  projectId?: string | null;
  sourceAsset?: string;
  transcript: TranscriptSegment[];
  style: CaptionStyle;
  onStyleChange: (s: CaptionStyle) => void;
  cuts: Cut[];
  onCutsChange: (c: Cut[]) => void;
  /** Legendas com tempo manual (vazio = derivadas da transcrição). */
  captions?: Caption[];
  onCaptionsChange?: (c: Caption[]) => void;
  zooms: Zoom[];
  popups: Popup[];
  onAddCuts: (c: Cut[]) => void;
  color: ColorSettings;
  lut: ParsedLut | null;
  chroma: ChromaSettings;
  music?: Music;
  eyedropper?: boolean;                 // modo conta-gotas (clica p/ pegar a cor-chave)
  showMask?: boolean;                   // ver a máscara (P&B)
  onPickKeyColor?: (rgb: RGB255) => void;
  /** true = não renderiza o editor de estilo aqui (ele mora no painel Roteiro & Correção). */
  hideStyleControls?: boolean;
  /** Ponte com a TIMELINE FIXA do app: quando presente, a timeline não é renderizada aqui. */
  transport?: TransportBus;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const colorCanvasRef = useRef<HTMLCanvasElement | null>(null); // canvas corrigido (fonte p/ o matte)
  // P1 (fluidez): o tempo NÃO é estado do React — vive no FrameClock (barramento imperativo).
  // Só as folhas que animam (legenda/popups/playhead) assinam. Este componente re-renderiza
  // apenas em eventos RAROS: degrau de zoom, janela do matte, play/pause, duração.
  const clock = useRef(new FrameClock()).current;
  const [zoomScale, setZoomScale] = useState(1);   // degrau atual (muda a cada poucos segundos)
  const [matteOn, setMatteOn] = useState(false);   // janela do "atrás da pessoa" (RVM)
  // Semeia a duração com a do PROJETO (já conhecida): PlayerBar e timeline aparecem na
  // hora, sem esperar o `loadedmetadata` do <video> (que, sem faststart, só chega depois
  // de baixar o arquivo inteiro). O metadata real, quando chega, apenas confirma o valor.
  const [duration, setDuration] = useState(durationSec ?? 0);
  useEffect(() => { if (durationSec && durationSec > 0) setDuration((d) => (d > 0 ? d : durationSec)); }, [durationSec]);
  // publica a duração semeada no transporte no mount → a timeline fixa monta imediatamente.
  useEffect(() => {
    if (transport && durationSec && durationSec > 0) transport.publish({ time: 0, duration: durationSec, playing: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, durationSec]);
  const [playing, setPlaying] = useState(false);
  // P2 (qualidade do preview): fator de resolução dos canvas de PROCESSAMENTO (WebGL/matte).
  // Total = cap FullHD (igual export); ½ = 4× menos pixels por frame; ¼ = 16× menos.
  const [resScale, setResScale] = useState<number>(() => Number(localStorage.getItem("fo-preview-res") ?? 1));
  const allWords = useMemo(() => transcript.flatMap((s) => s.words), [transcript]);
  const musicRef = useRef<HTMLAudioElement>(null);
  function togglePlayKept() {
    const v = videoRef.current; if (!v) return;
    v.paused ? v.play().catch(() => {}) : v.pause();
  }
  // Música de fundo: toca/pausa junto com o vídeo; volume ao vivo; loop do TRECHO.
  useEffect(() => {
    const a = musicRef.current; if (!a) return;
    a.volume = music?.volume ?? 0.15;
    const s = music?.start ?? 0, e = music?.end;
    const onTime = () => { if (e != null && a.currentTime >= e - 0.03) a.currentTime = s; };
    const onEnded = () => { a.currentTime = s; a.play().catch(() => {}); };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("ended", onEnded);
    return () => { a.removeEventListener("timeupdate", onTime); a.removeEventListener("ended", onEnded); };
  }, [music?.file, music?.start, music?.end, music?.volume]);
  useEffect(() => {
    const a = musicRef.current; if (!a) return;
    if (playing && music?.file) {
      const s = music?.start ?? 0;
      if (a.currentTime < s || (music?.end != null && a.currentTime >= music.end)) a.currentTime = s;
      a.play().catch(() => {});
    } else a.pause();
  }, [playing, music?.file, music?.start, music?.end]);
  const [markStart, setMarkStart] = useState<number | null>(null);
  const [url, setUrl] = useState<string>();
  // P3+P4 (proxy de preview, estilo CapCut): o preview toca uma versão 540p com keyframes
  // densos (cortes pulam sem engasgo; decode leve). O EXPORT usa sempre o original.
  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  const [proxyFailed, setProxyFailed] = useState(false);
  const [useProxy, setUseProxy] = useState(() => (localStorage.getItem("fo-preview-proxy") ?? "1") === "1");
  const [videoError, setVideoError] = useState<string | null>(null);
  const [audioDead, setAudioDead] = useState(false);   // áudio não decodifica (AC-3/PCM…)
  const [fixingAudio, setFixingAudio] = useState(false);
  const [fixAudioUrl, setFixAudioUrl] = useState<string | null>(null); // faixa AAC paralela
  const fixAudioRef = useRef<HTMLAudioElement>(null);

  // Detecta áudio NÃO decodificável: o vídeo toca mas nenhum byte de áudio é
  // decodificado (Chrome expõe webkitAudioDecodedByteCount). Aviso + correção.
  useEffect(() => {
    if (!playing || audioDead || fixAudioUrl) return;
    const t = setTimeout(() => {
      const v = videoRef.current as (HTMLVideoElement & { webkitAudioDecodedByteCount?: number }) | null;
      if (v && !v.paused && v.currentTime > 1 && v.webkitAudioDecodedByteCount === 0 && !v.muted) setAudioDead(true);
    }, 2000);
    return () => clearTimeout(t);
  }, [playing, audioDead, fixAudioUrl]);

  /**
   * Extrai o áudio pra AAC no backend e toca em PARALELO, sincronizado ao vídeo
   * ORIGINAL. NUNCA troca o arquivo de vídeo (remux desloca timestamps → cortes e
   * legendas dessincronizam — foi um bug real).
   */
  async function corrigirAudio() {
    if (!videoFile) return; // sem blob ainda (streaming) — o proxy já toca AAC; espera o background
    setFixingAudio(true);
    try {
      const fd = new FormData();
      fd.append("video", videoFile);
      const r = await fetch(comBase("/api/fix-audio"), { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Falha na conversão");
      setFixAudioUrl(d.url);
      setAudioDead(false);
    } catch (e) { setVideoError((e as Error).message); }
    finally { setFixingAudio(false); }
  }

  // Sincroniza a faixa AAC paralela com o vídeo (play/pause/seek/drift).
  useEffect(() => {
    const a = fixAudioRef.current, v = videoRef.current;
    if (!a || !v || !fixAudioUrl) return;
    const sync = () => { if (Math.abs(a.currentTime - v.currentTime) > 0.15) a.currentTime = v.currentTime; };
    if (playing) { sync(); a.play().catch(() => {}); } else a.pause();
    const iv = window.setInterval(() => { if (!v.paused) sync(); }, 800);
    const onSeek = () => { a.currentTime = v.currentTime; };
    v.addEventListener("seeked", onSeek);
    return () => { clearInterval(iv); v.removeEventListener("seeked", onSeek); };
  }, [playing, fixAudioUrl]);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null); // resolução real do vídeo
  const [containerW, setContainerW] = useState(0); // largura exibida do preview

  // Acompanha a largura exibida do preview (para escalar o "palco" export→tela).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  function seek(t: number) {
    if (videoRef.current) videoRef.current.currentTime = Math.max(0, Math.min(duration, t));
  }
  // Ponte com a timeline fixa: expõe seek/toggle (o ESTADO é publicado pelo loop de frame).
  useEffect(() => {
    if (!transport) return;
    transport.seek = seek;
    transport.toggle = togglePlayKept;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, duration]);
  function addManualCut(shiftCaption = false) {
    if (markStart === null) return;
    const start = Math.min(markStart, clock.time);
    const end = Math.max(markStart, clock.time);
    if (end - start < 0.05) { setMarkStart(null); return; }
    onAddCuts([{ id: `cut-vid-${Date.now()}`, start: +start.toFixed(3), end: +end.toFixed(3), reason: "manual", enabled: true, shiftCaption }]);
    setMarkStart(null);
  }

  // Mesmo ponto de entrada do render (resolveCaptionLines) — é o que garante que o
  // ajuste manual da timeline apareça igual aqui e no vídeo final.
  const lines = useMemo(
    () => resolveCaptionLines(transcript, cuts, captions, style.maxWords),
    [transcript, cuts, captions, style.maxWords],
  );

  // Fonte do <video>: com blob local, cria a object URL; SEM blob (abrindo projeto), STREAMA a
  // URL do servidor direto — abrir não espera baixar o arquivo inteiro.
  useEffect(() => {
    if (!videoFile) { setUrl(videoUrl); return; }
    const u = URL.createObjectURL(videoFile);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [videoFile, videoUrl]);

  // Pede o PROXY ao backend (cache por nome+tamanho+mtime → gera 1× por vídeo).
  // Enquanto não chega, o preview toca o original — a troca preserva posição/estado.
  useEffect(() => {
    setProxyUrl(null);
    setProxyFailed(false);
    if (!useProxy) return;
    let dead = false;
    (async () => {
      try {
        let r: Response;
        if (projectId && sourceAsset) {
          // PROXY SERVER-SIDE pelo asset — não re-envia o arquivo (era o que travava a abertura).
          r = await fetch(comBase("/api/proxy-asset"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, asset: sourceAsset }) });
        } else if (videoFile) {
          const fd = new FormData();
          fd.append("video", videoFile);
          fd.append("key", `${videoFile.name}-${videoFile.size}-${videoFile.lastModified}`);
          r = await fetch(comBase("/api/proxy"), { method: "POST", body: fd });
        } else { return; }
        const d = await r.json();
        if (dead) return;
        if (r.ok && d.url) {
          // d.url vem como /uploads/... — base-aware pro subpath do OS (senao o <video>
          // troca pra uma URL na raiz do dominio -> 404 e o video/timeline somem).
          setProxyUrl(comBase(d.url));
          // Original que o navegador NÃO toca (HEVC/MKV): o palco WYSIWYG nasce das
          // dimensões do ORIGINAL medidas pelo servidor (o proxy é menor — não serve).
          if (d.srcW && d.srcH) setNatural((n) => n ?? { w: d.srcW, h: d.srcH });
        } else setProxyFailed(true);
      } catch { if (!dead) setProxyFailed(true); }
    })();
    return () => { dead = true; };
  }, [videoFile, useProxy, projectId, sourceAsset]);

  // fonte efetiva do <video> + troca SEM perder a posição (proxy chega no meio da sessão)
  const src = useProxy && proxyUrl ? proxyUrl : url;
  const lastSrcRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const v = videoRef.current; if (!v || !src) return;
    if (lastSrcRef.current && lastSrcRef.current !== src) {
      const t = clock.time, was = !v.paused;
      const onLoaded = () => { v.currentTime = t; if (was) v.play().catch(() => {}); };
      v.addEventListener("loadedmetadata", onLoaded, { once: true });
    }
    lastSrcRef.current = src;
  }, [src, clock]);

  // LOOP DE FRAME (P1): pula cortes, publica o tempo no clock/transport (imperativo) e só
  // toca estados DISCRETOS (degrau de zoom, janela do matte) quando eles MUDAM — nunca
  // setState por frame. É isso que deixa o preview liso: o React sai do caminho quente.
  useEffect(() => {
    let raf = 0;
    let last = { t: -1, d: -1, p: false };
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        // Pula trechos cortados (simula o corte no preview).
        const cut = cuts.find((c) => c.enabled && v.currentTime >= c.start && v.currentTime < c.end - 0.05);
        if (cut) v.currentTime = cut.end;
        const t = v.currentTime, d = v.duration || 0, p = !v.paused;
        if (t !== last.t) clock.publish(t);
        if (transport && (t !== last.t || d !== last.d || p !== last.p)) transport.publish({ time: t, duration: d, playing: p });
        last = { t, d, p };
        // estados discretos (mudam a cada poucos segundos, não por frame)
        const zs = zoomScaleAt(zooms, t);
        setZoomScale((s) => (s === zs ? s : zs));
        const mOn = !isChromaActive(chroma) && popups.some(
          (pp) => pp.type === "support" && pp.behindSubject && t >= pp.at && t <= pp.at + pp.duration,
        );
        setMatteOn((m) => (m === mOn ? m : mOn));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cuts, zooms, popups, chroma, transport, clock]);
  // plano de cortes: os vídeos de motion (popup fullscreen) sincronizam em tempo de SAÍDA
  const cutPlan = useMemo(() => buildCutPlan(duration || 0, cuts), [duration, cuts]);
  const chromaActive = isChromaActive(chroma);
  const processActive = !isColorNeutral(color) || chromaActive; // WebGL liga se cor OU chroma
  // Com chroma + popup "atrás da pessoa": monta em CAMADAS (fundo → popup → pessoa
  // transparente → frente), igual ao export. Senão, plano composto normal.
  const hasBehind = popups.some((p) => p.behindSubject);
  const chromaLayered = chromaActive && hasBehind;
  const behindPopups = chromaLayered ? popups.filter((p) => p.behindSubject) : [];
  const frontAll = chromaLayered ? popups.filter((p) => !p.behindSubject) : popups;
  // FULLSCREEN fica NA FRENTE das legendas (cobre tudo); os demais ficam atrás delas.
  const fullscreenTop = frontAll.filter((p) => p.type === "fullscreen");
  const frontPopups = frontAll.filter((p) => p.type !== "fullscreen");
  // RVM (matting nativo) só sem chroma; a JANELA é computada no loop de frame → matteOn.
  const matteActive = !chromaActive && matteOn;
  // P2: resolução de PROCESSAMENTO = cap FullHD (igual export) × fator escolhido pelo usuário.
  const capScale = natural ? Math.min(1920 / Math.max(natural.w, natural.h), 1080 / Math.min(natural.w, natural.h), 1) : 1;
  const procScale = capScale * resScale;

  // Elemento de fundo do chroma (imagem ou vídeo), carregado da URL do asset.
  const [bgImg, setBgImg] = useState<HTMLImageElement | null>(null);
  const [bgVid, setBgVid] = useState<HTMLVideoElement | null>(null);
  useEffect(() => {
    const bg = chroma.background;
    setBgImg(null); setBgVid(null);
    if (!bg) return;
    if (bg.type === "image") {
      const im = new Image(); im.crossOrigin = "anonymous"; im.src = bg.file; im.onload = () => setBgImg(im);
    } else if (bg.type === "video") {
      const vd = document.createElement("video");
      vd.crossOrigin = "anonymous"; vd.src = bg.file; vd.loop = bg.loop; vd.muted = true; vd.playsInline = true;
      vd.oncanplay = () => { vd.play().catch(() => {}); setBgVid(vd); };
    }
  }, [chroma.background?.type, (chroma.background as { file?: string })?.file]);

  // Conta-gotas: lê o pixel do vídeo BRUTO (sem keying) no ponto clicado.
  function pickAt(e: React.PointerEvent) {
    const v = videoRef.current; if (!v || !onPickKeyColor) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext("2d")!; ctx.drawImage(v, 0, 0);
    const d = ctx.getImageData(Math.floor(nx * c.width), Math.floor(ny * c.height), 1, 1).data;
    onPickKeyColor({ r: d[0], g: d[1], b: d[2] });
  }

  // "Palco" na resolução de EXPORT: legendas/popups são desenhados em coordenadas
  // de export (px reais) e o palco inteiro é escalado para caber na tela. Assim o
  // preview vira espelho fiel do MP4 (fontSize/posições/tamanhos idênticos).
  const stage = natural ? capFullHD(natural.w, natural.h) : null;
  const k = stage && containerW ? containerW / stage.w : 1;
  const stageStyle: React.CSSProperties = stage
    ? { position: "absolute", top: 0, left: 0, width: stage.w, height: stage.h, transform: `scale(${k})`, transformOrigin: "top left", pointerEvents: "none" }
    : { display: "none" };
  // A ESCALA do palco é CSS-first (regra .fo-stage abaixo, com container query): ela
  // acompanha a largura real do container no MESMO frame do layout. O scale(k) acima
  // (medido por ResizeObserver) fica só de reserva pra navegador sem container query —
  // era ele, sozinho, que deixava a legenda na altura errada quando a notificação do
  // observer era descartada (loop de RO: banda → pvW → coluna → preview).
  const stageProps = { className: "fo-stage", style: stageStyle };

  return (
    <section style={{ marginTop: 24 }}>
      <h2>4. Legenda (karaokê)</h2>

      {!hideStyleControls && <CaptionControls style={style} onChange={onStyleChange} />}

      {/* Codec que o navegador não toca (HEVC/MKV): com proxy LIGADO isso é um estado
          transitório — o servidor está convertendo pra H.264 (toca em qualquer navegador). */}
      {videoError && useProxy && !proxyUrl && !proxyFailed && (
        <p style={{ color: "var(--accent-text)", fontSize: 13, maxWidth: 640, background: "var(--accent-soft)", border: "1px solid #f2d9b8", borderRadius: 8, padding: "8px 12px" }}>
          Este vídeo usa um codec que o navegador não reproduz (ex.: H.265/HEVC ou .mkv).
          <strong> Convertendo uma versão compatível para o preview…</strong> (o export usa o original, sem perda)
        </p>
      )}
      {videoError && (!useProxy || proxyFailed) && (
        <p style={{ color: "var(--red)", fontSize: 13, maxWidth: 640 }}>
          {videoError}
          {!useProxy && <> — <strong>ligue o “proxy”</strong> (acima do vídeo) para converter automaticamente o preview.</>}
          {useProxy && proxyFailed && <> — a conversão do proxy falhou; veja o log do servidor.</>}
        </p>
      )}
      {audioDead && (
        <p style={{ color: "var(--accent-text)", fontSize: 13, maxWidth: 640, background: "var(--accent-soft)", border: "1px solid #f0c", borderColor: "#f2d9b8", borderRadius: 8, padding: "8px 12px" }}>
          O navegador não consegue decodificar o <strong>áudio</strong> deste vídeo (codec tipo AC-3/PCM dentro do MP4) — por isso o preview toca mudo.
          {" "}
          <button onClick={corrigirAudio} disabled={fixingAudio} style={{ marginLeft: 8, background: "var(--accent)", color: "#1a1a1a", fontSize: 12 }}>
            {fixingAudio ? "extraindo áudio…" : "Corrigir áudio do preview"}
          </button>
          <span style={{ fontSize: 11, color: "var(--muted)" }}> — extrai o áudio e toca em paralelo; o vídeo e os tempos ficam intocados.</span>
        </p>
      )}

      {/* P2-P4: qualidade do preview (só afeta o PREVIEW — export sempre em qualidade total) */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, maxWidth: 480, marginBottom: 4 }}>
        <span style={{ flex: 1 }} />
        <label title="toca uma versão leve (540p, cortes sem engasgo); o export usa o original"
          style={{ fontSize: 11.5, color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: 4 }}>
          <input type="checkbox" checked={useProxy}
            onChange={(e) => { setUseProxy(e.target.checked); localStorage.setItem("fo-preview-proxy", e.target.checked ? "1" : "0"); }} />
          proxy{useProxy && proxyUrl ? " ✓" : useProxy ? "…" : ""}
        </label>
        <label style={{ fontSize: 11.5, color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: 8 }}>
          prévia
          <select value={String(resScale)} style={{ fontSize: 11.5 }}
            onChange={(e) => { const v = Number(e.target.value); setResScale(v); localStorage.setItem("fo-preview-res", String(v)); }}>
            <option value="1">Total</option>
            <option value="0.5">1/2</option>
            <option value="0.25">1/4</option>
          </select>
        </label>
      </div>
      {/* ESCALA DO PALCO EM CSS PURO. O palco é desenhado em px de EXPORT (1080×1920) e
          encolhido pra caber; esse fator PRECISA ser a largura real do container. Medi-lo
          em JS (ResizeObserver → estado) atrasa um frame e, quando a notificação do
          observer é descartada (o app tem RO aninhado: banda → pvW → coluna → preview),
          ele CONGELA num valor antigo: o palco fica mais baixo que o vídeo e a legenda
          sobe pro topo. Com container query o navegador resolve no próprio layout —
          nunca desalinha. `inline-size` (não `size`): a altura continua vindo do vídeo. */}
      {stage && (
        <style>{`
          @supports (container-type: inline-size) {
            .fo-stage { transform: scale(calc(100cqw / ${stage.w})) !important; }
          }
        `}</style>
      )}
      <div ref={containerRef} data-fs
        style={{ position: "relative", width: "100%", maxWidth: 480, background: "#000", overflow: "hidden",
          containerType: "inline-size",
          "--fs-aspect": natural ? `${natural.w} / ${natural.h}` : "9 / 16" } as React.CSSProperties}>
        <video
          ref={videoRef}
          src={src}
          onClick={togglePlayKept}
          onError={() =>
            setVideoError(
              "Não foi possível reproduzir este vídeo no navegador (provável codec não suportado, ex: H.265/HEVC ou .mkv). A transcrição e a legenda funcionam normalmente; para o preview, use um MP4 H.264.",
            )
          }
          onLoadedData={() => setVideoError(null)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onLoadedMetadata={(e) => {
            setDuration(e.currentTarget.duration || 0);
            // O PALCO (coords de export p/ legenda/popup) segue o vídeo ORIGINAL — nunca o
            // proxy (senão o WYSIWYG quebra: fontes/posições escalariam pro tamanho do proxy).
            // videoWidth 0 = metadados ainda incompletos. Aceitar isso fazia o palco
            // virar 2×2px (capFullHD tem piso 2) e a legenda ir parar no topo, gigante.
            const vw = e.currentTarget.videoWidth, vh = e.currentTarget.videoHeight;
            if (src === url && vw > 0 && vh > 0) setNatural({ w: vw, h: vh });
          }}
          style={{
            width: "100%",
            display: "block",
            cursor: "pointer",
            transform: `scale(${zoomScale})`,
            transition: "transform 0.4s ease",
            transformOrigin: "center center",
          }}
        />

        {/* Música de fundo (invisível): toca junto com o vídeo (loop do trecho). */}
        {music?.file && <audio ref={musicRef} src={music.file} preload="auto" />}
        {/* Faixa AAC paralela (correção de áudio) — sincronizada ao vídeo ORIGINAL. */}
        {fixAudioUrl && <audio ref={fixAudioRef} src={fixAudioUrl} preload="auto" />}

        {chromaLayered ? (
          /* CAMADAS (chroma + "atrás da pessoa"): fundo → popup → pessoa transparente → frente */
          <>
            <ColorCanvas video={videoRef.current} color={color} lut={lut} zoomScale={zoomScale} procScale={procScale}
              chroma={chroma} bgImage={bgImg} bgVideo={bgVid} mode="background" />
            {eyedropper && (
              <div onPointerDown={pickAt} style={{ position: "absolute", inset: 0, cursor: "crosshair", zIndex: 5 }} />
            )}
            <div {...stageProps}><PopupsOverlay popups={behindPopups} clock={clock} playing={playing} plan={cutPlan} /></div>
            <ColorCanvas video={videoRef.current} color={color} lut={lut} zoomScale={zoomScale} procScale={procScale}
              chroma={chroma} showMask={showMask} mode="person" />
            <div {...stageProps}><PopupsOverlay popups={frontPopups} clock={clock} playing={playing} plan={cutPlan} /></div>
          </>
        ) : (
          <>
            {/* Processamento WebGL (keying + despill + fundo + cor/LUT). Bypass se nada ativo. */}
            {processActive && (
              <ColorCanvas video={videoRef.current} color={color} lut={lut} zoomScale={zoomScale} procScale={procScale} canvasRefOut={colorCanvasRef}
                chroma={chroma} bgImage={bgImg} bgVideo={bgVid} showMask={showMask} />
            )}

            {/* Conta-gotas: captura o clique e lê a cor do vídeo bruto. */}
            {eyedropper && (
              <div onPointerDown={pickAt}
                style={{ position: "absolute", inset: 0, cursor: "crosshair", zIndex: 5 }} />
            )}

            {/* Palco 1 (coords de export, escalado): POPUPS — ficam ATRÁS da pessoa */}
            <div {...stageProps}>
              <PopupsOverlay popups={frontPopups} clock={clock} playing={playing} plan={cutPlan} />
            </div>

            {/* Pessoa recortada por cima do popup (composição "atrás da pessoa", RVM) */}
            <PersonMatteCanvas video={videoRef.current} active={matteActive} zoomScale={zoomScale} procScale={procScale}
              colorSourceRef={!isColorNeutral(color) ? colorCanvasRef : undefined} />
          </>
        )}

        {/* Palco 2 (coords de export, escalado): LEGENDA — folha que assina o clock */}
        <div {...stageProps}>
          <CaptionLayer clock={clock} lines={lines} style={style} />
        </div>

        {/* Palco 3: POPUPS FULLSCREEN — NA FRENTE das legendas (cobrem a tela toda) */}
        <div {...stageProps}>
          <PopupsOverlay popups={fullscreenTop} clock={clock} playing={playing} plan={cutPlan} />
        </div>
      </div>

      {/* PLAYER CUSTOM — controles integrados ao design do app (substitui os controles nativos
          do <video>, que destoavam do layout). Ligado no togglePlayKept/seek/clock já existentes. */}
      {duration > 0 && (
        <PlayerBar clock={clock} duration={duration} playing={playing}
          onToggle={togglePlayKept} onSeek={seek} videoRef={videoRef} containerRef={containerRef} />
      )}

      {/* Timeline aqui só no modo AVULSO (sem a ponte) — com transporte, ela mora
          na barra FIXA inferior do app. */}
      {!transport && duration > 0 && videoFile && (
        <CutTimeline
          videoFile={videoFile}
          duration={duration}
          cuts={cuts}
          onCutsChange={onCutsChange}
          words={allWords}
          clock={clock}
          onSeek={seek}
          onPlayKept={togglePlayKept}
          playing={playing}
          captions={captions}
          onCaptionsChange={onCaptionsChange}
          transcript={transcript}
          maxWords={style.maxWords}
        />
      )}

    </section>
  );
}

/**
 * FOLHA da legenda (P1): a ÚNICA parte da árvore que re-renderiza por frame — e é pequena
 * (uma linha de palavras). O pai (KaraokePreview) fica parado; as animações contínuas do
 * wordFx (entrada/loop) seguem vivas porque esta folha assina o FrameClock.
 */
function CaptionLayer({ clock, lines, style }: {
  clock: FrameClock;
  lines: ReturnType<typeof buildCaptionLines>;
  style: CaptionStyle;
}) {
  const time = useFrameTime(clock);
  const line = activeLine(lines, time);
  return (
    <div
      style={{
        position: "absolute",
        left: `${style.posX}%`,
        top: `${style.posY}%`,
        transform: "translate(-50%, -50%)",
        width: "90%",
        textAlign: "center",
        pointerEvents: "none",
        opacity: style.opacity,
      }}
    >
      {line && (
        <span
          style={{
            display: "inline-block",
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            letterSpacing: style.letterSpacing,
            lineHeight: 1.3,
            textShadow: shadowCss(style),
          }}
        >
          {line.words.map((w, i) => {
            const isActive = time >= w.start && time <= w.end;
            const isSpoken = time >= w.start;
            const color =
              style.mode === "static"
                ? style.colorSpoken
                : style.mode === "highlight"
                  ? isSpoken ? style.colorSpoken : style.colorUpcoming
                  : isActive ? style.colorActive : isSpoken ? style.colorSpoken : style.colorUpcoming;
            let background = "transparent";
            if (style.mode === "highlight" && isActive) {
              background = hexToRgba(style.highlight.color, style.highlight.opacity);
            } else if (style.wordBg.enabled) {
              background = hexToRgba(style.wordBg.color, style.wordBg.opacity);
            }
            const box = style.mode === "highlight" && isActive ? style.highlight : style.wordBg;
            return (
              <span
                key={i}
                style={{
                  display: "inline-block",
                  color,
                  background,
                  padding: `${box.paddingY}px ${box.paddingX}px`,
                  borderRadius: box.radius,
                  margin: `0 ${style.wordSpacing / 2}px`,
                  WebkitTextStroke: style.outline.enabled
                    ? `${style.outline.width}px ${style.outline.color}`
                    : undefined,
                  transition: "color 80ms linear, background 80ms linear",
                  ...wordFx(style, w.start, i, time),
                }}
              >
                {w.text}
              </span>
            );
          })}
        </span>
      )}
    </div>
  );
}

// ─────────────── PLAYER CUSTOM (substitui os controles nativos do <video>) ───────────────
const fmtTime = (t: number) => {
  const s = Math.max(0, Math.floor(t));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const PLAYER_ICONS: Record<string, { d: string; fill?: boolean }> = {
  play: { d: "M7 4l13 8-13 8z", fill: true },
  pause: { d: "M7 5h3v14H7zM14 5h3v14h-3z", fill: true },
  back: { d: "M11 5L4 12l7 7M4 12h16" },
  fwd: { d: "M13 5l7 7-7 7M20 12H4" },
  vol: { d: "M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 010 6" },
  mute: { d: "M4 9v6h4l5 4V5L8 9zM16 9l5 6M21 9l-5 6" },
  full: { d: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" },
};
function PBIcon({ name, size = 16 }: { name: keyof typeof PLAYER_ICONS; size?: number }) {
  const ic = PLAYER_ICONS[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24"
      fill={ic.fill ? "currentColor" : "none"} stroke={ic.fill ? "none" : "currentColor"}
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><path d={ic.d} /></svg>
  );
}
/**
 * Barra de player com a cara do app. O tempo/progresso é pintado por clock.subscribe
 * (imperativo, sem re-render por frame — mesma filosofia P1 do preview). Botões ligam no
 * togglePlayKept/seek já existentes; volume e tela cheia agem direto no <video>/container.
 */
function PlayerBar({ clock, duration, playing, onToggle, onSeek, videoRef, containerRef }: {
  clock: { time: number; subscribe: (f: (t: number) => void) => () => void };
  duration: number; playing: boolean; onToggle: () => void; onSeek: (t: number) => void;
  videoRef: { current: HTMLVideoElement | null }; containerRef: { current: HTMLDivElement | null };
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    const paint = (t: number) => {
      const pct = duration > 0 ? Math.max(0, Math.min(100, (t / duration) * 100)) : 0;
      if (fillRef.current) fillRef.current.style.width = pct + "%";
      if (timeRef.current) timeRef.current.textContent = fmtTime(t);
    };
    paint(clock.time);
    return clock.subscribe(paint);
  }, [clock, duration]);
  const seekAt = (e: React.MouseEvent) => {
    const el = trackRef.current; if (!el || duration <= 0) return;
    const r = el.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration);
  };
  const toggleMute = () => { const v = videoRef.current; if (!v) return; v.muted = !v.muted; setMuted(v.muted); };
  const fullscreen = () => { const el = containerRef.current; if (el?.requestFullscreen) el.requestFullscreen().catch(() => {}); };
  return (
    <div style={{ width: "100%", maxWidth: 480, marginTop: 10 }}>
      <div ref={trackRef} onClick={seekAt}
        style={{ height: 6, borderRadius: 3, background: "var(--panel3)", cursor: "pointer", marginBottom: 9, overflow: "hidden" }}>
        <div ref={fillRef} style={{ height: "100%", width: "0%", background: "linear-gradient(90deg,#b3a3cf,#9aa4c8)" }} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={() => onSeek(0)} style={pbBtn} title="Início"><PBIcon name="back" /></button>
        <button onClick={onToggle} style={{ ...pbBtn, ...pbBtnPlay }} title="Play / Pause (espaço)"><PBIcon name={playing ? "pause" : "play"} size={18} /></button>
        <button onClick={() => onSeek(duration)} style={pbBtn} title="Fim"><PBIcon name="fwd" /></button>
        <span style={{ fontSize: 12, color: "var(--muted)", fontVariantNumeric: "tabular-nums", marginLeft: 2 }}>
          <span ref={timeRef} style={{ color: "var(--text)" }}>00:00</span> / {fmtTime(duration)}
        </span>
        <span style={{ flex: 1 }} />
        <AudioMeter videoRef={videoRef} playing={playing} />
        <button onClick={toggleMute} style={pbBtn} title="Mudo"><PBIcon name={muted ? "mute" : "vol"} /></button>
        <button onClick={fullscreen} style={pbBtn} title="Tela cheia"><PBIcon name="full" /></button>
      </div>
    </div>
  );
}
const pbBtn: React.CSSProperties = {
  width: 32, height: 32, borderRadius: 9, border: "1px solid var(--border)",
  background: "var(--panel2)", color: "var(--text)", display: "grid", placeItems: "center", cursor: "pointer", padding: 0,
};
const pbBtnPlay: React.CSSProperties = {
  width: 38, height: 38, background: "linear-gradient(180deg,#3d3d3d,#313131)", borderColor: "transparent",
  boxShadow: "0 10px 24px rgba(0,0,0,.45),0 2px 6px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.06)",
};

// ─────────────── SENSOR DE ÁUDIO (VU meter + clip) ───────────────
// Analisa o <video> via Web Audio (AnalyserNode). Verde/laranja = ok; VERMELHO (pico ~0dBFS)
// = ESTOURANDO. createMediaElementSource só pode rodar 1x por elemento — cacheado por WeakMap.
const audioGraphs = new WeakMap<HTMLMediaElement, { ctx: AudioContext; analyser: AnalyserNode }>();
function getAudioGraph(v: HTMLMediaElement): { ctx: AudioContext; analyser: AnalyserNode } | null {
  const cached = audioGraphs.get(v);
  if (cached) return cached;
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    const src = ctx.createMediaElementSource(v);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    analyser.connect(ctx.destination); // mantém o áudio tocando pelo grafo
    const g = { ctx, analyser };
    audioGraphs.set(v, g);
    return g;
  } catch { return null; } // já conectado (outro mount) ou sem áudio
}
function AudioMeter({ videoRef, playing }: { videoRef: { current: HTMLVideoElement | null }; playing: boolean }) {
  const maskRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<{ ctx: AudioContext; analyser: AnalyserNode; data: Uint8Array<ArrayBuffer> } | null>(null);
  const clipAtRef = useRef(0);
  // Cria o grafo Web Audio no 1º PLAY (gesto do usuário libera o AudioContext). Criar antes
  // rotearia o áudio por um ctx suspenso -> vídeo mudo. Antes do play, o áudio toca nativo.
  useEffect(() => {
    const v = videoRef.current;
    if (playing && v && !graphRef.current) {
      const g = getAudioGraph(v);
      if (g) graphRef.current = { ...g, data: new Uint8Array(new ArrayBuffer(g.analyser.fftSize)) };
    }
    if (playing) graphRef.current?.ctx.resume().catch(() => {});
  }, [playing, videoRef]);
  // Loop de leitura do nível (rAF) — pinta o meter e o clip imperativamente.
  useEffect(() => {
    let id = 0;
    const tick = () => {
      const g = graphRef.current;
      if (g) {
        g.analyser.getByteTimeDomainData(g.data);
        let peak = 0;
        for (let i = 0; i < g.data.length; i++) { const a = Math.abs(g.data[i] - 128) / 128; if (a > peak) peak = a; }
        const pct = Math.min(100, peak * 100);
        if (maskRef.current) maskRef.current.style.width = (100 - pct) + "%";
        if (peak >= 0.985) clipAtRef.current = performance.now();
        const clipping = performance.now() - clipAtRef.current < 900; // peak-hold ~0.9s
        if (clipRef.current) {
          clipRef.current.style.background = clipping ? "#ff3b3b" : "var(--panel3)";
          clipRef.current.style.boxShadow = clipping ? "0 0 7px #ff3b3b" : "none";
        }
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div title="Sensor de áudio — verde/laranja ok · VERMELHO = áudio ESTOURANDO (clip)"
      style={{ display: "flex", alignItems: "center", gap: 6, marginRight: 2 }}>
      <div style={{ position: "relative", width: 84, height: 8, borderRadius: 4, overflow: "hidden",
        background: "linear-gradient(90deg,#3ea567 0%,#3ea567 52%,#e0b64a 76%,#ff3b3b 92%)" }}>
        <div ref={maskRef} style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: "100%", background: "var(--panel3)" }} />
      </div>
      <div ref={clipRef} title="clip (estouro)" style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--panel3)", flex: "0 0 7px" }} />
    </div>
  );
}
