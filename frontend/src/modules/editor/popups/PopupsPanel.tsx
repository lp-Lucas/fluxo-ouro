import { useState } from "react";
import type {
  Popup,
  SupportPopup,
  FullscreenPopup,
  SupportPreset,
  PopupTransition,
  TypoLine,
  TranscriptSegment,
} from "../../../../../shared/timeline";
import { DEFAULT_POPUP_TRANSITION } from "../../../../../shared/timeline";
import { DEFAULT_STYLE } from "../../../../../shared/captionStyle";
import { getPopupDetector } from "./detector";
import { deriveTypo } from "./PopupViews";
import { CaptionControls } from "../../legenda/CaptionControls";
import { Card, SliderField, Toggle } from "../../../workspace/ui";

const SUPPORT_PRESETS: { value: SupportPreset; label: string }[] = [
  { value: "balloon", label: "Balão de fala" },
  { value: "textbox", label: "Caixa de texto" },
  { value: "logo-card", label: "Card com logo" },
  { value: "photo-card", label: "Card com foto" },
  { value: "photo-plain", label: "Imagem solta" },
  { value: "highlight-number", label: "Número gigante" },
  { value: "keyword", label: "Palavra-chave" },
  { value: "typography", label: "Texto estilizado" },
];

const REASON_LABEL: Record<string, string> = {
  marca: "marca", dado: "dado", nome: "nome", conceito: "conceito", "demo-visual": "demonstração",
};

/**
 * POPUPS — linguagem simples: "o que aparece" (esquerda) e "onde & quando"
 * (direita, com a grade de posição). Animação escondida em "▸ animação".
 */
