import { comBase, getStudioToken } from '../../os-session';
import { useEffect, useState } from "react";
import type { TranscriptSegment, Cut, Zoom, Popup, Caption } from "../../../../shared/timeline";
import type { CaptionStyle } from "../../../../shared/captionStyle";
import type { ColorSettings } from "../../../../shared/color";
import type { Music } from "../../../../shared/timeline";
import { isChromaActive, type ChromaSettings } from "../../../../shared/chroma";

type State =
  | { phase: "idle" }
  | { phase: "preparing" }
  | { phase: "rendering"; progress: number }
  | { phase: "done"; url: string }
  | { phase: "error"; message: string };

/** Converte data URL (base64) em Blob para enviar como arquivo no multipart. */
function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(",");
  const mime = head.match(/:(.*?);/)?.[1] ?? "application/octet-stream";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/** Cap Full HD (mesmo do backend): lado maior ≤ 1920, menor ≤ 1080. */
function capFullHD(w: number, h: number) {
  const s = Math.min(1920 / Math.max(w, h), 1080 / Math.min(w, h), 1);
  const even = (n: number) => Math.max(2, Math.round((n * s) / 2) * 2);
  return { w: even(w), h: even(h) };
}

/**
 * Etapa 6: EXPORT. Render via Remotion como job com progresso (%). Sempre em
 * Full HD (4K/8K são reduzidos p/ 1080p → render mais rápido).
 */
