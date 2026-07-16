import { useState } from "react";
import {
  BUILTIN_PRESETS,
  VIRAL_FONTS,
  loadUserPresets,
  saveUserPresets,
  type CaptionStyle,
  type SavedPreset,
} from "../../../../shared/captionStyle";

/** Painel de edição do estilo da legenda, com abas Estilo e Presets. */
export function CaptionControls({
  style,
  onChange,
  hideCaptionOnly = false,
}: {
  style: CaptionStyle;
  onChange: (next: CaptionStyle) => void;
  /** Esconde controles que só fazem sentido para legenda (modo, posição, palavras/linha, tamanho). */
  hideCaptionOnly?: boolean;
}) {
  const [tab, setTab] = useState<"estilo" | "presets">("estilo");

  const set = <K extends keyof CaptionStyle>(key: K, value: CaptionStyle[K]) =>
    onChange({ ...style, [key]: value });
  const setShadow = <K extends keyof CaptionStyle["shadow"]>(
    key: K,
    value: CaptionStyle["shadow"][K],
  ) => onChange({ ...style, shadow: { ...style.shadow, [key]: value } });
  const setOutline = <K extends keyof CaptionStyle["outline"]>(
    key: K,
    value: CaptionStyle["outline"][K],
  ) => onChange({ ...style, outline: { ...style.outline, [key]: value } });
  const setWordBg = <K extends keyof CaptionStyle["wordBg"]>(
    key: K,
    value: CaptionStyle["wordBg"][K],
  ) => onChange({ ...style, wordBg: { ...style.wordBg, [key]: value } });
  const setHighlight = <K extends keyof CaptionStyle["highlight"]>(
    key: K,
    value: CaptionStyle["highlight"][K],
  ) => onChange({ ...style, highlight: { ...style.highlight, [key]: value } });
  const setEntrance = <K extends keyof CaptionStyle["entrance"]>(
    key: K,
    value: CaptionStyle["entrance"][K],
  ) => onChange({ ...style, entrance: { ...style.entrance, [key]: value } });
  const setLoop = <K extends keyof CaptionStyle["loop"]>(
    key: K,
    value: CaptionStyle["loop"][K],
  ) => onChange({ ...style, loop: { ...style.loop, [key]: value } });

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <TabBtn active={tab === "estilo"} onClick={() => setTab("estilo")}>
          Estilo
        </TabBtn>
        <TabBtn active={tab === "presets"} onClick={() => setTab("presets")}>
          Presets
        </TabBtn>
      </div>

      {tab === "estilo" ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
          {!hideCaptionOnly && (
            <Field label="Modo">
              <select value={style.mode} onChange={(e) => set("mode", e.target.value as CaptionStyle["mode"])}>
                <option value="karaoke">Karaokê (pinta a palavra)</option>
                <option value="static">Estático (linha inteira)</option>
                <option value="highlight">Destaque (caixa de fundo)</option>
              </select>
            </Field>
          )}

          <Field label="Fonte (virais)">
            <select value={style.fontFamily} onChange={(e) => set("fontFamily", e.target.value)}>
              {VIRAL_FONTS.map((f) => (
                <option key={f.value} value={f.value} style={{ fontFamily: f.value }}>
                  {f.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Animação de entrada">
            <select value={style.entrance.type}
              onChange={(e) => setEntrance("type", e.target.value as CaptionStyle["entrance"]["type"])}>
              <option value="none">Nenhuma</option>
              <option value="fade">Fade-in</option>
              <option value="pop">Pop</option>
              <option value="slide-up-blur">Baixo→cima + desfoque</option>
              <option value="bounce">Bounce (pulo)</option>
              <option value="zoom-blur">Zoom + desfoque</option>
              <option value="typewriter">Typewriter (palavra a palavra)</option>
            </select>
          </Field>

          {style.entrance.type !== "none" && (
            <Field label={`Duração da entrada: ${style.entrance.duration.toFixed(2)}s`}>
              <input type="range" min={0.05} max={1} step={0.05} value={style.entrance.duration}
                onChange={(e) => setEntrance("duration", +e.target.value)} />
            </Field>
          )}

          <Field label="Animação em loop">
            <select value={style.loop.type}
              onChange={(e) => setLoop("type", e.target.value as CaptionStyle["loop"]["type"])}>
              <option value="none">Nenhuma</option>
              <option value="float">Flutuar (suave)</option>
              <option value="turbulence">Turbulência (wiggle AE)</option>
              <option value="pulse">Pulsar</option>
              <option value="wobble">Balançar (rotação)</option>
              <option value="glow">Brilho (glow)</option>
            </select>
          </Field>

          {style.loop.type !== "none" && (
            <>
              <Field label={`Intensidade: ${Math.round(style.loop.intensity * 100)}%`}>
                <input type="range" min={0} max={1} step={0.05} value={style.loop.intensity}
                  onChange={(e) => setLoop("intensity", +e.target.value)} />
              </Field>
              <Field label={`Velocidade: ${style.loop.speed.toFixed(1)}x`}>
                <input type="range" min={0.2} max={3} step={0.1} value={style.loop.speed}
                  onChange={(e) => setLoop("speed", +e.target.value)} />
              </Field>
            </>
          )}

          {!hideCaptionOnly && (
            <Field label={`Tamanho: ${style.fontSize}px`}>
              <input type="range" min={12} max={72} value={style.fontSize}
                onChange={(e) => set("fontSize", +e.target.value)} />
            </Field>
          )}

          <Field label={`Peso: ${style.fontWeight}`}>
            <input type="range" min={300} max={900} step={100} value={style.fontWeight}
              onChange={(e) => set("fontWeight", +e.target.value)} />
          </Field>

          <Field label={`Espaçamento entre letras: ${style.letterSpacing}px`}>
            <input type="range" min={-5} max={20} step={0.5} value={style.letterSpacing}
              onChange={(e) => set("letterSpacing", +e.target.value)} />
          </Field>

          <Field label={`Espaçamento entre palavras: ${style.wordSpacing}px`}>
            <input type="range" min={-20} max={40} value={style.wordSpacing}
              onChange={(e) => set("wordSpacing", +e.target.value)} />
          </Field>

          {!hideCaptionOnly && (
            <Field label={`Palavras por linha: ${style.maxWords}`}>
              <input type="range" min={1} max={12} value={style.maxWords}
                onChange={(e) => set("maxWords", +e.target.value)} />
            </Field>
          )}

          {!hideCaptionOnly && (
            <Field label={`Posição horizontal: ${style.posX}%`}>
              <input type="range" min={0} max={100} value={style.posX}
                onChange={(e) => set("posX", +e.target.value)} />
            </Field>
          )}

          {!hideCaptionOnly && (
            <Field label={`Posição vertical: ${style.posY}%`}>
              <input type="range" min={0} max={100} value={style.posY}
                onChange={(e) => set("posY", +e.target.value)} />
            </Field>
          )}

          <Field label={`Opacidade: ${Math.round(style.opacity * 100)}%`}>
            <input type="range" min={0} max={1} step={0.05} value={style.opacity}
              onChange={(e) => set("opacity", +e.target.value)} />
          </Field>

          {style.mode === "karaoke" && !hideCaptionOnly ? (
            <>
              <Field label="Cor palavra ativa">
                <input type="color" value={style.colorActive} onChange={(e) => set("colorActive", e.target.value)} />
              </Field>
              <Field label="Cor já falada">
                <input type="color" value={hex(style.colorSpoken)} onChange={(e) => set("colorSpoken", e.target.value)} />
              </Field>
              <Field label="Cor a falar">
                <input type="color" value={hex(style.colorUpcoming)} onChange={(e) => set("colorUpcoming", e.target.value)} />
              </Field>
            </>
          ) : (
            <Field label="Cor do texto">
              <input type="color" value={hex(style.colorSpoken)} onChange={(e) => set("colorSpoken", e.target.value)} />
            </Field>
          )}

          <Field label="Sombra">
            <label style={{ fontSize: 13 }}>
              <input type="checkbox" checked={style.shadow.enabled}
                onChange={(e) => setShadow("enabled", e.target.checked)} /> ativar
            </label>
          </Field>
          {style.shadow.enabled && (
            <>
              <Field label="Cor da sombra">
                <input type="color" value={style.shadow.color} onChange={(e) => setShadow("color", e.target.value)} />
              </Field>
              <Field label={`Intensidade: ${style.shadow.intensity}px`}>
                <input type="range" min={0} max={30} value={style.shadow.intensity}
                  onChange={(e) => setShadow("intensity", +e.target.value)} />
              </Field>
              <Field label={`Opacidade da sombra: ${Math.round(style.shadow.opacity * 100)}%`}>
                <input type="range" min={0} max={1} step={0.05} value={style.shadow.opacity}
                  onChange={(e) => setShadow("opacity", +e.target.value)} />
              </Field>
            </>
          )}

          {/* Contorno */}
          <Field label="Contorno">
            <label style={{ fontSize: 13 }}>
              <input type="checkbox" checked={style.outline.enabled}
                onChange={(e) => setOutline("enabled", e.target.checked)} /> ativar
            </label>
          </Field>
          {style.outline.enabled && (
            <>
              <Field label="Cor do contorno">
                <input type="color" value={style.outline.color} onChange={(e) => setOutline("color", e.target.value)} />
              </Field>
              <Field label={`Espessura: ${style.outline.width}px`}>
                <input type="range" min={0.5} max={8} step={0.5} value={style.outline.width}
                  onChange={(e) => setOutline("width", +e.target.value)} />
              </Field>
            </>
          )}

          {/* Fundo por palavra */}
          <Field label="Fundo por palavra">
            <label style={{ fontSize: 13 }}>
              <input type="checkbox" checked={style.wordBg.enabled}
                onChange={(e) => setWordBg("enabled", e.target.checked)} /> ativar
            </label>
          </Field>
          {style.wordBg.enabled && (
            <>
              <Field label="Cor do fundo">
                <input type="color" value={style.wordBg.color} onChange={(e) => setWordBg("color", e.target.value)} />
              </Field>
              <Field label={`Opacidade: ${Math.round(style.wordBg.opacity * 100)}%`}>
                <input type="range" min={0} max={1} step={0.05} value={style.wordBg.opacity}
                  onChange={(e) => setWordBg("opacity", +e.target.value)} />
              </Field>
              <Field label={`Largura (padding X): ${style.wordBg.paddingX}px`}>
                <input type="range" min={0} max={30} value={style.wordBg.paddingX}
                  onChange={(e) => setWordBg("paddingX", +e.target.value)} />
              </Field>
              <Field label={`Altura (padding Y): ${style.wordBg.paddingY}px`}>
                <input type="range" min={0} max={20} value={style.wordBg.paddingY}
                  onChange={(e) => setWordBg("paddingY", +e.target.value)} />
              </Field>
              <Field label={`Arredondamento: ${style.wordBg.radius}px`}>
                <input type="range" min={0} max={30} value={style.wordBg.radius}
                  onChange={(e) => setWordBg("radius", +e.target.value)} />
              </Field>
            </>
          )}

          {/* Caixa de destaque (modo highlight) */}
          {style.mode === "highlight" && (
            <>
              <Field label="Cor da caixa de destaque">
                <input type="color" value={style.highlight.color} onChange={(e) => setHighlight("color", e.target.value)} />
              </Field>
              <Field label={`Opacidade da caixa: ${Math.round(style.highlight.opacity * 100)}%`}>
                <input type="range" min={0} max={1} step={0.05} value={style.highlight.opacity}
                  onChange={(e) => setHighlight("opacity", +e.target.value)} />
              </Field>
              <Field label={`Largura da caixa: ${style.highlight.paddingX}px`}>
                <input type="range" min={0} max={30} value={style.highlight.paddingX}
                  onChange={(e) => setHighlight("paddingX", +e.target.value)} />
              </Field>
              <Field label={`Altura da caixa: ${style.highlight.paddingY}px`}>
                <input type="range" min={0} max={20} value={style.highlight.paddingY}
                  onChange={(e) => setHighlight("paddingY", +e.target.value)} />
              </Field>
              <Field label={`Arredondamento da caixa: ${style.highlight.radius}px`}>
                <input type="range" min={0} max={30} value={style.highlight.radius}
                  onChange={(e) => setHighlight("radius", +e.target.value)} />
              </Field>
            </>
          )}
        </div>
      ) : (
        <PresetsTab style={style} onApply={onChange} />
      )}
    </div>
  );
}

function PresetsTab({
  style,
  onApply,
}: {
  style: CaptionStyle;
  onApply: (s: CaptionStyle) => void;
}) {
  const [user, setUser] = useState<SavedPreset[]>(loadUserPresets);
  const [name, setName] = useState("");

  function save() {
    if (!name.trim()) return;
    const next = [...user.filter((p) => p.name !== name.trim()), { name: name.trim(), style }];
    setUser(next);
    saveUserPresets(next);
    setName("");
  }
  function remove(n: string) {
    const next = user.filter((p) => p.name !== n);
    setUser(next);
    saveUserPresets(next);
  }

  return (
    <div>
      <p style={{ fontSize: 13, color: "var(--muted)", marginTop: 0 }}>Presets prontos</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {BUILTIN_PRESETS.map((p) => (
          <button key={p.name} onClick={() => onApply(p.style)}>{p.name}</button>
        ))}
      </div>

      <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 4 }}>Meus presets</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        {user.length === 0 && <span style={{ color: "var(--faint)", fontSize: 13 }}>nenhum salvo ainda</span>}
        {user.map((p) => (
          <span key={p.name} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <button onClick={() => onApply(p.style)}>{p.name}</button>
            <button onClick={() => remove(p.name)} title="apagar" style={{ color: "var(--red)" }}>×</button>
          </span>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <input value={name} placeholder="nome do preset" onChange={(e) => setName(e.target.value)} />
        <button onClick={save} disabled={!name.trim()}>Salvar estilo atual</button>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ fontWeight: active ? 700 : 400, borderBottom: active ? "2px solid #1a7f37" : "2px solid transparent" }}>
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 13, color: "var(--muted)" }}>
      {label}
      {children}
    </label>
  );
}

/** Garante #rrggbb para o input color (descarta alpha tipo #ffffff80). */
function hex(c: string): string {
  return c.length >= 7 ? c.slice(0, 7) : c;
}
