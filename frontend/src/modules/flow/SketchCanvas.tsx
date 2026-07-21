import { useCallback, useRef } from "react";
import { Tldraw, type Editor, getSnapshot, loadSnapshot } from "tldraw";
import "tldraw/tldraw.css";
import type { FlowAspect } from "../../../../shared/flow";

/**
 * CANVAS DE ESBOÇO (opção "Esboço" da geração de telas): o usuário desenha o BLUEPRINT da
 * tela — posição dos elementos, texto, escala, espaço negativo. O tldraw entrega o MVP
 * pronto (lápis, borracha, seleção/mover/redimensionar, texto, formas, undo/redo, cores,
 * zoom+pan, grid+snap, frames, duplicar Ctrl+D, export). Nós adicionamos: o ARTBOARD na
 * proporção da tela, persistência do snapshot na frase, e o export PNG que vira a
 * restrição GEOMÉTRICA do gerador (modo "esboco" do compilador).
 */

const DIMS: Record<FlowAspect, { w: number; h: number }> = {
  "9:16": { w: 540, h: 960 },
  "16:9": { w: 960, h: 540 },
  "1:1": { w: 720, h: 720 },
};

export function SketchCanvas({ aspect, snapshot, onUse, onClose }: {
  aspect: FlowAspect;
  /** snapshot salvo na frase (tldraw JSON) — reabre o esboço onde parou. */
  snapshot?: string;
  /** "Usar esboço": PNG do artboard (dataURL) + snapshot p/ persistir. */
  onUse: (png: string, snapshot: string) => void;
  onClose: () => void;
}) {
  const editorRef = useRef<Editor | null>(null);

  const onMount = useCallback((editor: Editor) => {
    editorRef.current = editor;
    if (snapshot) {
      try { loadSnapshot(editor.store, JSON.parse(snapshot)); } catch { /* snapshot velho/inválido — canvas limpo */ }
    }
    // ARTBOARD: um frame na proporção da tela (o export recorta ele). Cria só se não existe.
    const temFrame = editor.getCurrentPageShapes().some((s) => s.type === "frame");
    if (!temFrame) {
      const d = DIMS[aspect];
      editor.createShape({ type: "frame", x: 0, y: 0, props: { w: d.w, h: d.h, name: `tela ${aspect}` } });
    }
    editor.updateInstanceState({ isGridMode: true }); // grid + snap: essencial p/ layout de UI
    editor.zoomToFit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function usar() {
    const editor = editorRef.current; if (!editor) return;
    const frame = editor.getCurrentPageShapes().find((s) => s.type === "frame");
    const ids = frame ? [frame.id] : editor.getCurrentPageShapes().map((s) => s.id);
    if (ids.length === 0) { alert("Desenhe algo no esboço antes de usar."); return; }
    const { blob } = await editor.toImage(ids, { format: "png", background: true, scale: 2 });
    const png = await new Promise<string>((res) => {
      const r = new FileReader(); r.onload = () => res(r.result as string); r.readAsDataURL(blob);
    });
    onUse(png, JSON.stringify(getSnapshot(editor.store)));
  }

  return (
    // stopPropagation: o canvas e' filho (no DOM) do painel de design, que fecha no clique de
    // fora. Sem isto, cada clique/desenho no tldraw borbulha pro onClick de fechar do pai e o
    // canvas some "do nada". Fechar so pelos botoes Usar/Fechar.
    <div onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, zIndex: 950, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ width: "min(1400px, 97vw)", height: "94vh", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 16, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "var(--panel)", borderBottom: "1px solid var(--border)" }}>
          <strong style={{ fontSize: 14 }}>Esboço — blueprint da tela</strong>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            desenhe ONDE cada coisa fica (posição/escala/texto) — o estilo vem da referência, não daqui · grid ligado · Ctrl+D duplica
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={usar} style={{ background: "var(--accent)", color: "#1a1a1a", fontWeight: 600, fontSize: 13, padding: "8px 20px", borderRadius: 12, border: "none", cursor: "pointer" }}>
            Usar esboço
          </button>
          <button onClick={onClose} style={{ fontSize: 13, padding: "8px 16px", borderRadius: 12 }}>Fechar</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
          <Tldraw onMount={onMount} />
        </div>
      </div>
    </div>
  );
}
