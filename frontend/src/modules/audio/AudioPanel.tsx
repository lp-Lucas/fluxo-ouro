import { useEffect, useRef, useState } from "react";
import { comBase } from "../../os-session";
import { DEFAULT_AUDIO, LOUDNESS, masterParams, type AudioSettings, type LoudnessPreset } from "../../../../shared/audio";
import { Card, Pill, SliderField } from "../../workspace/ui";

/**
 * TRATAMENTO DE ÁUDIO — um botão, igual ao Adobe Podcast.
 *
 * A tela inteira gira em torno de UMA ação ("Tratar áudio") e de UMA prova
 * ("Original ⇄ Tratado" no mesmo instante do áudio). Os ajustes finos existem,
 * mas ficam recolhidos: quem só quer a voz limpa nunca precisa abri-los.
 *
 * Detalhe que faz o painel parecer instantâneo: mexer nos ajustes NÃO refaz o
 * isolamento (a parte cara, cacheada pela origem no backend) — só a masterização.
 * Por isso o "aplicar" volta em segundos, quantas vezes o usuário quiser.
 */
export function AudioPanel({ audio, onChange, videoFile, videoUrl, projectId, sourceAsset }: {
  audio: AudioSettings | undefined;
  onChange: (a: AudioSettings | undefined) => void;
  videoFile: File | null;
  videoUrl?: string | null;
  projectId?: string;
  sourceAsset?: string;
}) {
  const cfg: AudioSettings = audio ?? DEFAULT_AUDIO;
  const rendered = cfg.enhance ? cfg.rendered : undefined;

  const [jobId, setJobId] = useState<string | null>(null);
  const [prog, setProg] = useState(0);
  const [etapa, setEtapa] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [semIsolamento, setSemIsolamento] = useState(false);

  // A/B: qual faixa o player está tocando. Trocar preserva o instante — é o que
  // torna a comparação honesta (e é o momento em que o usuário "compra" o resultado).
  const [lado, setLado] = useState<"tratado" | "original">("tratado");
  const playerRef = useRef<HTMLAudioElement>(null);

  const desatualizado = Boolean(rendered && !rendered.key.endsWith(`:${masterParams(cfg)}`));
  const rodando = jobId !== null;
  const podeTratar = Boolean(videoFile || (projectId && sourceAsset));

  function patch(p: Partial<AudioSettings>) {
    onChange({ ...cfg, ...p });
  }

  // O polling vive fora do ciclo de render (deps só [jobId]). Sem estas refs ele
  // gravaria o resultado por cima de um ajuste que o usuário fez ENQUANTO
  // processava — a versão de `cfg` capturada no início do job já estaria velha.
  const cfgRef = useRef(cfg); cfgRef.current = cfg;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;

  // ── troca de faixa preservando o instante e o play/pause ───────────────────
  function trocarLado(novo: "tratado" | "original") {
    const a = playerRef.current;
    const t = a?.currentTime ?? 0;
    const tocando = Boolean(a && !a.paused);
    setLado(novo);
    requestAnimationFrame(() => {
      const el = playerRef.current;
      if (!el) return;
      el.currentTime = t;
      if (tocando) el.play().catch(() => {});
    });
  }

  // ── enfileira o tratamento ─────────────────────────────────────────────────
  async function tratar(forcar = false) {
    if (!podeTratar || rodando) return;
    setErro(null); setProg(0); setEtapa("Enviando");
    try {
      const form = new FormData();
      form.append("settings", JSON.stringify({ ...cfg, enhance: true, rendered: undefined }));
      if (forcar) form.append("forcar", "1");
      // Projeto salvo: o backend usa o asset que JÁ está no servidor (sem upload).
      if (projectId && sourceAsset) {
        form.append("projectId", projectId);
        form.append("asset", sourceAsset);
      } else if (videoFile) {
        form.append("video", videoFile);
      }
      const r = await fetch(comBase("/api/audio/enhance"), { method: "POST", body: form });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Falha ao iniciar o tratamento");
      setSemIsolamento(d.isolamento === false);
      setJobId(d.id as string);
    } catch (e) {
      setErro((e as Error).message);
      setEtapa("");
    }
  }

  async function cancelar() {
    if (!jobId) return;
    await fetch(comBase(`/api/audio/enhance/cancel/${jobId}`), { method: "POST" }).catch(() => {});
  }

  // ── polling do job ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!jobId) return;
    let vivo = true;
    const timer = setInterval(async () => {
      try {
        const r = await fetch(comBase(`/api/audio/enhance/progress/${jobId}`));
        const d = await r.json();
        if (!vivo) return;
        setProg(d.progress ?? 0);
        setEtapa(d.etapa ?? "");
        if (d.status === "done") {
          setJobId(null);
          const res = d.result as AudioSettings["rendered"];
          if (res) { onChangeRef.current({ ...cfgRef.current, enhance: true, rendered: res }); setLado("tratado"); }
        } else if (d.status === "error") {
          setJobId(null);
          setErro(d.error ?? "Falha no tratamento");
        }
      } catch { /* rede piscou — a próxima batida resolve */ }
    }, 700);
    return () => { vivo = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const srcTratado = rendered ? comBase(rendered.url) : "";
  const srcOriginal = videoUrl ?? "";

  return (
    <section>
      <div className="fo-sec">
        <div className="t">Tratamento de áudio</div>
        <div className="s">Tira ruído, eco e chiado do ambiente. Sobra a voz — limpa e no volume certo pra plataforma.</div>
      </div>

      {/* ─────────── estado 1: ainda não tratou ─────────── */}
      {!rendered && !rodando && (
        <Card style={{ padding: "28px 24px", textAlign: "center" }}>
          <button onClick={() => tratar()} disabled={!podeTratar} style={btnPrimario}>
            Tratar áudio
          </button>
          <p style={{ fontSize: 12, color: "var(--faint)", margin: "16px 0 0" }}>
            {podeTratar
              ? "Um clique. Dá pra comparar antes e depois — e desfazer."
              : "Abra um vídeo pra tratar o áudio."}
          </p>
        </Card>
      )}

      {/* ─────────── estado 2: processando ─────────── */}
      {rodando && (
        <Card>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
            <strong style={{ fontSize: 13 }}>{etapa || "Processando"}…</strong>
            <span style={{ flex: 1 }} />
            <Pill>{Math.round(prog * 100)}%</Pill>
            <button onClick={cancelar} style={{ fontSize: 12, color: "var(--red)", background: "transparent" }}>
              cancelar
            </button>
          </div>
          {/* mesma barra do painel Exportar (8px, pill, gradiente claro) */}
          <div style={{ height: 8, borderRadius: 999, background: "var(--panel3)", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.round(prog * 100)}%`, borderRadius: 999,
              background: "linear-gradient(90deg, #d9d9d9, #f6f6f6)", transition: "width .3s" }} />
          </div>
          <p style={{ fontSize: 12, color: "var(--faint)", margin: "12px 0 0" }}>
            Pode continuar editando — o painel avisa quando terminar.
          </p>
        </Card>
      )}

      {/* ─────────── estado 3: tratado (A/B + ajustes) ─────────── */}
      {rendered && !rodando && (
        <>
          <Card>
            {/* SEGMENTED do sistema (mesmo do seletor de ferramenta do roteiro):
                moldura só no grupo, ativo em branco com texto escuro. */}
            <div style={{ display: "flex", gap: 2, padding: 3, marginBottom: 12,
              background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12 }}>
              {(["original", "tratado"] as const).map((l) => (
                <button key={l} onClick={() => trocarLado(l)}
                  style={{
                    flex: 1, padding: "7px 12px", fontSize: 13, borderRadius: 10, border: "none", cursor: "pointer",
                    fontWeight: lado === l ? 600 : 400,
                    background: lado === l ? "var(--accent)" : "transparent",
                    color: lado === l ? "#1a1a1a" : "var(--muted)",
                  }}>
                  {l === "original" ? "Original" : "Tratado"}
                </button>
              ))}
            </div>

            <audio ref={playerRef} controls style={{ width: "100%", height: 34 }}
              src={lado === "tratado" ? srcTratado : srcOriginal} />

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              {rendered.lufsAntes != null && (
                <Pill>{rendered.lufsAntes.toFixed(1)} → <strong>{LOUDNESS[cfg.preset].i} LUFS</strong></Pill>
              )}
              <Pill>{LOUDNESS[cfg.preset].label}</Pill>
              {rendered.motor === "local" && <Pill>denoise local</Pill>}
            </div>

            {rendered.motor === "local" && (
              <p style={{ fontSize: 12, color: "var(--muted)", margin: "10px 0 0" }}>
                {rendered.aviso ?? "Rodou o denoise local."} Ele tira chiado constante, mas não tira
                eco nem ruído variável — com o isolamento ligado, o resultado sobe bastante.
                {" "}Resolveu a chave? Use <strong>tratar de novo</strong> abaixo.
              </p>
            )}
          </Card>

          {/* REPROCESSAR do zero. Separado do "aplicar" de propósito: aquele só
              remixa (grátis, instantâneo), este refaz o isolamento (custa e demora).
              É o caminho pra trocar de motor — ex.: depois de liberar o escopo da
              chave — porque o stem fica em cache pela ORIGEM, não pelo motor. */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
            <button onClick={() => tratar(true)} disabled={!podeTratar}
              title="Descarta o resultado e a voz isolada, e processa tudo outra vez"
              style={{ fontSize: 13 }}>
              tratar de novo
            </button>
            <span style={{ fontSize: 12, color: "var(--muted)" }}>
              refaz o isolamento do zero (demora e consome crédito)
            </span>
          </div>

          {desatualizado && (
            <Card>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 13, flex: 1 }}>Os ajustes mudaram.</span>
                <button onClick={() => tratar()}
                  style={{ fontSize: 12, fontWeight: 600, padding: "4px 16px", background: "var(--accent)", color: "#1a1a1a" }}>
                  aplicar
                </button>
              </div>
              <p style={{ fontSize: 12, color: "var(--muted)", margin: "8px 0 0" }}>
                Rápido: a voz isolada já está pronta, refaz só a mixagem e o volume.
              </p>
            </Card>
          )}

          <details style={{ marginTop: 12 }}>
            <summary style={{ fontSize: 13, fontWeight: 600, cursor: "pointer", userSelect: "none" }}>
              Ajustes
            </summary>
            <Card>
              <SliderField label="Força do tratamento" value={cfg.strength}
                display={cfg.strength >= 0.999 ? "só a voz" : `${Math.round(cfg.strength * 100)}%`}
                min={0} max={1} step={0.05} onChange={(v) => patch({ strength: v })} />
              <p style={{ fontSize: 12, color: "var(--muted)", margin: "-4px 0 16px" }}>
                Abaixe pra guardar um respiro do ambiente — útil quando o fundo faz parte da cena.
              </p>

              <label style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>
                Volume final
              </label>
              <select value={cfg.preset} onChange={(e) => patch({ preset: e.target.value as LoudnessPreset })}
                style={{ width: "100%", padding: "8px 10px", fontSize: 13, marginBottom: 4 }}>
                {(Object.keys(LOUDNESS) as LoudnessPreset[]).map((k) => (
                  <option key={k} value={k}>{LOUDNESS[k].label}</option>
                ))}
              </select>
              <p style={{ fontSize: 12, color: "var(--muted)", margin: "6px 0 16px" }}>{LOUDNESS[cfg.preset].hint}</p>

              <SliderField label="De-esser (suaviza os “s”)" value={cfg.deesser}
                display={cfg.deesser < 0.01 ? "desligado" : `${Math.round(cfg.deesser * 100)}%`}
                min={0} max={1} step={0.05} onChange={(v) => patch({ deesser: v })} />
              <SliderField label="Presença" value={cfg.presence} display={`${cfg.presence > 0 ? "+" : ""}${cfg.presence.toFixed(1)} dB`}
                min={0} max={6} step={0.5} onChange={(v) => patch({ presence: v })} />
            </Card>
          </details>

          <button onClick={() => { onChange({ ...cfg, enhance: false }); setLado("tratado"); }}
            style={{ fontSize: 12, color: "var(--faint)", background: "transparent", marginTop: 12 }}>
            desligar o tratamento (volta ao áudio original)
          </button>
        </>
      )}

      {/* Tratamento existente porém desligado — atalho pra religar sem reprocessar. */}
      {!cfg.enhance && cfg.rendered && !rodando && (
        <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 10 }}>
          Já existe um áudio tratado pra este vídeo.{" "}
          <button onClick={() => patch({ enhance: true })} style={{ fontSize: 12 }}>religar</button>
        </p>
      )}

      {semIsolamento && !rendered && (
        <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 10 }}>
          Servidor sem <code>ELEVENLABS_API_KEY</code> — vai rodar o denoise local.
        </p>
      )}
      {erro && <p style={{ color: "var(--red)", fontSize: 12, margin: "10px 0 0" }}>{erro}</p>}
    </section>
  );
}

/**
 * Ação principal — MESMO botão do painel Exportar (o outro painel de "uma ação só").
 * Antes era uma barra branca de largura total com `color: var(--accent-text)` sobre
 * `background: var(--accent)`: dois tons de branco, o texto sumia.
 */
const btnPrimario: React.CSSProperties = {
  background: "linear-gradient(180deg, #f6f6f6, #d9d9d9)", color: "#1a1a1a", border: "none",
  fontWeight: 700, fontSize: 15, padding: "12px 44px", borderRadius: 999,
};