export function PopupsPanel({
  transcript,
  popups,
  onChange,
}: {
  transcript: TranscriptSegment[];
  popups: Popup[];
  onChange: (p: Popup[]) => void;
}) {
  const upd = (id: string, patch: Partial<Popup>) =>
    onChange(popups.map((p) => (p.id === id ? ({ ...p, ...patch } as Popup) : p)));

  function addSupport() {
    const p: SupportPopup = {
      id: `popup-${Date.now()}`, type: "support", at: 0, duration: 2.5, source: "manual",
      transition: { ...DEFAULT_POPUP_TRANSITION }, preset: "keyword", content: { text: "" },
      layout: { x: 70, y: 30, scale: 1 },
    };
    onChange([...popups, p]);
  }
  function addFullscreen() {
    const p: FullscreenPopup = {
      id: `popup-${Date.now()}`, type: "fullscreen", at: 0, duration: 3, source: "manual",
      transition: { ...DEFAULT_POPUP_TRANSITION }, placeholder: { label: "Tela animada" },
    };
    onChange([...popups, p]);
  }

  return (
    <div>
      <style>{`
        .pp-add {
          display: flex; flex-direction: column; align-items: flex-start; gap: 8px;
          background: var(--panel2); border: 1px solid var(--border); border-radius: 16px;
          padding: 16px; text-align: left; cursor: pointer; font-family: inherit;
          transition: background 0.2s ease, border-color 0.2s ease;
        }
        .pp-add:hover:not(:disabled) { background: var(--panel3); border-color: var(--border-active); }
        .pp-add:disabled { opacity: 0.4; cursor: default; }
        .pp-add .ic {
          width: 36px; height: 36px; border-radius: 11px; background: var(--panel3);
          border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; color: var(--muted);
        }
        .pp-add:hover:not(:disabled) .ic { color: var(--text); }
        .pp-add .nm { font-size: 13px; font-weight: 600; color: var(--text); }
        .pp-add .ds { font-size: 11px; color: var(--faint); line-height: 1.35; }
        .pp-badge {
          display: inline-flex; align-items: center; padding: 2px 10px; border-radius: 999px;
          font-size: 11px; border: 1px solid;
        }
      `}</style>

      <div className="fo-sec">
        <div className="t">Popups</div>
        <div className="s">Coisas que aparecem por cima do vídeo — um texto, uma imagem, uma tela.</div>
      </div>

      {/* adicionar — 3 cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 16 }}>
        <button className="pp-add" disabled={transcript.length === 0}
          onClick={() => onChange(getPopupDetector().detect(transcript))}>
          <span className="ic">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /><circle cx="12" cy="12" r="4" /></svg>
          </span>
          <span className="nm">Sugerir pela fala</span>
          <span className="ds">acha marcas, números e nomes no que foi dito</span>
        </button>
        <button className="pp-add" onClick={addSupport}>
          <span className="ic">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="3" /><rect x="12" y="6" width="7" height="5" rx="1.5" /></svg>
          </span>
          <span className="nm">Elemento na tela</span>
          <span className="ds">texto, número ou imagem num canto do vídeo</span>
        </button>
        <button className="pp-add" onClick={addFullscreen}>
          <span className="ic">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 12h8M12 8v8" /></svg>
          </span>
          <span className="nm">Tela cheia</span>
          <span className="ds">cobre o vídeo inteiro (as telas do FLOW entram aqui)</span>
        </button>
      </div>

      {popups.length === 0 && (
        <p style={{ color: "var(--faint)", fontSize: 12.5, textAlign: "center", padding: "8px 0" }}>
          nenhum popup ainda — crie um acima ou marque uma palavra na aba 1
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {popups.map((p) => (
          <Card key={p.id} style={{ padding: "16px 16px" }}>
            {/* cabeçalho do popup */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              {p.type === "support"
                ? <span className="pp-badge" style={{ color: "var(--green)", borderColor: "rgba(88,196,120,0.3)", background: "rgba(88,196,120,0.1)" }}>elemento</span>
                : <span className="pp-badge" style={{ color: "var(--purple)", borderColor: "rgba(179,163,207,0.3)", background: "rgba(179,163,207,0.1)" }}>tela cheia</span>}
              {p.source === "auto" && p.trigger && (
                <span style={{ fontSize: 11, color: "var(--faint)" }}>
                  sugerido · {REASON_LABEL[p.trigger.reason]} · "{p.trigger.matchedText}"
                </span>
              )}
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                aparece em <NumIn value={p.at} onChange={(v) => upd(p.id, { at: v })} />s
                e fica <NumIn value={p.duration} onChange={(v) => upd(p.id, { duration: v })} />s
              </span>
              <button onClick={() => onChange(popups.filter((x) => x.id !== p.id))}
                style={{ width: 26, height: 26, padding: 0, borderRadius: 999, fontSize: 13, color: "var(--red)", background: "transparent", display: "grid", placeItems: "center" }}>×</button>
            </div>

            {p.type === "support" ? (
              <SupportFields p={p} upd={upd} />
            ) : (
              <FullscreenFields p={p} upd={upd} />
            )}

            <TransitionFields p={p} upd={upd} />
          </Card>
        ))}
      </div>
    </div>
  );
}

/** Lê um arquivo de imagem como data URL (self-contained, persiste e vai ao render). */
function readImage(file: File, cb: (dataUrl: string) => void) {
  const reader = new FileReader();
  reader.onload = () => cb(reader.result as string);
  reader.readAsDataURL(file);
}

