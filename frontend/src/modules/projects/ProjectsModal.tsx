import { comBase } from '../../os-session';
import { useEffect, useState } from "react";
import type { ProjectMeta } from "../../../../shared/project";

/**
 * Tela inicial de projetos. Cada projeto é um CARD 3:4 (referência product-card):
 * preview do vídeo (thumb) de fundo, BLUR PROGRESSIVO na base, nome centrado e
 * botão "Editar" de vidro. Hover: lift + scale + sombra profunda.
 */
export function ProjectsModal({
  onOpen,
  onCreate,
  busy,
}: {
  onOpen: (id: string) => void;
  onCreate: (name: string, video: File) => void;
  busy: string | null; // mensagem de progresso (ex: "Transcrevendo…") ou null
}) {
  const [metas, setMetas] = useState<ProjectMeta[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [novoNome, setNovoNome] = useState("");
  const [novoVideo, setNovoVideo] = useState<File | null>(null);

  async function recarregar() {
    setErro(null);
    try {
      const r = await fetch(comBase("/api/projects"));
      const data = await r.json().catch(() => null);
      // Defesa: uma resposta que NAO seja lista (401 -> {error}, 500, HTML) nao pode virar
      // metas — o metas.map() abaixo quebraria o app INTEIRO (tela preta). Mostra o erro.
      if (!r.ok || !Array.isArray(data)) {
        const msg = (data && (data as { error?: string }).error) || `servidor respondeu HTTP ${r.status}`;
        setMetas([]);
        throw new Error(msg);
      }
      setMetas(data);
    } catch (e) { setMetas([]); setErro((e as Error).message); }
  }
  useEffect(() => { recarregar(); }, []);

  async function renomear(m: ProjectMeta) {
    const nome = prompt("Novo nome do projeto:", m.name);
    if (!nome?.trim()) return;
    await fetch(comBase(`/api/projects/${m.id}`), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: nome.trim() }) });
    recarregar();
  }
  async function excluir(m: ProjectMeta) {
    if (!confirm(`Excluir "${m.name}"? Esta ação é irreversível.`)) return;
    await fetch(comBase(`/api/projects/${m.id}`), { method: "DELETE" });
    recarregar();
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", display: "grid", placeItems: "center", zIndex: 1000 }}>
      <style>{`
        .pj-card {
          position: relative;
          aspect-ratio: 3 / 4;
          border-radius: 28px;
          overflow: hidden;
          background: var(--panel2);
          box-shadow: 0 24px 48px rgba(0, 0, 0, 0.5), 0 4px 12px rgba(0, 0, 0, 0.3);
          transition: transform 0.3s ease, box-shadow 0.3s ease;
          cursor: pointer;
        }
        .pj-card:hover {
          transform: translateY(-6px) scale(1.015);
          box-shadow: 0 32px 64px rgba(0, 0, 0, 0.55), 0 8px 20px rgba(0, 0, 0, 0.35);
        }
        .pj-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
        /* blur progressivo: fraco no topo da faixa, forte na base */
        .pj-blur { position: absolute; left: 0; right: 0; bottom: 0; height: 52%; pointer-events: none; }
        .pj-blur > div { position: absolute; inset: 0; }
        .pj-blur .b1 { backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px);
          mask: linear-gradient(to bottom, transparent 0%, #000 30%, #000 100%);
          -webkit-mask: linear-gradient(to bottom, transparent 0%, #000 30%, #000 100%); }
        .pj-blur .b2 { backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px);
          mask: linear-gradient(to bottom, transparent 25%, #000 55%, #000 100%);
          -webkit-mask: linear-gradient(to bottom, transparent 25%, #000 55%, #000 100%); }
        .pj-blur .b3 { backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
          mask: linear-gradient(to bottom, transparent 45%, #000 75%, #000 100%);
          -webkit-mask: linear-gradient(to bottom, transparent 45%, #000 75%, #000 100%); }
        .pj-blur .b4 { backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
          mask: linear-gradient(to bottom, transparent 65%, #000 90%, #000 100%);
          -webkit-mask: linear-gradient(to bottom, transparent 65%, #000 90%, #000 100%); }
        .pj-blur .tint { background: linear-gradient(to bottom, transparent 0%, rgba(10, 10, 12, 0.2) 50%, rgba(10, 10, 12, 0.45) 100%); }
        .pj-content { position: absolute; left: 0; right: 0; bottom: 0; padding: 0 14px 14px; text-align: center; }
        .pj-name { font-size: 14px; font-weight: 600; color: #fff; line-height: 1.35; text-shadow: 0 1px 8px rgba(0,0,0,0.35); margin-bottom: 3px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .pj-date { font-size: 10.5px; color: rgba(255,255,255,0.65); margin-bottom: 10px; }
        .pj-edit {
          width: 100%; padding: 12px 0; border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.25);
          background: rgba(255, 255, 255, 0.16);
          backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
          color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
          transition: background 0.2s ease, transform 0.2s ease;
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.25);
        }
        .pj-edit:hover { background: rgba(255, 255, 255, 0.26) !important; }
        .pj-edit:active { transform: scale(0.97); }
        /* ações (renomear/excluir) — aparecem no hover, canto superior direito */
        .pj-actions { position: absolute; top: 12px; right: 12px; display: flex; gap: 8px; opacity: 0; transition: opacity 0.2s ease; }
        .pj-card:hover .pj-actions { opacity: 1; }
        .pj-actions button {
          width: 28px; height: 28px; padding: 0; border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.25); background: rgba(0,0,0,0.35);
          backdrop-filter: blur(6px); color: #fff; font-size: 12px;
          display: grid; place-items: center;
        }
        .pj-actions button:hover { background: rgba(0,0,0,0.55) !important; }
      `}</style>

      <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 16, padding: "28px 28px 32px", width: 860, maxWidth: "94vw", maxHeight: "88vh", overflow: "auto" }}>
        <div className="fo-sec">
          <img src="/logo.svg" alt="Studio" style={{ height: 34, width: "auto", display: "block", marginBottom: 4 }} />
          <div className="s">Abra um projeto ou crie um novo.</div>
        </div>

        {busy && <p style={{ color: "var(--green)", fontSize: 13 }}>{busy}</p>}

        {/* Novo projeto */}
        <div style={{ background: "var(--panel2)", border: "1px solid var(--border)", borderRadius: 16, padding: "20px 16px", marginBottom: 24 }}>
          <div className="fo-row" style={{ marginBottom: 12 }}>
            <div className="fo-field">
              <label>Nome do projeto</label>
              <input placeholder="Ex. Vídeo de lançamento" value={novoNome} onChange={(e) => setNovoNome(e.target.value)} />
            </div>
            <div className="fo-field">
              <label>Vídeo</label>
              <input type="file" accept="video/*" onChange={(e) => setNovoVideo(e.target.files?.[0] ?? null)} />
            </div>
          </div>
          <button disabled={!novoNome.trim() || !novoVideo || !!busy}
            onClick={() => novoVideo && onCreate(novoNome.trim(), novoVideo)}
            style={{ background: "var(--accent)", color: "#1a1a1a", fontWeight: 600 }}>
            Criar e abrir
          </button>
        </div>

        {/* Lista */}
        {erro && <p style={{ color: "var(--red)" }}>Erro: {erro}</p>}
        {!metas && !erro && <p style={{ color: "var(--muted)" }}>Carregando…</p>}
        {metas && metas.length === 0 && <p style={{ color: "var(--muted)" }}>Nenhum projeto ainda.</p>}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 20 }}>
          {metas?.map((m) => (
            <article key={m.id} className="pj-card" onClick={() => !busy && onOpen(m.id)}>
              {/* preview do vídeo (frame gerado no save) */}
              <img className="pj-bg" src={comBase(`/projects/${m.id}/thumb.jpg`)} alt=""
                onError={(e) => (e.currentTarget.style.display = "none")} />

              <div className="pj-blur">
                <div className="b1" /><div className="b2" /><div className="b3" /><div className="b4" /><div className="tint" />
              </div>

              <div className="pj-actions">
                <button title="renomear" onClick={(e) => { e.stopPropagation(); renomear(m); }}>✎</button>
                <button title="excluir" onClick={(e) => { e.stopPropagation(); excluir(m); }}>×</button>
              </div>

              <div className="pj-content">
                <div className="pj-name">{m.name}</div>
                <div className="pj-date">{new Date(m.updatedAt).toLocaleDateString("pt-BR")}</div>
                <button className="pj-edit" onClick={(e) => { e.stopPropagation(); if (!busy) onOpen(m.id); }}>
                  Editar
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
