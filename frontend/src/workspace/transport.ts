/**
 * PONTE DE TRANSPORTE: liga o <video> (dentro do preview) à TIMELINE FIXA (barra
 * inferior do app) sem re-renderizar o App a cada frame. O preview publica
 * time/duration/playing; a timeline assina; seek/toggle são funções atribuídas
 * pelo preview e chamadas pela timeline.
 */

export interface TransportState {
  time: number;
  duration: number;
  playing: boolean;
}

export class TransportBus {
  state: TransportState = { time: 0, duration: 0, playing: false };
  /** atribuídos pelo preview quando o vídeo monta */
  seek: (t: number) => void = () => {};
  toggle: () => void = () => {};

  private subs = new Set<(s: TransportState) => void>();

  publish(s: TransportState) {
    this.state = s;
    this.subs.forEach((f) => f(s));
  }
  subscribe(f: (s: TransportState) => void): () => void {
    this.subs.add(f);
    return () => { this.subs.delete(f); };
  }
}
