import { comBase } from '../../os-session';
import { useState } from "react";
import type { Cut, Zoom, Popup, TranscriptSegment, Seconds } from "../../../../shared/timeline";
import { removedDuration, generateAlternatingZooms } from "./autocut";
import { repairWordTimings } from "../../../../shared/captions";
import { runDecupagemServer, pollDecupagemAi, type DisfluenciaRegion } from "./decupagem";
import { PopupsPanel } from "./popups/PopupsPanel";
import type { TransportBus } from "../../workspace/transport";

/**
 * Etapa 5: EDITOR — visual-first. As ações são CARDS clicáveis (ícone + nome),
 * sem parágrafos de explicação: o resultado aparece na timeline (embaixo do
 * preview) e num resumo de uma linha. A lista de cortes NÃO existe aqui — quem
 * edita corte é a timeline (arrastar bordas, mover, ativar).
 */
export function Editor({
  transcript,
  onTranscriptChange,
  durationSec,
  copy,
  cuts,
  onCutsChange,
  zooms,
  onZoomsChange,
  popups,
  onPopupsChange,
  videoFile,
  transport,
}: {
  transcript: TranscriptSegment[];
  onTranscriptChange: (t: TranscriptSegment[]) => void;
  durationSec: Seconds;
  copy: string;
  cuts: Cut[];
  onCutsChange: (c: Cut[]) => void;
  zooms: Zoom[];
  onZoomsChange: (z: Zoom[]) => void;
  popups: Popup[];
  onPopupsChange: (p: Popup[]) => void;
  /** Vídeo bruto — necessário p/ a decupagem (o VAD é a fonte do tempo). */
  videoFile?: File | null;
  /** Ponte de transporte com o preview — usada para "ir e ouvir" cada ponto de revisão. */
  transport?: TransportBus;
}) {
  const [zoomInterval, setZoomInterval] = useState(3);
  const [zoomScale, setZoomScale] = useState(1.3);
  const [decBusy, setDecBusy] = useState(false);
  const [covBusy, setCovBusy] = useState(false);
  const [reviewer, setReviewer] = useState<DisfluenciaRegion[]>([]); // "ouça aqui" (disfluência + falso começo bloqueado)
  const [ativoRev, setAtivoRev] = useState<number | null>(null); // ponto de revisão em foco (tocando)
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const flash = (text: string, err = false) => { setMsg({ text, err }); setTimeout(() => setMsg(null), 6000); };

  // ── REVISÃO ponto a ponto: clicar num tempo leva o preview até lá e dá play; então
  //    "cortar" (vira corte manual naquele trecho) ou "manter" (dispensa o marcador).
  function irEouvir(i: number, r: DisfluenciaRegion) {
    setAtivoRev(i);
    if (!transport) return;
    transport.seek(Math.max(0, r.start - 0.15)); // um respiro antes pra ouvir a entrada
    if (!transport.state.playing) transport.toggle();
  }
  function cortarRevisao(i: number, r: DisfluenciaRegion) {
    const cut: Cut = { id: `cut-rev-${Math.round(r.start * 1000)}`, start: r.start, end: r.end, reason: "manual", enabled: true };
    const semDup = cuts.filter((c) => c.id !== cut.id);
    onCutsChange([...semDup, cut].sort((a, b) => a.start - b.start));
    dispensaRevisao(i);
    flash(`Corte ${fmt(r.start)}–${fmt(r.end)} marcado`);
  }
  function manterRevisao(i: number) { dispensaRevisao(i); }
  function dispensaRevisao(i: number) {
    setReviewer((prev) => prev.filter((_, k) => k !== i));
    setAtivoRev(null);
    if (transport?.state.playing) transport.toggle(); // pausa ao decidir
  }

  /**
   * DECUPAR — UM BOTÃO. Pipeline completo no servidor: VAD (fonte do tempo) → ancoragem →
   * silêncio + fora-do-roteiro + alucinação (imediato) → IA de retake/falso começo verificada
   * (em background) → falso começo com reparo de legenda pela copy → disfluência marcada
   * ("ouça aqui"). Nunca falha em silêncio — erro vira aviso.
   */
  async function decupar() {
    if (!videoFile) { flash("Vídeo não carregado — abra a Etapa 1 primeiro.", true); return; }
    setDecBusy(true);
    setReviewer([]);
    try {
      const data = await runDecupagemServer(videoFile, transcript, copy);
      if (data.error) { flash(data.error, true); return; }
      // 1) IMEDIATO (silêncio + alucinação + copy). Mantém só os cortes manuais.
      const manual = () => cuts.filter((c) => c.reason === "manual");
      onCutsChange([...manual(), ...(data.cuts ?? [])].sort((a, b) => a.start - b.start));
      flash(`Decupagem: ${(data.cuts ?? []).length} corte(s)${data.jobId ? " — analisando retakes…" : ""}`);

      // 2) IA (retakes/falso começo) em background: SUBSTITUI o conjunto pelo final + repara legenda.
      if (data.jobId) {
        const patch = await pollDecupagemAi(data.jobId);
        if (patch.status === "done" && patch.cuts) {
          onCutsChange([...manual(), ...patch.cuts].sort((a, b) => a.start - b.start));
          if (patch.transcript) onTranscriptChange(patch.transcript);
          setReviewer(patch.regions ?? []);
          const bloqueado = (patch.regions ?? []).filter((r) => r.label.includes("cole a copy")).length;
          if (bloqueado > 0) {
            flash(`${patch.cuts.length} corte(s) — ${bloqueado} falso começo achado mas SEGURADO: cole a copy na Etapa 1 pra cortar e reparar a legenda.`, true);
          } else {
            const rev = patch.regions?.length ? ` · ${patch.regions.length} p/ ouvir` : "";
            flash(`Decupagem completa: ${patch.cuts.length} corte(s)${patch.transcript ? " + legenda reparada" : ""}${rev}`);
          }
        } else if (patch.status === "error") {
          flash(`Retakes: ${patch.error ?? "falha na IA"} (cortes imediatos mantidos)`, true);
        }
      }
    } catch (e) { flash((e as Error).message, true); }
    finally { setDecBusy(false); }
  }

  /**
   * Conferência de legendas — TRÊS checagens num botão:
   * 1. TIMING BUGADO (local, grátis): palavras com duração ~zero ou empilhadas no mesmo
   *    instante (o bug antigo de adicionar palavras) — REPARA redistribuindo na janela
   *    disponível. É isso que atualiza projetos legendados antes do conserto.
   * 2. SINCRONIA COM O ÁUDIO (whisper fresco, ~1 min/min de vídeo): regiões de legenda
   *    atrasada/adiantada (derrapada do whisper original — caso vid/1: +2s em 46–55.7s)
   *    são detectadas e as palavras recolocadas no tempo certo. O TEXTO fica intacto e
   *    NADA é cortado. Recusa em silêncio se o áudio não bater com a transcrição.
   * 3. COBERTURA (IA): falas sem legenda pós-corte — preenche pela copy.
   */
  async function conferirLegendas() {
    setCovBusy(true);
    // 1) REPARO DE TIMING (local, instantâneo, nunca falha): aplica e REPORTA na hora —
    //    as etapas seguintes podem falhar/demorar e NÃO podem mascarar este resultado.
    const rep = repairWordTimings(transcript);
    if (rep.fixed > 0) {
      onTranscriptChange(rep.transcript);
      flash(`${rep.fixed} palavra(s) com timing bugado corrigidas — verificando sincronia…`);
    }
    let cur = rep.transcript;
    const fixes: string[] = rep.fixed > 0 ? [`${rep.fixed} timing(s) bugado(s)`] : [];

    // 2) SINCRONIA com o áudio (whisper no backend) — sem vídeo carregado, pula
    if (videoFile) {
      try {
        flash(`${fixes.length ? fixes.join(" · ") + " · " : ""}verificando sincronia com o áudio (~1 min)…`);
        const fd = new FormData();
        fd.append("video", videoFile);
        fd.append("transcript", JSON.stringify(cur));
        const r = await fetch(comBase("/api/fix-caption-timing"), { method: "POST", body: fd });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "falha na checagem de sincronia");
        if (!d.refused && d.fixedWords > 0) {
          cur = d.transcript;
          onTranscriptChange(cur);
          const regs = (d.regions as { from: number; to: number; shift: number }[])
            .map((g) => `${g.from.toFixed(1)}–${g.to.toFixed(1)}s ${g.shift > 0 ? "atrasada" : "adiantada"} ${Math.abs(g.shift).toFixed(1)}s`)
            .join("; ");
          fixes.push(`${d.fixedWords} palavra(s) fora de sincronia recolocadas (${regs})`);
          flash(`⏱ ${fixes[fixes.length - 1]} — conferindo cobertura…`);
        }
      } catch (e) {
        // sincronia falhou → segue pras outras checagens (nada foi perdido)
        flash(`sincronia com o áudio falhou: ${(e as Error).message} — seguindo pra cobertura…`, true);
      }
    }
    const fix = fixes.length ? `${fixes.join(" · ")} · ` : "";

    try {
      // 3) COBERTURA (IA) — sobre a transcrição JÁ reparada/sincronizada
      const r = await fetch(comBase("/api/caption-coverage"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript: cur, cuts, copy, durationSec }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Falha na conferência");
      if (data.needsCopy) { flash(`${fix}${data.gaps} trecho(s) sem legenda — cole a copy na Etapa 1 pra preencher.`, true); return; }
      if (data.gaps === 0) { flash(`${fix}toda fala tem legenda${fixes.length === 0 ? ", nenhum timing bugado e sincronia ok" : ""}.`); return; }
      if (data.filled > 0) onTranscriptChange(data.transcript);
      flash(`${fix}${data.gaps} buraco(s), ${data.filled} preenchido(s) com a copy`);
    } catch (e) {
      // falha da IA NÃO desfaz nem esconde os reparos — vira aviso
      flash(`${fix}cobertura (IA) falhou: ${(e as Error).message} — os reparos anteriores foram mantidos; tente de novo depois.`, true);
    } finally { setCovBusy(false); }
  }

  const ativos = cuts.filter((c) => c.enabled).length;
  const final = Math.max(0, durationSec - removedDuration(cuts));
  const zoomAuto = zooms.some((z) => z.id.startsWith("zoom-auto-"));

  return (
    <section>
      <style>{`
        .ed-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
        .ed-card {
          position: relative;
          background: var(--panel2);
          border: 1px solid var(--border);
          border-radius: 16px;
          padding: 16px;
          text-align: left;
          cursor: pointer;
          font-family: inherit;
          display: flex; flex-direction: column; gap: 12px;
          transition: background 0.2s ease, border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
        }
        .ed-card:hover:not(:disabled) { background: var(--panel3); border-color: var(--border-active); }
        .ed-card:active:not(:disabled) { transform: scale(0.985); }
        .ed-card:disabled { opacity: 0.4; cursor: default; }
        .ed-icon {
          width: 38px; height: 38px; border-radius: 12px;
          background: var(--panel3); border: 1px solid var(--border);
          display: flex; align-items: center; justify-content: center; color: var(--muted);
        }
        .ed-card:hover:not(:disabled) .ed-icon { color: var(--text); }
        .ed-card .name { font-size: 13.5px; font-weight: 600; color: var(--text); }
        .ed-card .hint { font-size: 11.5px; color: var(--faint); line-height: 1.4; }
        .ed-card.primary { background: linear-gradient(180deg, #2e2e2e, #242424); border-color: var(--border-active); }
        .ed-summary {
          display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
          margin-top: 12px; padding: 12px 16px;
          background: var(--panel2); border: 1px solid var(--border); border-radius: 999px;
          font-size: 12.5px; color: var(--muted);
        }
        .ed-summary b { color: var(--text); font-weight: 700; }
        .ed-mini { display: inline-flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--faint); }
        .ed-mini input[type="range"] { width: 80px; }
        .ed-zoomchip {
          display: inline-flex; align-items: center; gap: 8px;
          background: var(--panel2); border: 1px solid var(--border); border-radius: 999px;
          padding: 4px 6px 4px 12px; font-size: 12px; color: var(--muted);
        }
        .ed-zoomchip input { width: 52px; padding: 4px 8px; font-size: 11.5px; border-radius: 8px; text-align: center; }
        .ed-zoomchip .x { width: 20px; height: 20px; padding: 0; border-radius: 999px; font-size: 11px; display: grid; place-items: center; color: var(--red); background: transparent; border: none; }
        @media (max-width: 900px) { .ed-grid { grid-template-columns: 1fr; } }
      `}</style>

      {/* ───────── CORTES ───────── */}
      <div className="fo-sec">
        <div className="t">Cortes</div>
        <div className="s">Um clique decupa tudo. O resultado aparece na timeline; ajuste na mão se quiser.</div>
      </div>

      {/* UM BOTÃO: decupagem completa (VAD → silêncio + fora-do-roteiro + alucinação →
          retake/falso começo por IA verificada → reparo de legenda → disfluência marcada) */}
      <button className="ed-card primary" onClick={decupar}
        disabled={decBusy || !videoFile || transcript.length === 0}
        title={!videoFile ? "Carregue o vídeo na Etapa 1" : undefined}
        style={{ width: "100%", alignItems: "flex-start" }}>
        <span className="ed-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 3.5 6 7H3v10h3l3.5 3.5zM16 8a5 5 0 0 1 0 8M19 5a9 9 0 0 1 0 14" /></svg>
        </span>
        <span className="name">{decBusy ? "Decupando…" : "Decupar"}</span>
        <span className="hint">silêncios, fora do roteiro, alucinações, takes repetidos e falsos começos — pousa os cortes no vale do áudio e repara a legenda pela copy</span>
      </button>

      {/* REVISAR ponto a ponto: clica no tempo → preview pula e dá play → cortar / manter.
          O ⚠ (falso começo bloqueado) é vermelho; cortá-lo é um corte manual sem reparo de legenda. */}
      {reviewer.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12, color: "var(--muted)" }}>
            <span style={{ color: "var(--accent-text)" }}>Revisar {reviewer.length}:</span>
            {reviewer.map((r, i) => {
              const bloqueado = r.label.includes("cole a copy");
              const repeticao = r.label.startsWith("Repetição");
              const cor = bloqueado ? "var(--red)" : repeticao ? "var(--accent-text)" : "var(--text)";
              const ativo = ativoRev === i;
              return (
                <span key={`${r.start}-${r.end}`}
                  style={{ display: "inline-flex", alignItems: "center", gap: 4, borderRadius: 999, padding: 3,
                    border: `1px solid ${ativo ? "var(--border-active)" : bloqueado ? "var(--red)" : repeticao ? "var(--accent-text)" : "var(--border)"}`,
                    background: ativo ? "var(--panel3)" : "var(--panel2)" }}>
                  <button onClick={() => irEouvir(i, r)} title={r.label}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4, border: "none", background: "transparent",
                      fontSize: 12, padding: "1px 8px", cursor: "pointer", color: cor }}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                    {bloqueado ? "⚠ " : repeticao ? "⚡ " : ""}{fmt(r.start)}–{fmt(r.end)}
                  </button>
                  {ativo && (
                    <>
                      <button onClick={() => cortarRevisao(i, r)} title="cortar este trecho"
                        style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, color: "var(--red)", border: "1px solid var(--red)", background: "transparent" }}>✂ cortar</button>
                      <button onClick={() => manterRevisao(i)} title="manter (dispensar)"
                        style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, color: "var(--green)", border: "1px solid var(--border)", background: "transparent" }}>manter</button>
                    </>
                  )}
                </span>
              );
            })}
            <button onClick={() => { setReviewer([]); setAtivoRev(null); }} style={{ fontSize: 11, padding: "3px 12px", color: "var(--faint)" }}>limpar</button>
          </div>
          {ativoRev !== null && reviewer[ativoRev]?.label.includes("cole a copy") && (
            <div style={{ fontSize: 11, color: "var(--red)", marginTop: 8, lineHeight: 1.4 }}>
              Falso começo — cortar aqui deixa a legenda sem reparo. Cole a copy na Etapa 1 e clique <b>Decupar</b> pra cortar com a legenda reparada automaticamente.
            </div>
          )}
          {ativoRev !== null && reviewer[ativoRev]?.label.startsWith("Repetição") && (
            <div style={{ fontSize: 11, color: "var(--accent-text)", marginTop: 8, lineHeight: 1.4 }}>
              {reviewer[ativoRev]!.label} — <b>cortar</b> remove a primeira tomada e mantém a última.
            </div>
          )}
        </div>
      )}

      {/* resumo vivo — a única "explicação" é o número */}
      {(cuts.length > 0 || msg) && (
        <div className="ed-summary">
          {cuts.length > 0 && (
            <>
              <span><b>{ativos}</b> corte{ativos !== 1 ? "s" : ""}</span>
              <span>−{(durationSec - final).toFixed(1)}s</span>
              <span>final <b>{fmt(final)}</b></span>
            </>
          )}
          <span style={{ flex: 1 }} />
          {msg && <span style={{ color: msg.err ? "var(--red)" : "var(--green)" }}>{msg.text}</span>}
          <button onClick={conferirLegendas} disabled={covBusy || transcript.length === 0}
            style={{ fontSize: 11.5, padding: "4px 12px" }}>
            {covBusy ? "conferindo…" : "conferir legendas"}
          </button>
          {cuts.length > 0 && (
            <button onClick={() => onCutsChange([])} style={{ fontSize: 11.5, padding: "4px 12px", color: "var(--red)" }}>
              limpar
            </button>
          )}
        </div>
      )}

      <hr className="fo-divider" />

      {/* ───────── ZOOM ───────── */}
      <div className="fo-sec">
        <div className="t">Zoom</div>
        <div className="s">Movimento de câmera intercalado — aproxima e afasta no ritmo do vídeo.</div>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "stretch", flexWrap: "wrap" }}>
        <button className={`ed-card${zoomAuto ? " fo-active" : ""}`} style={{ width: 240 }}
          onClick={() => zoomAuto
            ? onZoomsChange(zooms.filter((z) => !z.id.startsWith("zoom-auto-")))
            : onZoomsChange(generateAlternatingZooms(durationSec, zoomInterval, zoomScale))}
          disabled={durationSec <= 0}>
          <span className="ed-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3M11 8v6M8 11h6" /></svg>
          </span>
          <span className="name">Zoom automático {zoomAuto ? "· ligado" : ""}</span>
          <span className="ed-mini" onClick={(e) => e.stopPropagation()}>
            a cada {zoomInterval}s
            <input type="range" min={1} max={8} step={0.5} value={zoomInterval} onChange={(e) => setZoomInterval(+e.target.value)} />
          </span>
          <span className="ed-mini" onClick={(e) => e.stopPropagation()}>
            força {zoomScale.toFixed(2)}×
            <input type="range" min={1.05} max={2} step={0.05} value={zoomScale} onChange={(e) => setZoomScale(+e.target.value)} />
          </span>
        </button>

        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {zooms.filter((z) => !z.id.startsWith("zoom-auto-")).map((z) => (
              <span key={z.id} className="ed-zoomchip">
                <input type="number" value={z.at} step={0.1} title="início (s)"
                  onChange={(e) => upd(zooms, onZoomsChange, z.id, { at: +e.target.value })} />
                <input type="number" value={z.duration} step={0.1} title="duração (s)"
                  onChange={(e) => upd(zooms, onZoomsChange, z.id, { duration: +e.target.value })} />
                <input type="number" value={z.scale} step={0.05} title="escala (×)"
                  onChange={(e) => upd(zooms, onZoomsChange, z.id, { scale: +e.target.value })} />
                <button className="x" onClick={() => onZoomsChange(zooms.filter((x) => x.id !== z.id))}>×</button>
              </span>
            ))}
            <button onClick={() => onZoomsChange([...zooms, { id: `zoom-${Date.now()}`, at: 0, duration: 1.5, scale: 1.3 }])}
              style={{ fontSize: 12, padding: "4px 16px" }}>
              + zoom manual
            </button>
          </div>
          {zoomAuto && (
            <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 8 }}>
              {zooms.filter((z) => z.id.startsWith("zoom-auto-")).length} blocos automáticos gerados — clique no card pra desligar
            </div>
          )}
        </div>
      </div>

      <hr className="fo-divider" />

      {/* ───────── POPUPS ───────── */}
      <PopupsPanel transcript={transcript} popups={popups} onChange={onPopupsChange} />
    </section>
  );
}

function upd<T extends { id: string }>(list: T[], onChange: (l: T[]) => void, id: string, patch: Partial<T>) {
  onChange(list.map((x) => (x.id === id ? { ...x, ...patch } : x)));
}

function fmt(s: Seconds): string {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1);
  return `${m}:${sec.padStart(4, "0")}`;
}
