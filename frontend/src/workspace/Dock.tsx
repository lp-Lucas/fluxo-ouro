import { useEffect, useState, type ReactNode } from "react";

/**
 * DOCK EM ABAS (estilo Adobe/abas de navegador): as etapas viram uma faixa
 * HORIZONTAL de abas; uma ativa por vez, o conteúdo preenche o resto da coluna.
 * As abas são REALOCÁVEIS (arrasta pra reordenar) e a ordem + aba ativa
 * persistem no localStorage. Painéis inativos ficam MONTADOS (display:none) —
 * jobs em andamento (FLOW, export) não são perdidos ao trocar de aba.
 */

export interface DockPanelDef {
  id: string;
  title: string;
  icon?: string;
  node: ReactNode;
  /** compat (modo gavetas antigo) — ignorado nas abas */
  startCollapsed?: boolean;
}

const load = <T,>(key: string, fallback: T): T => {
  try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : fallback; }
  catch { return fallback; }
};

export function Dock({ panels, storageKey = "fluxo-dock" }: { panels: DockPanelDef[]; storageKey?: string }) {
  const [order, setOrder] = useState<string[]>(() => load(`${storageKey}:order`, []));
  const [active, setActive] = useState<string>(() => load(`${storageKey}:active`, panels[0]?.id ?? ""));
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  useEffect(() => { localStorage.setItem(`${storageKey}:order`, JSON.stringify(order)); }, [order, storageKey]);
  useEffect(() => { localStorage.setItem(`${storageKey}:active`, JSON.stringify(active)); }, [active, storageKey]);

  // ordem efetiva: a salva (ids existentes) + novos no fim
  const known = new Set(panels.map((p) => p.id));
  const ordered = [
    ...order.filter((id) => known.has(id)),
    ...panels.map((p) => p.id).filter((id) => !order.includes(id)),
  ].map((id) => panels.find((p) => p.id === id)!);

  const activeId = known.has(active) ? active : ordered[0]?.id;

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) { setDragId(null); setOverId(null); return; }
    const ids = ordered.map((p) => p.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    setOrder(ids);
    setDragId(null); setOverId(null);
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
      {/* faixa de abas */}
      <div role="tablist" style={{ display: "flex", gap: 2, alignItems: "flex-end", overflowX: "auto", paddingTop: 2 }}>
        {ordered.map((p) => {
          const isActive = p.id === activeId;
          const isOver = overId === p.id && dragId !== p.id;
          return (
            <button key={p.id} role="tab" aria-selected={isActive} className="fo-tab"
              draggable
              onDragStart={(e) => { setDragId(p.id); e.dataTransfer.effectAllowed = "move"; }}
              onDragEnd={() => { setDragId(null); setOverId(null); }}
              onDragOver={(e) => { e.preventDefault(); setOverId(p.id); }}
              onDragLeave={() => setOverId((o) => (o === p.id ? null : o))}
              onDrop={(e) => { e.preventDefault(); drop(p.id); }}
              onClick={() => setActive(p.id)}
              title="clique pra abrir · arraste pra realocar"
              style={{
                border: "none", borderRadius: "12px 12px 0 0", padding: "8px 20px", minHeight: 40,
                fontSize: 13, whiteSpace: "nowrap", cursor: "pointer", userSelect: "none",
                background: isActive ? "var(--panel)" : "transparent",
                color: isActive ? "var(--text)" : "var(--muted)",
                fontWeight: isActive ? 600 : 400,
                outline: isOver ? "1px solid var(--accent-text)" : "none",
                opacity: dragId === p.id ? 0.5 : 1,
              }}>
              {p.title}
            </button>
          );
        })}
      </div>

      {/* conteúdo — todos montados, só o ativo visível (jobs seguem vivos) */}
      <div style={{
        flex: 1, minHeight: 0, background: "var(--panel)", border: "1px solid var(--border)",
        borderRadius: "0 12px 12px 12px",
      }}>
        {ordered.map((p) => (
          <div key={p.id} className="dock-body"
            style={{ display: p.id === activeId ? "block" : "none", height: "100%", overflowY: "auto", padding: 24 }}>
            {p.node}
          </div>
        ))}
      </div>
    </div>
  );
}
