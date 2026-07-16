import { useRef, type ReactNode } from "react";

/**
 * Componentes visuais compartilhados do workspace — a linguagem "o visual explica":
 * Toggle (interruptor), SliderField (slider com valor vivo), UploadCard (área de
 * soltar arquivo), Pill (resultado numérico) e Card (container padrão).
 */

/** Interruptor pill com bolinha deslizante — estado óbvio sem texto. */
export function Toggle({ on, onChange, label }: { on: boolean; onChange: (b: boolean) => void; label?: string }) {
  return (
    <button onClick={() => onChange(!on)} aria-pressed={on}
      style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "transparent", border: "none", padding: 4, cursor: "pointer" }}>
      <span style={{
        width: 34, height: 20, borderRadius: 999, position: "relative", flexShrink: 0,
        background: on ? "#e8e8e8" : "var(--panel3)", border: "1px solid var(--border)",
        transition: "background 0.2s ease",
      }}>
        <span style={{
          position: "absolute", top: 2, left: on ? 15 : 2, width: 14, height: 14, borderRadius: "50%",
          background: on ? "#1a1a1a" : "#8f8f8f", transition: "left 0.2s ease, background 0.2s ease",
        }} />
      </span>
      {label && <span style={{ fontSize: 12.5, color: on ? "var(--text)" : "var(--muted)" }}>{label}</span>}
    </button>
  );
}

/** Slider com label + valor vivo (formato do sistema de formulário). */
export function SliderField({ label, value, display, min, max, step, onChange }: {
  label: string; value: number; display?: string;
  min: number; max: number; step: number; onChange: (v: number) => void;
}) {
  return (
    <div className="fo-field">
      <label style={{ display: "flex", justifyContent: "space-between" }}>
        <span>{label}</span>
        <span style={{ color: "var(--faint)", fontWeight: 400, fontVariantNumeric: "tabular-nums" }}>{display ?? value}</span>
      </label>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(+e.target.value)} style={{ width: "100%", padding: 0, border: "none", background: "transparent" }} />
    </div>
  );
}

/** Área de upload — card tracejado clicável (o visual convida a soltar o arquivo). */
export function UploadCard({ label, hint, accept, onPick, compact }: {
  label: string; hint?: string; accept: string; onPick: (f: File) => void; compact?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div onClick={() => ref.current?.click()} className="fo-card"
      style={{
        border: "1.5px dashed var(--field-border)", borderRadius: 16, cursor: "pointer",
        padding: compact ? "14px 16px" : "22px 16px", textAlign: "center", background: "var(--panel2)",
      }}>
      <input ref={ref} type="file" accept={accept} style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ""; }} />
      <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>{label}</div>
      {hint && <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

/** Pill de resultado — número em destaque, resto apagado. */
export function Pill({ children }: { children: ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "var(--panel2)", border: "1px solid var(--border)", borderRadius: 999, padding: "4px 16px", fontSize: 12.5, color: "var(--muted)" }}>
      {children}
    </span>
  );
}

/** Container padrão de conteúdo (card do sistema). */
export function Card({ children, dim, style }: { children: ReactNode; dim?: boolean; style?: React.CSSProperties }) {
  return (
    <div style={{ background: "var(--panel2)", border: "1px solid var(--border)", borderRadius: 16, padding: 16, opacity: dim ? 0.5 : 1, transition: "opacity 0.2s ease", ...style }}>
      {children}
    </div>
  );
}
