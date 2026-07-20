import { comBase } from '../../os-session';
import { useEffect, useRef, useState } from "react";
import type { Music } from "../../../../shared/timeline";
import { Card, Pill, SliderField, UploadCard } from "../../workspace/ui";

const fmt = (t: number) => `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, "0")}`;

/**
 * Música de fundo — visual-first: sem música = card de upload; com música = player
 * + volume + trecho em dois sliders. O trecho entra em loop sob a fala no export.
 */
export function MusicPanel({ music, onChange }: { music: Music | undefined; onChange: (m: Music | undefined) => void }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dur, setDur] = useState(0); // duração da faixa (do player)
  const start = music?.start ?? 0;
  const end = music?.end ?? dur;

  // "Ouvir trecho": toca só [start, end] no player e reinicia ao chegar no fim.
  const [previewSeg, setPreviewSeg] = useState(false);
  useEffect(() => {
    const a = audioRef.current; if (!a || !previewSeg) return;
    const onTime = () => { if (a.currentTime >= (music?.end ?? dur) - 0.02) a.currentTime = music?.start ?? 0; };
    a.addEventListener("timeupdate", onTime);
    return () => a.removeEventListener("timeupdate", onTime);
  }, [previewSeg, music?.start, music?.end, dur]);

  function ouvirTrecho() {
    const a = audioRef.current; if (!a) return;
    a.currentTime = start; setPreviewSeg(true); a.play().catch(() => {});
  }

  async function pick(file: File) {
    setBusy(true); setError(null);
    try {
      const form = new FormData();
      form.append("music", file);
      const r = await fetch(comBase("/api/music"), { method: "POST", body: form });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Falha ao subir a música");
      onChange({ file: d.url, volume: music?.volume ?? 0.15 });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <section>
      <div className="fo-sec">
        <div className="t">Música de fundo</div>
        <div className="s">Entra em loop sob a fala — o volume baixo deixa a voz na frente.</div>
      </div>

      {!music ? (
        <UploadCard label={busy ? "Subindo…" : "Adicionar música"} hint="MP3, WAV, M4A…" accept="audio/*" onPick={pick} />
      ) : (
        <Card>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
            <audio ref={audioRef} src={music.file} controls style={{ height: 34, flex: 1, minWidth: 220 }}
              onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
              onPause={() => setPreviewSeg(false)} />
            <button onClick={() => onChange(undefined)} style={{ fontSize: 12, color: "var(--red)", background: "transparent" }}>
              remover
            </button>
          </div>

          <SliderField label="Volume sob a fala" value={music.volume ?? 0.15}
            display={`${Math.round((music.volume ?? 0.15) * 100)}%`}
            min={0} max={1} step={0.01} onChange={(v) => onChange({ ...music, volume: v })} />

          {dur > 0 && (
            <>
              <hr className="fo-divider" style={{ margin: "16px 0" }} />
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
                <Pill><strong>{fmt(start)}</strong>&nbsp;→&nbsp;<strong>{fmt(end)}</strong></Pill>
                <Pill>{fmt(Math.max(0, end - start))} de loop</Pill>
                <button onClick={ouvirTrecho} style={{ fontSize: 12 }}>▶ ouvir trecho</button>
                {(music.start || music.end != null) && (
                  <button onClick={() => onChange({ ...music, start: undefined, end: undefined })}
                    style={{ fontSize: 12, color: "var(--faint)", background: "transparent" }}>
                    faixa inteira
                  </button>
                )}
              </div>
              <div className="fo-row">
                <div>
                  <SliderField label="Começa em" value={start} display={fmt(start)} min={0} max={dur} step={0.1}
                    onChange={(v) => onChange({ ...music, start: Math.min(v, end - 0.5) })} />
                  <button style={{ fontSize: 11, padding: "3px 12px" }} title="marcar no ponto atual do player"
                    onClick={() => audioRef.current && onChange({ ...music, start: Math.min(audioRef.current.currentTime, end - 0.5) })}>
                    marcar no player
                  </button>
                </div>
                <div>
                  <SliderField label="Termina em" value={end} display={fmt(end)} min={0} max={dur} step={0.1}
                    onChange={(v) => onChange({ ...music, end: Math.max(v, start + 0.5) })} />
                  <button style={{ fontSize: 11, padding: "3px 12px" }} title="marcar no ponto atual do player"
                    onClick={() => audioRef.current && onChange({ ...music, end: Math.max(audioRef.current.currentTime, start + 0.5) })}>
                    marcar no player
                  </button>
                </div>
              </div>
            </>
          )}
        </Card>
      )}
      {error && <p style={{ color: "var(--red)", fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
    </section>
  );
}
