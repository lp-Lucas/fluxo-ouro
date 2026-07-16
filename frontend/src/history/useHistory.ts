import { useCallback, useState } from "react";

/**
 * Histórico genérico de um estado (undo/redo) para todo o sistema.
 *
 * Coalescência: alterações em sequência rápida (< 500ms, ex: arrastar um slider
 * ou digitar) contam como UM passo de desfazer — senão cada tique viraria um
 * undo. Ações espaçadas viram passos separados.
 */
interface Internal<T> {
  present: T;
  past: T[];
  future: T[];
  lastTs: number;
}

const LIMIT = 100;

export function useHistory<T>(initial: T) {
  const [s, setS] = useState<Internal<T>>({ present: initial, past: [], future: [], lastTs: 0 });

  const set = useCallback((updater: T | ((prev: T) => T)) => {
    setS((cur) => {
      const next = typeof updater === "function" ? (updater as (p: T) => T)(cur.present) : updater;
      if (Object.is(next, cur.present)) return cur;
      const now = Date.now();
      // coalesce: substitui o topo sem criar novo passo
      if (cur.past.length > 0 && now - cur.lastTs < 500) {
        return { ...cur, present: next, future: [], lastTs: now };
      }
      return {
        present: next,
        past: [...cur.past, cur.present].slice(-LIMIT),
        future: [],
        lastTs: now,
      };
    });
  }, []);

  const undo = useCallback(() => {
    setS((cur) => {
      if (cur.past.length === 0) return cur;
      const past = cur.past.slice();
      const prev = past.pop()!;
      return { present: prev, past, future: [cur.present, ...cur.future], lastTs: 0 };
    });
  }, []);

  const redo = useCallback(() => {
    setS((cur) => {
      if (cur.future.length === 0) return cur;
      const [next, ...rest] = cur.future;
      return { present: next, past: [...cur.past, cur.present], future: rest, lastTs: 0 };
    });
  }, []);

  // Reinicia o histórico com um novo estado (usado ao ABRIR um projeto):
  // vira o presente e limpa passado/futuro — o primeiro undo não "volta pro vazio".
  const reset = useCallback((next: T) => {
    setS({ present: next, past: [], future: [], lastTs: 0 });
  }, []);

  return {
    state: s.present,
    set,
    reset,
    undo,
    redo,
    canUndo: s.past.length > 0,
    canRedo: s.future.length > 0,
  };
}