function SupportFields({ p, upd }: { p: SupportPopup; upd: (id: string, patch: Partial<Popup>) => void }) {
  const setContent = (patch: Partial<SupportPopup["content"]>) =>
    upd(p.id, { content: { ...p.content, ...patch } });

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 240px", gap: 20, alignItems: "start" }}>
      {/* ESQUERDA — o que aparece */}
      <div>
        <div className="fo-field" style={{ marginBottom: 12 }}>
          <label>O que aparece</label>
          <select value={p.preset} onChange={(e) => upd(p.id, { preset: e.target.value as SupportPreset })}>
            {SUPPORT_PRESETS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>

        {p.preset === "highlight-number" ? (
          <div className="fo-field" style={{ marginBottom: 12 }}>
            <label>Número / valor</label>
            <input value={p.content.value ?? ""} placeholder="Ex. R$ 2M ou 300%"
              onChange={(e) => setContent({ value: e.target.value })} />
          </div>
        ) : p.preset === "typography" ? (
          <TypoEditor p={p} setContent={setContent} />
        ) : (
          <div className="fo-field" style={{ marginBottom: 12 }}>
            <label>Texto</label>
            <input value={p.content.text ?? ""} placeholder="O que está escrito"
              onChange={(e) => setContent({ text: e.target.value })} />
          </div>
        )}

        {p.preset === "logo-card" && (
          <ImageField label="Logo" url={p.content.logoUrl}
            onPick={(u) => setContent({ logoUrl: u })} onClear={() => setContent({ logoUrl: "" })} />
        )}
        {(p.preset === "photo-card" || p.preset === "photo-plain") && (
          <ImageField label="Imagem" url={p.content.imageUrl}
            onPick={(u) => setContent({ imageUrl: u })} onClear={() => setContent({ imageUrl: "" })} />
        )}

        <AiElementField onDone={(dataUrl) => { upd(p.id, { preset: "photo-plain" }); setContent({ imageUrl: dataUrl }); }} />
      </div>

      {/* DIREITA — onde fica */}
      <div>
        <div className="fo-field" style={{ marginBottom: 12 }}>
          <label>Onde fica na tela</label>
          <PositionGrid x={p.layout.x} y={p.layout.y}
            onPick={(x, y) => upd(p.id, { layout: { ...p.layout, x, y } })} />
        </div>
        <SliderField label="Tamanho" value={p.layout.scale} display={`${p.layout.scale.toFixed(2)}×`}
          min={0.3} max={3} step={0.05} onChange={(v) => upd(p.id, { layout: { ...p.layout, scale: v } })} />
        <Toggle on={!!p.behindSubject} onChange={(b) => upd(p.id, { behindSubject: b })} label="atrás da pessoa" />
      </div>
    </div>
  );
}

/**
 * Gera um ELEMENTO por IA (botão, selo, seta, card…) em PNG transparente e
 * coloca como imagem do popup. Descreva cores/texto no pedido.
 */
