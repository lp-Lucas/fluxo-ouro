import { useMemo } from "react";
import type { Caption, Cut, TranscriptSegment } from "../../../../shared/timeline";
import {
  resolveCaptionLines, materializeCaptions, shiftCaptions, sanitizeCaptions,
  countCaptionOverlaps, needsTimingRepair, repairCaptionTimings,
} from "../../../../shared/captions";
import { Icon } from "../../workspace/icons";

/**
 * FERRAMENTAS GLOBAIS das legendas — moram no RODAPÉ do painel "Legenda", dentro do
 * mesmo card do "Estilo das legendas" (espelha o card da Copy no topo: o painel abre
 * e fecha com um bloco, e a transcrição reina no meio).
 *
 * Idioma visual = o do app (MONOCROMÁTICO, theme.css): nada de azul/emoji. Hierarquia
 * igual à barra da Copy — 1 ação branca (primária), 1 cinza (secundária), o resto
 * apagado. Avisos são o único ponto de cor (--red) e SÃO o botão de conserto.
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
  const temCortes = cuts.some((c) => c.enabled);

  // FLUXO NOVO: o vídeo entra SEM transcrição — decupa/corta primeiro, transcreve depois
  // (mais preciso, menos retrabalho). Sem roteiro ainda, mostra só o "Transcrever vídeo".
  if (transcript.length === 0) {
    if (!onRetranscribeCut) return null;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", fontSize: 12.5 }}>
        <button onClick={onRetranscribeCut} disabled={retranscribing} style={capBtnPrimary}
          title="transcreve o áudio do vídeo (pulando os cortes, se houver) e cria o roteiro + as legendas">
          <Icon name="target" size={13} />
          {retranscribing ? "transcrevendo…" : "Transcrever vídeo"}
        </button>
        <span style={{ color: "var(--muted)" }}>decupe/corte o vídeo primeiro — a legenda sai já limpa, pulando os cortes.</span>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12.5 }}>
      <span style={capChip} title={`${lines.length} linhas de legenda na timeline`}>
        <Icon name="text" size={13} style={{ opacity: 0.65 }} />
        Legendas
        <span style={{ color: "var(--muted)", fontWeight: 400 }}>· {lines.length}</span>
      </span>

      <span style={sep} />

      {onAnchorToSpeech && (
        <button onClick={() => onAnchorToSpeech(base())} disabled={anchoring} style={capBtnPrimary}
          title="re-ouve o áudio (whisper em janelas curtas) e crava cada palavra no tempo real da fala — o texto não muda; leva ~30s">
          <Icon name="target" size={13} />
          {anchoring ? "re-ouvindo o áudio…" : "Alinhar com a fala"}
        </button>
      )}

      {onRetranscribeCut && (
        <button onClick={onRetranscribeCut} disabled={retranscribing} style={capBtnSecondary}
          title={temCortes
            ? "renderiza SÓ o áudio que sobrou na timeline (pulando os cortes), re-transcreve e reconstrói o roteiro + legendas — conserta legendas bugadas depois de muitos cortes. SUBSTITUI o roteiro atual."
            : "re-transcreve o áudio inteiro e reconstrói o roteiro + legendas. (Com cortes ativos, pula os trechos cortados.) SUBSTITUI o roteiro atual."}>
          <Icon name="scissor" size={13} />
          {retranscribing ? "retranscrevendo…" : temCortes ? "Retranscrever (pulando cortes)" : "Retranscrever"}
        </button>
      )}

      <span style={capGroup} title="desloca TODAS as legendas de uma vez — ajuste fino de ouvido">
        <span style={capGroupLabel}>deslocar</span>
        <button style={capGroupBtn} onClick={() => onCaptionsChange(shiftCaptions(base(), -0.05))}>◀ 50ms</button>
        <span style={capGroupSep} />
        <button style={capGroupBtn} onClick={() => onCaptionsChange(shiftCaptions(base(), +0.05))}>50ms ▶</button>
      </span>

      {sobrepostas > 0 && (
        <button style={capBtnWarn} onClick={() => onCaptionsChange(sanitizeCaptions(base()))}
          title="uma legenda está dentro da outra na timeline — remove ecos duplicados e encolhe sobreposições (as suas linhas nunca são apagadas)">
          <Icon name="warn" size={12.5} />
          {sobrepostas} sobreposta{sobrepostas > 1 ? "s" : ""} — organizar
        </button>
      )}
      {quebradas > 0 && (
        <button style={capBtnWarn}
          onClick={() => { const { captions: fix, fixed } = repairCaptionTimings(base()); if (fixed > 0) onCaptionsChange(fix); }}
          title="palavra de ~0s ou buraco morto (a linha fica na tela e só a 1ª palavra acende) — espalha as palavras por igual só nas linhas quebradas">
          <Icon name="warn" size={12.5} />
          {quebradas} travada{quebradas > 1 ? "s" : ""} — consertar
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
          <Icon name="sync" size={13} />
          re-sincronizar
        </button>
      ) : null}
    </div>
  );
}

// ── idioma visual das legendas (compartilhado com o editor da linha na timeline) ──

/** Faixa com moldura própria — usada pelo editor da LINHA selecionada na timeline. */
export const capBar: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
  marginTop: 8, padding: "8px 12px", fontSize: 12.5,
  background: "var(--panel2)",
  border: "1px solid var(--border)", borderRadius: 12,
};

/** Identidade da barra: ícone + rótulo + contagem. */
export const capChip: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6,
  fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap",
};

/** Divisória vertical fininha (mesmo recurso do segmented). */
const sep: React.CSSProperties = { width: 1, height: 18, background: "var(--border)" };

/** Ação primária — igual ao "Auto-corrigir" da Copy: branco com texto escuro. */
export const capBtnPrimary: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6,
  background: "var(--accent)", color: "#1a1a1a", border: "1px solid transparent",
  borderRadius: 12, padding: "4px 14px", fontSize: 12, fontWeight: 600,
  cursor: "pointer", whiteSpace: "nowrap",
};

/** Ação secundária — igual ao "Corrigir pelo script". */
export const capBtnSecondary: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6,
  background: "var(--panel3)", color: "var(--text)", border: "1px solid var(--border)",
  borderRadius: 12, padding: "4px 14px", fontSize: 12, fontWeight: 500,
  cursor: "pointer", whiteSpace: "nowrap",
};

/** Aviso clicável: o pill É o botão de conserto (único ponto de cor da barra). */
export const capBtnWarn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6,
  background: "rgba(233, 117, 117, 0.10)", color: "var(--red)",
  border: "1px solid rgba(233, 117, 117, 0.32)", borderRadius: 12,
  padding: "4px 12px", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
};

/** Ação discreta (texto apagado, sem moldura). */
export const capBtnMuted: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6,
  background: "transparent", color: "var(--muted)", border: "none",
  padding: "4px 6px", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
};

/** Grupo segmentado (nudges e ações da linha) — uma moldura, divisórias internas. */
export const capGroup: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", overflow: "hidden",
  background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12,
};
export const capGroupBtn: React.CSSProperties = {
  background: "transparent", color: "var(--text)", border: "none",
  padding: "4px 10px", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
};
export const capGroupSep: React.CSSProperties = { width: 1, alignSelf: "stretch", background: "var(--border)" };
export const capGroupLabel: React.CSSProperties = {
  padding: "0 4px 0 10px", fontSize: 11, color: "var(--muted)", userSelect: "none",
};
