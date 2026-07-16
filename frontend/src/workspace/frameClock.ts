import { useEffect, useState } from "react";

/**
 * RELÓGIO DE FRAME (P1 da fluidez): o tempo do preview deixa de ser estado do React no
 * componente-pai (que re-renderizava a árvore INTEIRA a 60fps) e vira um barramento
 * imperativo. Só as FOLHAS que realmente animam por tempo (legenda, popups, playhead)
 * assinam — e re-renderizam sozinhas, pequenas. O pai fica parado.
 */
export interface FrameClockLike {
  readonly time: number;
  subscribe(f: (t: number) => void): () => void;
}

export class FrameClock implements FrameClockLike {
  time = 0;
  private subs = new Set<(t: number) => void>();
  publish(t: number) {
    this.time = t;
    this.subs.forEach((f) => f(t));
  }
  subscribe(f: (t: number) => void): () => void {
    this.subs.add(f);
    return () => { this.subs.delete(f); };
  }
}

/** Hook das FOLHAS: re-renderiza o componente a cada frame publicado (use em subtrees pequenas). */
export function useFrameTime(clock: FrameClockLike): number {
  const [t, setT] = useState(clock.time);
  useEffect(() => clock.subscribe(setT), [clock]);
  return t;
}