function AiElementField({ onDone }: { onDone: (dataUrl: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [refs, setRefs] = useState<{ id: string; src: string }[]>([]);

  const addRefs = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach((f) => {
      const rd = new FileReader();
      rd.onload = () => setRefs((v) => [...v, { id: Math.random().toString(36).slice(2), src: rd.result as string }]);
      rd.readAsDataURL(f);
    });
  };

  async function gerar() {
    if (!text.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/popup-element", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: text, images: refs.map((x) => x.src) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Falha ao iniciar");
      setJobId(d.jobId);
      const result = await new Promise<{ imageUrl?: string }>((resolve, reject) => {
        const iv = setInterval(async () => {
          try {
            const pr = await fetch(`/api/flow/progress/${d.jobId}`);
            const j = await pr.json();
            if (j.status === "done") { clearInterval(iv); resolve(j.result ?? {}); }
            else if (j.status === "error") { clearInterval(iv); reject(new Error(j.error ?? "Erro na geração")); }
          } catch { /* segue */ }
        }, 1500);
      });
      if (!result.imageUrl) throw new Error("A IA não retornou a imagem.");
      onDone(result.imageUrl);
      setText(""); setRefs([]);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); setJobId(null); }
  }
  async function parar() {
    if (jobId) { try { await fetch(`/api/flow/cancel/${jobId}`, { method: "POST" }); } catch { /* */ } }
  }

  return (
    <div style={{ marginTop: 12, background: "var(--field)", border: "1px solid var(--field-border)", borderRadius: 12, padding: "12px 12px" }}>
      <div className="fo-field">
        <label style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Ou crie o elemento com IA</span>
          <span style={{ color: "var(--faint)", fontWeight: 400 }}>
            {refs.length ? "a frase substitui o texto do botão anexado · fundo removido" : "sai com fundo transparente"}
          </span>
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") gerar(); }}
            placeholder={refs.length ? 'Frase do botão — ex.: GARANTA SUA VAGA' : 'Ex. botão vermelho "COMPRE AGORA"'}
            style={{ flex: 1 }} disabled={busy} />
          <button onClick={gerar} disabled={busy || !text.trim()}
            style={{ background: "var(--accent)", color: "#1a1a1a", fontWeight: 600, whiteSpace: "nowrap" }}>
            {busy ? "gerando…" : "Gerar"}
          </button>
          {busy && <button onClick={parar} style={{ fontSize: 12, color: "var(--red)", background: "transparent" }}>parar</button>}
        </div>

        {/* referências: anexa imagens que guiam o estilo/forma do elemento */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
          {refs.map((rf) => (
            <span key={rf.id} style={{ position: "relative", display: "inline-block" }}>
              <img src={rf.src} alt="" style={{ height: 40, borderRadius: 8, border: "1px solid var(--field-border)", display: "block" }} />
              <button onClick={() => setRefs((v) => v.filter((x) => x.id !== rf.id))} disabled={busy}
                style={{ position: "absolute", top: -6, right: -6, width: 16, height: 16, lineHeight: "13px", padding: 0, fontSize: 11, borderRadius: "50%", border: "none", background: "var(--red)", color: "#fff", cursor: "pointer" }}>×</button>
            </span>
          ))}
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)", cursor: busy ? "default" : "pointer",
            background: "var(--panel3)", border: "1px dashed var(--field-border)", borderRadius: 8, padding: "8px 12px" }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
            {refs.length ? "mais referências" : "anexar o botão modelo"}
            <input type="file" accept="image/*" multiple style={{ display: "none" }} disabled={busy}
              onChange={(e) => { addRefs(e.target.files); e.target.value = ""; }} />
          </label>
          <span style={{ fontSize: 11, color: "var(--faint)" }}>
            {refs.length ? "o design do botão é replicado fielmente — só o texto muda" : "anexe um botão pronto pra trocar só a frase dele"}
          </span>
        </div>

        {err && <span style={{ fontSize: 11, color: "var(--red)", display: "block", marginTop: 8 }}>{err}</span>}
      </div>
    </div>
  );
}

/** Mini-tela 9:16 — clique onde o elemento deve ficar. */
function PositionGrid({ x, y, onPick }: { x: number; y: number; onPick: (x: number, y: number) => void }) {
  const COLS = 9, ROWS = 16, CELL = 13;
  const activeCol = Math.min(COLS - 1, Math.max(0, Math.round((x / 100) * COLS - 0.5)));
  const activeRow = Math.min(ROWS - 1, Math.max(0, Math.round((y / 100) * ROWS - 0.5)));

  return (
    <span title="clique onde o elemento deve aparecer"
      style={{ display: "inline-grid", gridTemplateColumns: `repeat(${COLS}, ${CELL}px)`,
        gap: 1, padding: 4, background: "#0d0d0d", borderRadius: 12, border: "1px solid var(--border)" }}>
      {Array.from({ length: ROWS }).map((_, row) =>
        Array.from({ length: COLS }).map((__, col) => {
          const active = col === activeCol && row === activeRow;
          return (
            <button key={`${col}-${row}`} title={`${Math.round(((col + 0.5) / COLS) * 100)}%, ${Math.round(((row + 0.5) / ROWS) * 100)}%`}
              onClick={() => onPick(+(((col + 0.5) / COLS) * 100).toFixed(1), +(((row + 0.5) / ROWS) * 100).toFixed(1))}
              style={{ width: CELL, height: CELL, padding: 0, borderRadius: 3, cursor: "pointer",
                border: "none", background: active ? "#f2f2f2" : "#2a2a2a",
                boxShadow: active ? "0 0 8px rgba(255,255,255,0.4)" : undefined }} />
          );
        }),
      )}
    </span>
  );
}

