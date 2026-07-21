import { useState } from "react";
import type { TranscriptSegment, Word, Cut } from "../../../../shared/timeline";
import { correctWithCopy } from "./align";
import { detectCutsFromCopy } from "../editor/autocut";

/**
 * Etapa 3: Correção.
 * Mostra a transcrição com timestamps POR PALAVRA e permite:
 *  - corrigir o texto manualmente (mantendo timestamps);
 *  - auto-corrigir com a copy/roteiro;
 *  - selecionar palavras direto no texto para marcá-las como corte (AUTOCUT).
 */
export function TranscriptEditor({
  transcript,
  onChange,
  copy,
  onCopyChange,
  onAddCuts,
  onApplyCopyCuts,
  onAddPopup,
  onAddFlowMoment,
}: {
  transcript: TranscriptSegment[];
  onChange: (next: TranscriptSegment[]) => void;
  copy: string;
  onCopyChange: (copy: string) => void;
  onAddCuts: (cuts: Cut[]) => void;
  onApplyCopyCuts: (cuts: Cut[]) => void; // substitui os cortes da copy (fora do roteiro)
  onAddPopup: (word: Word) => void;
  /** MOTION manual: seleciona palavras → vira um momento do FLOW (índices GLOBAIS de palavra). */
  onAddFlowMoment?: (wordStart: number, wordEnd: number) => void;
}) {
  const [showTimes, setShowTimes] = useState(true);
  const [cutOutside, setCutOutside] = useState(true); // cortar o falado fora da copy
  const [copyOpen, setCopyOpen] = useState(() => copy.trim().length === 0); // sem copy = aberta
  const [scriptOpen, setScriptOpen] = useState(false); // popup "corrigir pelo script"
  const [scriptDraft, setScriptDraft] = useState("");

  /**
   * Auto-corrigir com a copy: troca palavras erradas e (opcional) corta o que está fora.
   * (A checagem de SINCRONIA de tempo fica no "conferir legendas" da Etapa 2 — aqui
   * não, porque este botão aplica cortes automáticos.)
   */
  function autoCorrigir(texto?: string) {
    const roteiro = texto ?? copy;
    // detecta os cortes ANTES de corrigir (a correção remove as palavras fora da copy);
    // só substitui se achou algo, pra não zerar cortes ao reclicar já corrigido.
    const r = detectCutsFromCopy(transcript, roteiro);
    if (r.refused) {
      alert(
        `⚠️ Auto-correção RECUSADA: só ${r.matchedWords} de ${r.totalWords} palavras da fala batem com a copy colada.\n\n` +
        `Essa copy não parece ser o roteiro deste vídeo — corrigir/cortar agora destruiria a transcrição e cortaria o vídeo inteiro.\n\n` +
        `Confira o texto da copy e tente de novo.`,
      );
      return;
    }
    if (cutOutside && r.cuts.length > 0) onApplyCopyCuts(r.cuts);
    onChange(correctWithCopy(transcript, roteiro));
  }

  /** Popup "corrigir pelo script": cola o roteiro, corrige e salva como copy do projeto. */
  function corrigirPeloScript() {
    if (!scriptDraft.trim()) return;
    onCopyChange(scriptDraft);
    autoCorrigir(scriptDraft);
    setScriptOpen(false);
  }
  const [timeEdit, setTimeEdit] = useState(false);
  const [mode, setMode] = useState<"none" | "cut" | "merge" | "popup" | "motion">("none");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const setModeSafe = (m: "none" | "cut" | "merge" | "popup" | "motion") => { setMode(m); setSelected(new Set()); };

  /**
   * Edita uma palavra. Se o texto tiver espaços, DIVIDE em várias palavras — e RECALCULA
   * o timing usando a JANELA REAL disponível: do início da original até o COMEÇO DA
   * PRÓXIMA palavra (absorvendo a pausa que existia depois). Antes, as novas palavras
   * eram espremidas só no intervalo da original (0,2-0,4s) — e se a original tinha
   * duração ~zero, todas nasciam NO MESMO tempo (o bug da legenda). Piso de 50ms por
   * palavra: nunca nasce palavra degenerada. A última palavra do segmento pode esticar
   * (~0,3s/palavra) — não há próxima pra desincronizar.
   */
  function editWord(segId: string, wordIdx: number, text: string) {
    const tokens = text.split(/\s+/).filter(Boolean);
    onChange(
      transcript.map((seg) => {
        if (seg.id !== segId) return seg;
        const orig = seg.words[wordIdx];
        let replacement: Word[];
        if (tokens.length <= 1) {
          replacement = [{ ...orig, text }];
        } else {
          const start = orig.start;
          const next = seg.words[wordIdx + 1];
          const windowEnd = next
            ? Math.max(orig.end, next.start)                    // absorve a pausa até a próxima
            : Math.max(orig.end, start + 0.3 * tokens.length);  // fim do segmento: pode esticar
          const span = Math.max(windowEnd - start, 0.05 * tokens.length);
          const totalChars = tokens.reduce((n, t) => n + t.length, 0) || 1;
          let t = start;
          replacement = tokens.map((tok, i) => {
            const last = i === tokens.length - 1;
            const dur = Math.max((span * tok.length) / totalChars, 0.05);
            const end = last ? Math.max(start + span, t + 0.05) : t + dur;
            // A 1ª palavra herda o id da original (a legenda sincroniza o texto por id); as
            // demais são novas (sem id — a divisão em si não flui p/ legenda materializada).
            const word: Word = i === 0
              ? { ...orig, text: tok, start: +t.toFixed(3), end: +end.toFixed(3) }
              : { text: tok, start: +t.toFixed(3), end: +end.toFixed(3) };
            t = word.end;
            return word;
          });
        }
        const words = [...seg.words.slice(0, wordIdx), ...replacement, ...seg.words.slice(wordIdx + 1)];
        return {
          ...seg,
          words,
          text: words.map((w) => w.text).join(" ").replace(/\s+/g, " ").trim(),
          source: "corrected" as const,
        };
      }),
    );
  }

  function setWordTime(segId: string, wordIdx: number, patch: Partial<Pick<Word, "start" | "end">>) {
    onChange(
      transcript.map((seg) => {
        if (seg.id !== segId) return seg;
        const words = seg.words.map((w, i) => (i === wordIdx ? { ...w, ...patch } : w));
        return { ...seg, words, source: "corrected" as const };
      }),
    );
  }

  function deleteWord(segId: string, wordIdx: number) {
    onChange(
      transcript.map((seg) => {
        if (seg.id !== segId) return seg;
        const words = seg.words.filter((_, i) => i !== wordIdx);
        return {
          ...seg,
          words,
          text: words.map((w) => w.text).join(" ").replace(/\s+/g, " ").trim(),
          source: "corrected" as const,
        };
      }),
    );
  }

  function toggleSelect(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  /** Constrói cortes das palavras selecionadas, mesclando as vizinhas em tempo. */
  function cutSelected() {
    const chosen: Word[] = [];
    transcript.forEach((seg) =>
      seg.words.forEach((w, i) => selected.has(`${seg.id}:${i}`) && chosen.push(w)),
    );
    chosen.sort((a, b) => a.start - b.start);

    const cuts: Cut[] = [];
    let n = 0;
    for (const w of chosen) {
      const last = cuts[cuts.length - 1];
      if (last && w.start - last.end <= 0.35) {
        last.end = +w.end.toFixed(3); // funde com o corte anterior
      } else {
        cuts.push({ id: `cut-man-${Date.now()}-${n++}`, start: +w.start.toFixed(3), end: +w.end.toFixed(3), reason: "manual", enabled: true });
      }
    }
    onAddCuts(cuts);
    setModeSafe("none");
  }

  /**
   * MOTION manual (igual ao popup): as palavras selecionadas viram UM momento do FLOW.
   * O trecho é o SPAN da seleção (da 1ª à última palavra, em índice GLOBAL) — tudo no
   * meio entra junto, porque a frase de motion é contígua por definição.
   */
  function motionSelected() {
    if (!onAddFlowMoment) return;
    let gi = 0; const globals: number[] = [];
    transcript.forEach((seg) =>
      seg.words.forEach((_, i) => { if (selected.has(`${seg.id}:${i}`)) globals.push(gi); gi++; }),
    );
    if (globals.length === 0) return;
    onAddFlowMoment(Math.min(...globals), Math.max(...globals));
    setModeSafe("none");
  }

  /** Junta palavras selecionadas (runs contíguos) numa só, por segmento. */
  function mergeSelected() {
    onChange(
      transcript.map((seg) => {
        const idxs = seg.words.map((_, i) => i).filter((i) => selected.has(`${seg.id}:${i}`));
        if (idxs.length < 2) return seg;

        const words = [...seg.words];
        // processa de trás pra frente pra não bagunçar os índices
        let run: number[] = [];
        const runs: number[][] = [];
        for (const i of idxs) {
          if (run.length && i === run[run.length - 1] + 1) run.push(i);
          else { if (run.length) runs.push(run); run = [i]; }
        }
        if (run.length) runs.push(run);

        for (const r of runs.reverse()) {
          if (r.length < 2) continue;
          const first = words[r[0]];
          const last = words[r[r.length - 1]];
          const merged: Word = {
            text: r.map((i) => words[i].text).join(" "),
            start: first.start,
            end: last.end,
          };
          words.splice(r[0], r.length, merged);
        }

        return {
          ...seg,
          words,
          text: words.map((w) => w.text).join(" ").replace(/\s+/g, " ").trim(),
          source: "corrected" as const,
        };
      }),
    );
    setModeSafe("none");
  }

  if (transcript.length === 0) return null;

  const nPalavras = copy.trim() ? copy.trim().split(/\s+/).length : 0;
  const hintColor = timeEdit ? "var(--purple)" : mode === "cut" ? "var(--red)" : mode === "merge" ? "var(--accent-text)" : mode === "popup" ? "var(--green)" : mode === "motion" ? "var(--purple)" : "var(--faint)";
  const hint = timeEdit ? "edite início/fim (s) de cada palavra"
    : mode === "cut" ? "clique nas palavras — elas viram cortes na timeline"
    : mode === "merge" ? 'clique nas vizinhas que formam uma só ("chat do GPT")'
    : mode === "popup" ? "clique numa palavra pra criar um popup ali"
    : mode === "motion" ? "selecione o trecho (1ª e última palavra bastam) — ele vira um momento de motion"
    : "clique pra editar · espaço divide · apagar remove";

  return (
    <section style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <style>{`
        .tr-seg { display: grid; grid-template-columns: 46px 1fr; gap: 12px; padding: 8px; border-radius: 12px; transition: background 0.15s ease; }
        .tr-seg:hover { background: rgba(255, 255, 255, 0.03); }
        .tr-time { font-size: 11px; color: var(--faint); text-align: right; padding-top: 8px; font-variant-numeric: tabular-nums; user-select: none; }
        .tr-w { transition: background 0.12s ease; }
        .tr-w:hover { background: var(--panel3) !important; }
      `}</style>

      {/* COPY — barra compacta; expande só quando precisa mexer */}
      <div style={{ background: "var(--panel2)", border: "1px solid var(--border)", borderRadius: 16, padding: copyOpen ? "16px" : "8px 12px", marginBottom: 12, flexShrink: 0 }}>
        {!copyOpen ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Copy</span>
            <span style={{ fontSize: 11.5, color: nPalavras ? "var(--green)" : "var(--faint)" }}>
              {nPalavras ? `${nPalavras} palavras ✓` : "vazia"}
            </span>
            <button onClick={() => { setScriptDraft(copy); setScriptOpen(true); }}
              style={{ fontSize: 12, background: "var(--panel3)", color: "var(--text)", padding: "4px 16px" }}>
              Corrigir pelo script
            </button>
            <button disabled={!nPalavras} onClick={() => autoCorrigir()}
              style={{ fontSize: 12, background: "var(--accent)", color: "#1a1a1a", fontWeight: 600, padding: "4px 16px" }}>
              Auto-corrigir
            </button>
            <button onClick={() => setCopyOpen(true)} style={{ fontSize: 12, background: "transparent", color: "var(--muted)" }}>
              editar
            </button>
          </div>
        ) : (
          <>
            <div className="fo-sec" style={{ marginBottom: 12 }}>
              <div className="t" style={{ fontSize: 13.5 }}>Copy / roteiro do vídeo</div>
              <div className="s">Corrige a transcrição, guia os cortes e o FLOW.</div>
            </div>
            <textarea
              value={copy}
              onChange={(e) => onCopyChange(e.target.value)}
              placeholder="Cole aqui a copy / roteiro do vídeo…"
              rows={4}
              style={{ width: "100%", fontSize: 13, boxSizing: "border-box" }}
            />
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
              <button disabled={!nPalavras} onClick={() => autoCorrigir()}
                style={{ background: "var(--accent)", color: "#1a1a1a", fontWeight: 600 }}>
                Auto-corrigir com a copy
              </button>
              <button onClick={() => { setScriptDraft(copy); setScriptOpen(true); }}
                style={{ fontSize: 12.5, background: "var(--panel3)", color: "var(--text)" }}>
                Corrigir pelo script
              </button>
              <label style={{ fontSize: 12.5, color: cutOutside ? "var(--red)" : "var(--muted)" }}>
                <input type="checkbox" checked={cutOutside} onChange={(e) => setCutOutside(e.target.checked)} />{" "}
                cortar o que saiu da copy
              </label>
              <span style={{ flex: 1 }} />
              <button onClick={() => setCopyOpen(false)} style={{ fontSize: 12, background: "transparent", color: "var(--muted)" }}>
                recolher
              </button>
            </div>
          </>
        )}
      </div>

      {/* FERRAMENTA — segmented + ação contextual + dica viva na MESMA linha */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12, flexShrink: 0 }}>
        <div style={{ display: "inline-flex", background: "var(--panel2)", border: "1px solid var(--border)", borderRadius: 12, padding: 3, gap: 2 }}>
          {([
            { id: "edit", label: "editar" },
            { id: "time", label: "tempo" },
            { id: "cut", label: "cortar" },
            { id: "merge", label: "juntar" },
            { id: "popup", label: "popup" },
            { id: "motion", label: "motion" },
          ] as const).map((t) => {
            const active = t.id === "time" ? timeEdit : !timeEdit && (t.id === "edit" ? mode === "none" : mode === t.id);
            return (
              <button key={t.id}
                onClick={() => {
                  if (t.id === "time") { setTimeEdit(true); setModeSafe("none"); }
                  else { setTimeEdit(false); setModeSafe(t.id === "edit" ? "none" : t.id); }
                }}
                style={{
                  border: "none", borderRadius: 8, padding: "4px 16px", fontSize: 12.5, cursor: "pointer",
                  background: active ? "var(--active-grad)" : "transparent",
                  color: active ? "var(--text)" : "var(--muted)",
                  fontWeight: active ? 600 : 400,
                  boxShadow: active ? "var(--shadow-active)" : "none",
                }}>
                {t.label}
              </button>
            );
          })}
        </div>

        {mode === "cut" && selected.size > 0 && (
          <button onClick={cutSelected}
            style={{ background: "var(--red)", color: "#fff", fontSize: 12.5, fontWeight: 600 }}>
            Cortar {selected.size}
          </button>
        )}
        {mode === "merge" && selected.size >= 2 && (
          <button onClick={mergeSelected}
            style={{ background: "var(--accent)", color: "#1a1a1a", fontSize: 12.5, fontWeight: 600 }}>
            Juntar {selected.size}
          </button>
        )}
        {mode === "motion" && selected.size > 0 && (
          <button onClick={motionSelected}
            style={{ background: "var(--purple)", color: "#fff", fontSize: 12.5, fontWeight: 600 }}>
            Criar motion
          </button>
        )}

        <span style={{ fontSize: 11.5, color: hintColor, flex: 1, textAlign: "right", minWidth: 160 }}>{hint}</span>
        <label style={{ fontSize: 11.5, color: "var(--faint)" }} title="mostrar o tempo de cada palavra">
          <input type="checkbox" checked={showTimes} onChange={(e) => setShowTimes(e.target.checked)} /> tempos
        </label>
      </div>

      {/* TRANSCRIÇÃO — a protagonista: preenche o resto da altura, rola sozinha */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "var(--panel2)", border: "1px solid var(--border)", borderRadius: 16, padding: "8px 8px" }}>
        {transcript.map((seg) => (
          <div key={seg.id} className="tr-seg">
            <span className="tr-time" title={seg.source === "corrected" ? "trecho corrigido" : undefined}>
              {seg.start.toFixed(1)}s{seg.source === "corrected" && <span style={{ color: "var(--green)" }}> ✎</span>}
            </span>
            <div style={{ lineHeight: 2.1, minWidth: 0 }}>
              {seg.words.map((w, i) => {
                const key = `${seg.id}:${i}`;
                return (
                  <WordChip
                    key={i}
                    word={w}
                    showTime={showTimes}
                    mode={mode}
                    timeEdit={timeEdit}
                    selected={selected.has(key)}
                    onToggleSelect={() => (mode === "popup" ? onAddPopup(w) : toggleSelect(key))}
                    onCommit={(text) => editWord(seg.id, i, text)}
                    onDelete={() => deleteWord(seg.id, i)}
                    onSetTime={(patch) => setWordTime(seg.id, i, patch)}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* POPUP — corrigir pelo script: cola o roteiro e corrige num clique */}
      {scriptOpen && (
        <div onClick={() => setScriptOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(6px)", display: "grid", placeItems: "center" }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: "min(640px, 92vw)", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 20, padding: "24px 24px", boxShadow: "0 24px 80px rgba(0,0,0,0.5)" }}>
            <div className="fo-sec" style={{ marginBottom: 12 }}>
              <div className="t">Corrigir pelo script</div>
              <div className="s">Cole o roteiro do vídeo — a transcrição é corrigida palavra a palavra.</div>
            </div>
            <textarea autoFocus value={scriptDraft} onChange={(e) => setScriptDraft(e.target.value)}
              placeholder="Cole aqui o script…" rows={10}
              style={{ width: "100%", fontSize: 13, boxSizing: "border-box", resize: "vertical" }} />
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 16 }}>
              <label style={{ fontSize: 12.5, color: cutOutside ? "var(--red)" : "var(--muted)" }}>
                <input type="checkbox" checked={cutOutside} onChange={(e) => setCutOutside(e.target.checked)} />{" "}
                cortar o que saiu do script
              </label>
              <span style={{ flex: 1 }} />
              <button onClick={() => setScriptOpen(false)} style={{ fontSize: 12.5, background: "transparent", color: "var(--muted)" }}>
                cancelar
              </button>
              <button disabled={!scriptDraft.trim()} onClick={corrigirPeloScript}
                style={{ background: "var(--accent)", color: "#1a1a1a", fontWeight: 600, padding: "8px 24px", borderRadius: 12 }}>
                Corrigir
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function WordChip({
  word,
  showTime,
  mode,
  timeEdit,
  selected,
  onToggleSelect,
  onCommit,
  onDelete,
  onSetTime,
}: {
  word: Word;
  showTime: boolean;
  mode: "none" | "cut" | "merge" | "popup" | "motion";
  timeEdit: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onCommit: (text: string) => void;
  onDelete: () => void;
  onSetTime: (patch: Partial<Pick<Word, "start" | "end">>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [hover, setHover] = useState(false);
  const [draft, setDraft] = useState(word.text);
  const selecting = mode !== "none";

  function commit() {
    setEditing(false);
    if (draft.trim() === "") onDelete(); // texto vazio -> remove a palavra
    else if (draft !== word.text) onCommit(draft.trim());
    else setDraft(word.text);
  }

  let bg = "transparent"; // funde com o fundo do layout
  if (selected) bg = mode === "cut" ? "rgba(255,93,93,0.22)" : mode === "motion" ? "rgba(180,120,255,0.25)" : "rgba(111,141,255,0.22)";

  return (
    <span
      title={`${word.start.toFixed(2)}s – ${word.end.toFixed(2)}s`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: "relative", display: "inline-block", textAlign: "center", margin: "0 3px", verticalAlign: "top" }}
    >
      {!selecting && hover && !editing && (
        <button
          onClick={onDelete}
          title="remover palavra"
          style={{
            position: "absolute", top: -8, right: -6, width: 16, height: 16, lineHeight: "14px",
            padding: 0, fontSize: 11, borderRadius: "50%", border: "none",
            background: "var(--red)", color: "#fff", cursor: "pointer",
          }}
        >
          ×
        </button>
      )}
      {editing && !selecting ? (
        <input
          autoFocus
          value={draft}
          size={Math.max(draft.length, 2)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { setDraft(word.text); setEditing(false); }
          }}
          style={{ font: "inherit", padding: "0 2px" }}
        />
      ) : (
        <span
          className="tr-w"
          onClick={() => (selecting ? onToggleSelect() : setEditing(true))}
          style={{
            cursor: selecting ? "pointer" : "text",
            padding: "2px 4px",
            borderRadius: 8,
            background: bg,
            textDecoration: mode === "cut" && selected ? "line-through" : "none",
            color: mode === "cut" && selected ? "#c00" : "inherit",
          }}
        >
          {word.text}
        </span>
      )}
      {timeEdit ? (
        <span style={{ display: "flex", gap: 2, justifyContent: "center", marginTop: 2 }}>
          <input type="number" step={0.05} value={word.start}
            onChange={(e) => onSetTime({ start: +e.target.value })}
            title="início (s)" style={{ width: 46, fontSize: 10, padding: 0 }} />
          <input type="number" step={0.05} value={word.end}
            onChange={(e) => onSetTime({ end: +e.target.value })}
            title="fim (s)" style={{ width: 46, fontSize: 10, padding: 0 }} />
        </span>
      ) : (
        showTime && (
          <span style={{ display: "block", fontSize: 9, color: "var(--faint)", lineHeight: 1 }}>
            {word.start.toFixed(1)}
          </span>
        )
      )}
    </span>
  );
}