export function ExportPanel({
  videoFile, transcript, style, durationSec, cuts, zooms, popups, color, chroma, music, projectId, captions,
}: {
  videoFile: File | null;
  transcript: TranscriptSegment[];
  style: CaptionStyle;
  durationSec: number;
  cuts: Cut[];
  zooms: Zoom[];
  popups: Popup[];
  /** Legendas com tempo manual — precisam chegar ao render, senão o vídeo sai diferente do preview. */
  captions?: Caption[];
  color: ColorSettings;
  chroma: ChromaSettings;
  music?: Music;
  projectId: string | null;
}) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [state, setState] = useState<State>({ phase: "idle" });

  useEffect(() => {
    if (!videoFile) return;
    const url = URL.createObjectURL(videoFile);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => { setDims({ w: v.videoWidth, h: v.videoHeight }); URL.revokeObjectURL(url); };
    v.src = url;
  }, [videoFile]);

  async function render() {
    if (!videoFile) { alert("O vídeo ainda está carregando (abertura em streaming) — aguarde alguns segundos e exporte de novo."); return; }
    setState({ phase: "preparing" });
    const form = new FormData();
    form.append("video", videoFile);

    // As imagens dos popups (data URL base64) vão como ARQUIVOS separados, e no
    // props ficam só tokens "ref:img_N" — mantém o JSON leve (evita o limite do multipart).
    const popupsOut = structuredClone(popups) as typeof popups;
    let imgN = 0;
    const externalize = (u?: string): string | undefined => {
      if (!u || !u.startsWith("data:")) return u;
      const field = `img_${imgN++}`;
      form.append(field, dataUrlToBlob(u), field);
      return `ref:${field}`;
    };
    for (const p of popupsOut) {
      if (p.type === "support") {
        p.content.imageUrl = externalize(p.content.imageUrl);
        p.content.logoUrl = externalize(p.content.logoUrl);
      } else if (p.type === "fullscreen" && p.placeholder) {
        p.placeholder.imageUrl = externalize(p.placeholder.imageUrl);
      }
    }

    // Fundo do chroma (imagem/vídeo em data URL) → arquivo separado "chromabg";
    // no props fica só o token "ref:chromabg" (evita JSON gigante com base64).
    let chromaOut = chroma;
    if (isChromaActive(chroma) && (chroma.background?.type === "image" || chroma.background?.type === "video")) {
      const f = chroma.background.file;
      if (f?.startsWith("data:")) {
        form.append("chromabg", dataUrlToBlob(f), "chromabg");
        chromaOut = { ...chroma, background: { ...chroma.background, file: "ref:chromabg" } };
      }
    }

    const propsJson = JSON.stringify({
      transcript, cuts, zooms, popups: popupsOut, style, color, chroma: chromaOut, music, durationSec, projectId, captions,
      fps: 30, width: dims?.w ?? 1080, height: dims?.h ?? 1920,
    });
    form.append("props", propsJson);

    // (a) resumo do que está sendo enviado (diagnóstico no console).
    console.log(`[EXPORT-DEBUG] (a) enviando: props=${propsJson.length}B, imagens=${imgN}, ` +
      `popups=${popups.length}, cuts=${cuts.length}, zooms=${zooms.length}, font=${style.fontFamily}`);

    try {
      const res = await fetch(comBase("/api/render"), { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Falha ao iniciar render");
      poll(data.jobId);
    } catch (e) {
      setState({ phase: "error", message: (e as Error).message });
    }
  }

  function poll(jobId: string) {
    const iv = setInterval(async () => {
      try {
        const r = await fetch(comBase(`/api/render/progress/${jobId}`));
        const j = await r.json();
        if (j.status === "preparing") setState({ phase: "preparing" });
        else if (j.status === "rendering") setState({ phase: "rendering", progress: j.progress ?? 0 });
        else if (j.status === "done") {
          clearInterval(iv);
          // O download é um <a href> (não passa pelo interceptor de fetch): precisa do subpath
          // via comBase E do token na URL (?t=), senão sob o iframe do OS dá 404/401 e o
          // navegador mostra "vídeo não disponível". Em dev (sem BASE/sem token) fica igual.
          const tok = getStudioToken();
          const resultUrl = comBase(`/api/render/result/${jobId}`) + (tok ? `?t=${encodeURIComponent(tok)}` : "");
          setState({ phase: "done", url: resultUrl });
        } else if (j.status === "error") {
          clearInterval(iv);
          setState({ phase: "error", message: j.error ?? "Erro no render" });
        }
      } catch { /* segue tentando */ }
    }, 700);
  }

  const cap = dims ? capFullHD(dims.w, dims.h) : null;
  const busy = state.phase === "preparing" || state.phase === "rendering";

  const pct = state.phase === "rendering" ? Math.round(state.progress * 100) : 0;

  return (
    <section>
      <div className="fo-sec">
        <div className="t">Exportar</div>
        <div className="s">Tudo que você montou vira um MP4 final.</div>
      </div>

      {/* card único — o estado do render É o visual */}
      <div style={{
        background: "var(--panel2)", border: "1px solid var(--border)", borderRadius: 16,
        padding: "28px 24px", textAlign: "center",
      }}>
        {/* resumo do que vai no vídeo — pills, não texto */}
        <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", marginBottom: 20 }}>
          {cap && <span style={pillStyle}><strong style={{ color: "var(--text)" }}>{cap.w}×{cap.h}</strong></span>}
          <span style={pillStyle}><strong style={{ color: "var(--text)" }}>{cuts.filter((c) => c.enabled).length}</strong>&nbsp;cortes</span>
          <span style={pillStyle}><strong style={{ color: "var(--text)" }}>{zooms.length}</strong>&nbsp;zooms</span>
          <span style={pillStyle}><strong style={{ color: "var(--text)" }}>{popups.length}</strong>&nbsp;popups</span>
          {music?.file && <span style={pillStyle}>música ✓</span>}
          {isChromaActive(chroma) && <span style={pillStyle}>chroma ✓</span>}
        </div>

        {state.phase !== "done" && (
          <button disabled={busy} onClick={render}
            style={{
              background: "linear-gradient(180deg, #f6f6f6, #d9d9d9)", color: "#1a1a1a",
              fontWeight: 700, fontSize: 15, padding: "12px 44px", borderRadius: 999,
            }}>
            {state.phase === "preparing" ? "Preparando…" : state.phase === "rendering" ? `Renderizando ${pct}%` : "Renderizar MP4"}
          </button>
        )}

        {state.phase === "rendering" && (
          <div style={{ margin: "20px auto 0", maxWidth: 420 }}>
            <div style={{ height: 8, background: "var(--panel3)", borderRadius: 999, overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, height: "100%", background: "linear-gradient(90deg, #d9d9d9, #f6f6f6)", transition: "width 0.3s", borderRadius: 999 }} />
            </div>
          </div>
        )}
        {state.phase === "preparing" && (
          <p style={{ fontSize: 12, color: "var(--faint)", margin: "12px 0 0" }}>preparando o render… (mais lento na 1ª vez)</p>
        )}
        {state.phase === "error" && (
          <p style={{ color: "var(--red)", fontSize: 13, margin: "16px 0 0" }}>{state.message}</p>
        )}
        {state.phase === "done" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
            <a href={state.url} download="fluxo-ouro.mp4" style={{
              background: "linear-gradient(180deg, #f6f6f6, #d9d9d9)", color: "#1a1a1a", textDecoration: "none",
              fontWeight: 700, fontSize: 15, padding: "12px 44px", borderRadius: 999,
            }}>
              Baixar vídeo final
            </a>
            <button onClick={render} style={{ fontSize: 12, background: "transparent", color: "var(--faint)" }}>
              renderizar de novo
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

const pillStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", background: "var(--panel3)",
  border: "1px solid var(--border)", borderRadius: 999, padding: "4px 16px",
  fontSize: 12.5, color: "var(--muted)",
};
