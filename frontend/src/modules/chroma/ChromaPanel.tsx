import { useState } from "react";
import { comBase } from "../../os-session";
import {
  DEFAULT_CHROMA, isChromaActive,
  type ChromaSettings, type ChromaBackground, type RGB255,
} from "../../../../shared/chroma";
import { Card, SliderField, Toggle, UploadCard } from "../../workspace/ui";

/**
 * Chromakey — visual-first: interruptor, cor-chave em swatches grandes,
 * sliders com valor vivo, fundo escolhido em cards. Undo/redo de graça.
 */
export function ChromaPanel({
  chroma, onChange,
  eyedropper, onToggleEyedropper,
  showMask, onToggleShowMask,
}: {
  chroma: ChromaSettings;
  onChange: (c: ChromaSettings) => void;
  eyedropper: boolean;
  onToggleEyedropper: (b: boolean) => void;
  showMask: boolean;
  onToggleShowMask: (b: boolean) => void;
}) {
  const set = (patch: Partial<ChromaSettings>) => onChange({ ...chroma, ...patch });
  const bg = chroma.background;
  const bgType = bg?.type ?? "none";
  const [fineOpen, setFineOpen] = useState(false);

  function setBgType(t: "none" | "color" | "image" | "video") {
    let next: ChromaBackground = null;
    if (t === "color") next = { type: "color", value: "#101010" };
    else if (t === "image") next = { type: "image", file: "" };
    else if (t === "video") next = { type: "video", file: "", loop: true };
    set({ background: next });
  }

  function pickFile(file: File, kind: "image" | "video") {
    const reader = new FileReader();
    reader.onload = () => {
      const file64 = reader.result as string;
      set({ background: kind === "image"
        ? { type: "image", file: file64 }
        : { type: "video", file: file64, loop: (bg?.type === "video" ? bg.loop : true) } });
    };
    reader.readAsDataURL(file);
  }

  const active = isChromaActive(chroma);
  const key = chroma.keyColor;
  const isGreen = key.g > 200 && key.r < 60 && key.b < 60;
  const isBlue = key.b > 200 && key.r < 60 && key.g < 60;

  /** swatch de cor-chave — quadrado grande, selecionado = anel */
  const Swatch = ({ css, on, onClick, title }: { css: string; on: boolean; onClick: () => void; title: string }) => (
    <button onClick={onClick} title={title} style={{
      width: 40, height: 40, padding: 0, borderRadius: 12, background: css,
      border: on ? "2px solid #fff" : "1px solid var(--border)",
      boxShadow: on ? "0 0 0 3px rgba(255,255,255,0.15)" : undefined,
    }} />
  );

  return (
    <section>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div className="fo-sec">
          <div className="t">Chromakey</div>
          <div className="s">Remove o fundo verde/azul e coloca outro no lugar.</div>
        </div>
        <Toggle on={chroma.enabled} onChange={(b) => set({ enabled: b })} label={active ? "ligado" : "desligado"} />
      </div>

      <Card dim={!chroma.enabled}>
        {/* COR-CHAVE — swatches grandes + conta-gotas */}
        <div className="fo-field" style={{ marginBottom: 16 }}>
          <label>Cor do fundo gravado</label>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <Swatch css="rgb(0,255,0)" on={isGreen} onClick={() => set({ keyColor: { r: 0, g: 255, b: 0 } })} title="verde" />
            <Swatch css="rgb(0,0,255)" on={isBlue} onClick={() => set({ keyColor: { r: 0, g: 0, b: 255 } })} title="azul" />
            <label title="cor personalizada" style={{ cursor: "pointer" }}>
              <input type="color" value={rgbHex(key)} onChange={(e) => set({ keyColor: hexRgb(e.target.value) })}
                style={{ width: 40, height: 40, borderRadius: 12, cursor: "pointer" }} />
            </label>
            <button onClick={() => onToggleEyedropper(!eyedropper)}
              className={eyedropper ? "fo-active" : undefined}
              style={{ fontSize: 12.5, borderRadius: 12 }}>
              {eyedropper ? "clique no vídeo…" : "pegar do vídeo"}
            </button>
            <span style={{ width: 20, height: 20, borderRadius: 8, border: "1px solid var(--border)", background: rgbCss(key) }} title="cor-chave atual" />
          </div>
        </div>

        {/* AJUSTE PRINCIPAL — só os 2 que resolvem 90% dos casos */}
        <div className="fo-row">
          <SliderField label="Tolerância" value={chroma.similarity} display={chroma.similarity.toFixed(2)}
            min={0} max={1} step={0.01} onChange={(v) => set({ similarity: v })} />
          <SliderField label="Suavidade da borda" value={chroma.smoothness} display={chroma.smoothness.toFixed(2)}
            min={0} max={1} step={0.01} onChange={(v) => set({ smoothness: v })} />
        </div>

        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
          <Toggle on={showMask} onChange={onToggleShowMask} label="ver máscara" />
          <button onClick={() => setFineOpen((v) => !v)} style={{ fontSize: 12, background: "transparent", color: "var(--muted)" }}>
            {fineOpen ? "▾ ajuste fino" : "▸ ajuste fino"}
          </button>
          <span style={{ flex: 1 }} />
          <button onClick={() => onChange(DEFAULT_CHROMA)} style={{ fontSize: 12, color: "var(--faint)", background: "transparent" }}>
            resetar
          </button>
        </div>

        {fineOpen && (
          <div className="fo-row" style={{ marginTop: 12 }}>
            <SliderField label="Despill (tirar reflexo)" value={chroma.despill} display={chroma.despill.toFixed(2)}
              min={0} max={1} step={0.01} onChange={(v) => set({ despill: v })} />
            <SliderField label="Preencher sujeito" value={chroma.fgClip ?? 1} display={(chroma.fgClip ?? 1).toFixed(2)}
              min={0.05} max={1} step={0.01} onChange={(v) => set({ fgClip: v })} />
            <SliderField label="Limpar fundo" value={chroma.bgClip ?? 0} display={(chroma.bgClip ?? 0).toFixed(2)}
              min={0} max={0.95} step={0.01} onChange={(v) => set({ bgClip: v })} />
          </div>
        )}

        <hr className="fo-divider" style={{ margin: "16px 0" }} />

        {/* NOVO FUNDO — escolha em cards */}
        <div className="fo-field">
          <label>Novo fundo</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {([["none", "Nenhum"], ["color", "Cor"], ["image", "Imagem"], ["video", "Vídeo"]] as const).map(([t, nome]) => (
              <button key={t} onClick={() => setBgType(t)} className={bgType === t ? "fo-active" : undefined}
                style={{ fontSize: 12.5, borderRadius: 12, padding: "8px 20px" }}>
                {nome}
              </button>
            ))}
            {bg?.type === "color" && (
              <input type="color" value={bg.value}
                onChange={(e) => set({ background: { type: "color", value: e.target.value } })}
                style={{ width: 38, height: 36, borderRadius: 12, cursor: "pointer" }} />
            )}
          </div>
        </div>

        {bg?.type === "image" && (
          <div style={{ marginTop: 12 }}>
            {bg.file
              ? <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <img src={comBase(bg.file)} alt="" style={{ height: 54, borderRadius: 12, border: "1px solid var(--border)" }} />
                  <UploadCard compact label="Trocar imagem" accept="image/*" onPick={(f) => pickFile(f, "image")} />
                </div>
              : <UploadCard compact label="Escolher imagem de fundo" accept="image/*" onPick={(f) => pickFile(f, "image")} />}
          </div>
        )}
        {bg?.type === "video" && (
          <div style={{ marginTop: 12, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <UploadCard compact label={bg.file ? "Trocar vídeo de fundo" : "Escolher vídeo de fundo"}
                hint={bg.file ? "vídeo carregado ✓" : undefined} accept="video/*" onPick={(f) => pickFile(f, "video")} />
            </div>
            <Toggle on={bg.loop} onChange={(b) => set({ background: { ...bg, loop: b } })} label="loop" />
          </div>
        )}
        {(bg?.type === "image" || bg?.type === "video") && (
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            {([["cover", "Preencher"], ["contain", "Caber inteiro"]] as const).map(([v, nome]) => (
              <button key={v} onClick={() => set({ fit: v })} className={(chroma.fit ?? "cover") === v ? "fo-active" : undefined}
                style={{ fontSize: 12, borderRadius: 12 }}>
                {nome}
              </button>
            ))}
          </div>
        )}
      </Card>
    </section>
  );
}

// ── helpers cor ──
const h2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
const rgbHex = (c: RGB255) => `#${h2(c.r)}${h2(c.g)}${h2(c.b)}`;
const rgbCss = (c: RGB255) => `rgb(${c.r},${c.g},${c.b})`;
function hexRgb(hex: string): RGB255 {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