/** Editor das linhas da tipografia (texto + tamanho por linha). */
function TypoEditor({ p, setContent }: { p: SupportPopup; setContent: (patch: Partial<SupportPopup["content"]>) => void }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const typo = p.content.typo ?? deriveTypo(p.content.text);
  const setTypo = (patch: Partial<{ lines: TypoLine[]; align: "left" | "center" | "right"; lineGap: number }>) =>
    setContent({ typo: { lines: typo.lines, align: typo.align ?? "center", lineGap: typo.lineGap, ...patch } });
  const setLines = (lines: TypoLine[]) => setTypo({ lines });
  const patchLine = (i: number, patch: Partial<TypoLine>) =>
    setLines(typo.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
      {typo.lines.map((ln, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <input value={ln.text} placeholder="texto"
              onChange={(e) => patchLine(i, { text: e.target.value })} style={{ font: "inherit", width: 120 }} />
            <span style={{ fontSize: 11, color: "var(--faint)" }}>{ln.size}px</span>
            <input type="range" min={12} max={140} value={ln.size}
              onChange={(e) => patchLine(i, { size: +e.target.value })} />
            <input type="color" value={ln.color ?? "#ffffff"}
              onChange={(e) => patchLine(i, { color: e.target.value })} />
            <button onClick={() => setOpenIdx(openIdx === i ? null : i)}
              style={{ fontWeight: ln.style ? 700 : 400, fontSize: 12 }}>
              {openIdx === i ? "▾ estilo" : "▸ estilo"}
            </button>
            {typo.lines.length > 1 && (
              <button onClick={() => { setLines(typo.lines.filter((_, j) => j !== i)); setOpenIdx(null); }} style={{ color: "var(--red)", background: "transparent" }}>×</button>
            )}
          </span>

          {openIdx === i && (
            <div style={{ marginLeft: 8 }}>
              <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 4px" }}>
                Estilo desta linha (fonte, contorno, sombra…).{" "}
                {ln.style && <a onClick={() => patchLine(i, { style: undefined })} style={{ color: "var(--red)", cursor: "pointer" }}>limpar</a>}
              </p>
              <CaptionControls
                hideCaptionOnly
                style={ln.style ?? p.content.typoStyle ?? DEFAULT_STYLE}
                onChange={(s) => patchLine(i, { style: s })}
              />
            </div>
          )}
        </div>
      ))}

      <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={() => setLines([...typo.lines, { text: "linha", size: 22, weight: 600 }])} style={{ fontSize: 12 }}>+ linha</button>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>alinhar{" "}
          <select value={typo.align ?? "center"} onChange={(e) => setTypo({ align: e.target.value as "left" | "center" | "right" })}>
            <option value="left">esquerda</option>
            <option value="center">centro</option>
            <option value="right">direita</option>
          </select>
        </label>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>espaço {typo.lineGap ?? 0}px{" "}
          <input type="range" min={-60} max={80} value={typo.lineGap ?? 0}
            onChange={(e) => setTypo({ lineGap: +e.target.value })} />
        </label>
      </span>
    </div>
  );
}

function ImageField({ label, url, onPick, onClear }: {
  label: string; url?: string; onPick: (dataUrl: string) => void; onClear: () => void;
}) {
  return (
    <div className="fo-field" style={{ marginBottom: 12 }}>
      <label>{label}</label>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {url && <img src={url} alt="" style={{ height: 40, width: 40, objectFit: "cover", borderRadius: 12, border: "1px solid var(--border)" }} />}
        <input type="file" accept="image/*" style={{ flex: 1, fontSize: 11 }}
          onChange={(e) => e.target.files?.[0] && readImage(e.target.files[0], onPick)} />
        {url && <button onClick={onClear} style={{ color: "var(--red)", background: "transparent", fontSize: 12 }}>remover</button>}
      </div>
    </div>
  );
}

