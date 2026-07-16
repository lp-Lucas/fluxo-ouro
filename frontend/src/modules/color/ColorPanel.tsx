import { useRef, useState } from "react";
import {
  DEFAULT_COLOR, BUILTIN_COLOR_PRESETS, loadColorPresets, saveColorPresets,
  type ColorSettings, type ColorPreset,
} from "../../../../shared/color";
import { Card, SliderField, Toggle, UploadCard } from "../../workspace/ui";

/**
 * Cor — visual-first: interruptor liga/desliga, presets como chips (1 clique =
 * 1 look), sliders com valor vivo, LUT como card de upload. Undo/redo de graça.
 */
export function ColorPanel({
  color,
  onChange,
  enabled,
  onToggleEnabled,
  onPickLut,
  onClearLut,
  lutName,
  lutError,
  onApplyPreset,
  makePreset,
}: {
  color: ColorSettings;
  onChange: (c: ColorSettings) => void;
  enabled: boolean;
  onToggleEnabled: (b: boolean) => void;
  onPickLut: (file: File) => void;
  onClearLut: () => void;
  lutName: string | null;
  lutError: string | null;
  onApplyPreset: (p: ColorPreset) => void;
  makePreset: (name: string) => ColorPreset;
}) {
  const [userPresets, setUserPresets] = useState<ColorPreset[]>(loadColorPresets);
  const [presetName, setPresetName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const b = color.basic;
  const setBasic = (patch: Partial<ColorSettings["basic"]>) =>
    onChange({ ...color, basic: { ...color.basic, ...patch } });
  const setIntensity = (v: number) =>
    onChange({ ...color, lut: { file: color.lut?.file ?? null, intensity: v } });

  return (
    <section>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div className="fo-sec">
          <div className="t">Cor</div>
          <div className="s">Looks prontos em um clique — ou ajuste fino nos sliders. Tudo ao vivo no preview.</div>
        </div>
        <Toggle on={enabled} onChange={onToggleEnabled} label={enabled ? "ligada" : "desligada"} />
      </div>

      {/* PRESETS primeiro: 1 clique = 1 look (o caminho rápido) */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        {BUILTIN_COLOR_PRESETS.map((p) => (
          <button key={p.name} onClick={() => onApplyPreset(p)} style={{ fontSize: 12.5 }}>{p.name}</button>
        ))}
        {userPresets.map((p) => (
          <span key={p.name} style={{ display: "inline-flex", alignItems: "center" }}>
            <button onClick={() => onApplyPreset(p)} style={{ fontSize: 12.5, borderRadius: "12px 0 0 12px" }}>{p.name}</button>
            <button title="apagar este preset" style={{ fontSize: 12, borderRadius: "0 12px 12px 0", padding: "8px 8px", color: "var(--faint)" }}
              onClick={() => { const next = userPresets.filter((x) => x.name !== p.name); setUserPresets(next); saveColorPresets(next); }}>×</button>
          </span>
        ))}
      </div>

      <Card dim={!enabled}>
        <div className="fo-row">
          <SliderField label="Brilho" value={b.brightness} display={b.brightness.toFixed(2)}
            min={-1} max={1} step={0.01} onChange={(v) => setBasic({ brightness: v })} />
          <SliderField label="Contraste" value={b.contrast} display={b.contrast.toFixed(2)}
            min={0} max={2} step={0.01} onChange={(v) => setBasic({ contrast: v })} />
          <SliderField label="Saturação" value={b.saturation} display={b.saturation.toFixed(2)}
            min={0} max={2} step={0.01} onChange={(v) => setBasic({ saturation: v })} />
          <SliderField label="Gamma" value={b.gamma} display={b.gamma.toFixed(2)}
            min={0.5} max={2} step={0.01} onChange={(v) => setBasic({ gamma: v })} />
        </div>

        {/* LUT */}
        {!lutName ? (
          <UploadCard compact label="Adicionar LUT (.cube)" hint="o look profissional de um clique" accept=".cube"
            onPick={onPickLut} />
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12.5, color: "var(--green)" }}>{lutName}</span>
            <div style={{ flex: 1, minWidth: 180 }}>
              <SliderField label="Intensidade do LUT" value={color.lut?.intensity ?? 0}
                display={`${Math.round((color.lut?.intensity ?? 0) * 100)}%`}
                min={0} max={1} step={0.01} onChange={setIntensity} />
            </div>
            <button onClick={() => { onClearLut(); if (fileRef.current) fileRef.current.value = ""; }}
              style={{ fontSize: 12, color: "var(--red)", background: "transparent" }}>
              remover
            </button>
          </div>
        )}
        {lutError && <p style={{ color: "var(--red)", fontSize: 12, margin: "8px 0 0" }}>{lutError}</p>}

        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
          <input value={presetName} placeholder="Nome do look…" onChange={(e) => setPresetName(e.target.value)}
            style={{ width: 180 }} />
          <button disabled={!presetName.trim()} onClick={() => {
            const next = [...userPresets.filter((x) => x.name !== presetName.trim()), makePreset(presetName.trim())];
            setUserPresets(next); saveColorPresets(next); setPresetName("");
          }} style={{ fontSize: 12.5 }}>
            Salvar look atual
          </button>
          <span style={{ flex: 1 }} />
          <button onClick={() => { onChange(DEFAULT_COLOR); onClearLut(); if (fileRef.current) fileRef.current.value = ""; }}
            style={{ fontSize: 12, color: "var(--faint)", background: "transparent" }}>
            resetar
          </button>
        </div>
      </Card>
    </section>
  );
}
