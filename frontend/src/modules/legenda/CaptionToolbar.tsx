import { useMemo } from "react";
import type { Caption, Cut, TranscriptSegment } from "../../../../shared/timeline";
import {
  resolveCaptionLines, materializeCaptions, shiftCaptions, sanitizeCaptions,
  countCaptionOverlaps, needsTimingRepair, repairCaptionTimings,
} from "../../../../shared/captions";

/**
 * FERRAMENTAS GLOBAIS das legendas — mora no painel "Roteiro & Correção" (a timeline
 * fica só com a faixa e o editor da linha selecionada, que precisam de contexto visual).
 * Identidade azul da faixa; avisos são PILLS CLICÁVEIS (o aviso É o botão de conserto).
 */
export function CaptionToolbar({
  transcript, cuts, captions, onCaptionsChange, maxWords = 7, onAnchorToSpeech, anchoring = false,
  onRetranscribeCut, retranscribing = false,
}: {
  transcript: TranscriptSegment[];
  cuts: Cut[];
  captions: Caption[];
  onCaptionsChange: (c: Caption[]) => void;
  maxWords?: number;
  /** Alinhamento fino com a fala (re-transcrição no backend) — o App faz a rede. */
  onAnchorToSpeech?: (base: Caption[]) => void;
  anchoring?: boolean;
  /** Retranscreve SÓ o áudio que sobrou na timeline (pulando os cortes) — o App faz a rede. */
  onRetranscribeCut?: () => void;
  retranscribing?: boolean;
}) {
  const lines = useMemo(
    () => resolveCaptionLines(transcript, cuts, captions, maxWords),
    [transcript, cuts, captions, maxWords],
  );
  // Copy-on-write (mesma regra da timeline): sem materializar, edita a derivação congelada.
  const base = () => (captions.length ? captions : materializeCaptions(transcript, maxWords));
  const quebradas = lines.filter(needsTimingRepair).length;
  const sobrepostas = countCaptionOverlaps(lines);

  if (transcript.length === 0) return null;

  return (
    <div style={capBar}>
      <span style={capChip} title={`${lines.length} linhas de legenda na timeline`}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: "#8ab4ff", display: "inline-block" }} />
        legendas · {lines.length}
      </span>

      {onAnchorToSpeech && (
        <button onClick={() => onAnchorToSpeech(base())} disabled={anchoring} style={capBtnPrimary}
          title="re-ouve o áudio (whisper em janelas curtas) e crava cada palavra no tempo real da fala — o texto não muda; leva ~30s">
          {anchoring ? "⏳ re-ouvindo o áudio…" : "🎯 alinhar com a fala"}
        </button>
      )}

      {onRetranscribeCut && (
        <button onClick={onRetranscribeCut} disabled={retranscribing}
          style={cuts.some((c) => c.enabled) ? capBtnPrimary : capBtnMuted}
          title={cuts.some((c) => c.enabled)
            ? "renderiza SÓ o áudio que sobrou na timeline (pulando os cortes), re-transcreve e reconstrói o roteiro + legendas — conserta legendas bugadas depois de muitos cortes. SUBSTITUI o roteiro atual."
            : "re-transcreve o áudio inteiro e reconstrói o roteiro + legendas. (Com cortes ativos, pula os trechos cortados.) SUBSTITUI o roteiro atual."}>
          {retranscribing ? "⏳ retranscrevendo…" : "✂️ retranscrever" + (cuts.some((c) => c.enabled) ? " (pulando cortes)" : "")}
        </button>
      )}

      <span style={capGroup} title="desloca TODAS as legendas de uma vez — ajuste fino de ouvido">
        <button style={capGroupBtn} onClick={() => onCaptionsChange(shiftCaptions(base(), -0.05))}>◀ 50ms</button>
        <span style={capGroupSep} />
        <button style={capGroupBtn} onClick={() => onCaptionsChange(shiftCaptions(base(), +0.05))}>50ms ▶</button>
      </span>

      {sobrepostas > 0 && (
        <button style={capBtnWarn} onClick={() => onCaptionsChange(sanitizeCaptions(base()))}
          title="uma legenda está dentro da outra na timeline — remove ecos duplicados e encolhe sobreposições (as suas linhas nunca são apagadas)">
          ⚠ {sobrepostas} sobreposta{sobrepostas > 1 ? "s" : ""} — organizar
        </button>
      )}
      {quebradas > 0 && (
        <button style={capBtnWarn}
          onClick={() => { const { captions: fix, fixed } = repairCaptionTimings(base()); if (fixed > 0) onCaptionsChange(fix); }}
          title="palavra de ~0s ou buraco morto (a linha fica na tela e só a 1ª palavra acende) — espalha as palavras por igual só nas linhas quebradas">
          ⚠ {quebradas} travada{quebradas > 1 ? "s" : ""} — consertar
        </button>
      )}

      <span style={{ flex: 1 }} />

      {captions.length ? (
        <button style={capBtnMuted}
          onClick={() => {
            if (!confirm("Regerar as legendas a partir da transcrição? Os ajustes manuais de tempo serão perdidos.")) return;
            onCaptionsChange([]);
          }}
          title={`as ${captions.length} linhas têm tempo manual — a transcrição não as reescreve mais. Regerar descarta os ajustes.`}>
          ↻ re-sincronizar
        </button>
      ) : null}
    </div>
  );
}

// ── idioma visual das legendas (compartilhado com o editor da linha na timeline) ──

export const capBar: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
  marginTop: 8, padding: "6px 10px", fontSize: 12.5,
  background: "rgba(96, 150, 255, 0.04)",
  border: "1px solid var(--border)", borderRadius: 10,
};

/** Identidade da barra: quadradinho azul + contagem. */
export const capChip: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6,
  fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap",
};

/** Ação primária (a única com cor cheia — hierarquia clara). */
export const capBtnPrimary: React.CSSProperties = {
  background: "rgba(96, 150, 255, 0.16)", color: "#cfe0ff",
  border: "1px solid rgba(140, 180, 255, 0.45)", borderRadius: 8,
  padding: "4px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
};

/** Aviso clicável: o pill É o botão de conserto (detalhe no tooltip). */
export const capBtnWarn: React.CSSProperties = {
  background: "rgba(255, 120, 90, 0.10)", color: "#ffb4a2",
  border: "1px solid rgba(255, 120, 90, 0.35)", borderRadius: 999,
  padding: "3px 12px", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
};

/** Ação discreta (texto apagado, sem moldura). */
export const capBtnMuted: React.CSSProperties = {
  background: "transparent", color: "var(--muted)", border: "none",
  padding: "4px 6px", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
};

/** Grupo segmentado (nudges e ações da linha) — uma moldura, divisórias internas. */
export const capGroup: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", overflow: "hidden",
  background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8,
};
export const capGroupBtn: React.CSSProperties = {
  background: "transparent", color: "var(--text)", border: "none",
  padding: "4px 10px", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
};
export const capGroupSep: React.CSSProperties = { width: 1, alignSelf: "stretch", background: "var(--border)" };
export const capGroupLabel: React.CSSProperties = {
  padding: "0 4px 0 10px", fontSize: 11, color: "var(--muted)", userSelect: "none",
};