function FullscreenFields({ p, upd }: { p: FullscreenPopup; upd: (id: string, patch: Partial<Popup>) => void }) {
  return (
    <div>
      <div className="fo-row" style={{ marginBottom: 0 }}>
        <div className="fo-field">
          <label>Rótulo</label>
          <input value={p.placeholder?.label ?? ""} placeholder="Ex. Tela animada"
            onChange={(e) => upd(p.id, { placeholder: { ...p.placeholder, label: e.target.value } })} />
        </div>
        <ImageField label="Imagem (opcional)" url={p.placeholder?.imageUrl}
          onPick={(u) => upd(p.id, { placeholder: { ...p.placeholder, imageUrl: u } })}
          onClear={() => upd(p.id, { placeholder: { ...p.placeholder, imageUrl: "" } })} />
      </div>
      <span style={{ fontSize: 11.5, color: "var(--faint)" }}>
        {p.motionPointId ? `ligada ao motion ${p.motionPointId}` : "as telas geradas no FLOW entram aqui automaticamente"}
      </span>
    </div>
  );
}

const IN_ANIMS: { value: PopupTransition["inType"]; label: string }[] = [
  { value: "none", label: "aparece direto" },
  { value: "fade", label: "surge (fade)" },
  { value: "slide", label: "sobe de baixo" },
  { value: "scale", label: "cresce" },
  { value: "spring", label: "pula (spring)" },
  { value: "pop-bounce", label: "pop com quique" },
  { value: "slide-up-blur", label: "sobe desfocando" },
  { value: "slide-left", label: "vem da esquerda" },
  { value: "slide-right", label: "vem da direita" },
  { value: "zoom-blur", label: "zoom + desfoque" },
  { value: "rotate", label: "gira entrando" },
];
const OUT_ANIMS: { value: PopupTransition["outType"]; label: string }[] = [
  { value: "none", label: "some direto" },
  { value: "fade", label: "desvanece" },
  { value: "slide", label: "desce" },
  { value: "scale", label: "encolhe" },
  { value: "zoom-blur", label: "zoom + desfoque" },
  { value: "slide-blur", label: "desce desfocando" },
];

/** Animação de entrada/saída — escondida atrás de "▸ animação" (ajuste fino). */
function TransitionFields({ p, upd }: { p: Popup; upd: (id: string, patch: Partial<Popup>) => void }) {
  const setT = (patch: Partial<PopupTransition>) => upd(p.id, { transition: { ...p.transition, ...patch } });
  return (
    <details style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
      <summary style={{ fontSize: 12, color: "var(--muted)", cursor: "pointer", userSelect: "none" }}>animação</summary>
      <div className="fo-row" style={{ marginTop: 12, marginBottom: 0 }}>
        <div className="fo-field">
          <label style={{ display: "flex", justifyContent: "space-between" }}>
            <span>Como entra</span>
            <span style={{ color: "var(--faint)", fontWeight: 400 }}>{p.transition.inDuration.toFixed(2)}s</span>
          </label>
          <select value={p.transition.inType} onChange={(e) => setT({ inType: e.target.value as PopupTransition["inType"] })}>
            {IN_ANIMS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
          <input type="range" min={0.05} max={1.5} step={0.05} value={p.transition.inDuration}
            onChange={(e) => setT({ inDuration: +e.target.value })} style={{ width: "100%", padding: 0, marginTop: 8, border: "none", background: "transparent" }} />
        </div>
        <div className="fo-field">
          <label style={{ display: "flex", justifyContent: "space-between" }}>
            <span>Como sai</span>
            <span style={{ color: "var(--faint)", fontWeight: 400 }}>{p.transition.outDuration.toFixed(2)}s</span>
          </label>
          <select value={p.transition.outType} onChange={(e) => setT({ outType: e.target.value as PopupTransition["outType"] })}>
            {OUT_ANIMS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
          <input type="range" min={0.05} max={1.5} step={0.05} value={p.transition.outDuration}
            onChange={(e) => setT({ outDuration: +e.target.value })} style={{ width: "100%", padding: 0, marginTop: 8, border: "none", background: "transparent" }} />
        </div>
      </div>
    </details>
  );
}

function NumIn({ value, onChange, step = 0.1 }: { value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <input type="number" value={value} step={step} onChange={(e) => onChange(+e.target.value)}
      style={{ width: 62, padding: "3px 8px", fontSize: 12, textAlign: "center" }} />
  );
}
