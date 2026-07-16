import { useEffect, useRef, useState } from "react";
import { ImageSegmenter, FilesetResolver } from "@mediapipe/tasks-vision";

/**
 * Preview do "popup atrás da pessoa": recorta a pessoa do vídeo e desenha só ela
 * (fundo transparente) por cima do popup.
 *
 * Recorte = modelo multiclass do MediaPipe (fundo/cabelo/pele/roupa) +:
 *  - coerência temporal (EMA) → estabiliza no movimento;
 *  - pincel POR COR → você pinta o fundo uma vez e ele sai em TODOS os frames
 *    (aprende a tonalidade e remove por semelhança de cor);
 *  - pincel de ÁREA fixa e restaurar → ajustes pontuais.
 */
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite";
const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";

type Status = "loading" | "ready" | "error";
type BrushMode = "color" | "area" | "restore";
/** Cor em croma (Cb,Cr) — separa matiz do brilho; distingue lilás de pele. */
interface Chroma { cb: number; cr: number; }
const cb = (r: number, g: number, b: number) => -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
const cr = (r: number, g: number, b: number) => 0.5 * r - 0.418688 * g - 0.081312 * b + 128;

export function PersonMatteCanvas({
  video,
  active,
  zoomScale,
  colorSourceRef,
  procScale = 1,
}: {
  video: HTMLVideoElement | null;
  active: boolean;
  zoomScale: number;
  // se fornecido, a pessoa é desenhada a partir do frame JÁ corrigido (cor) — WYSIWYG.
  colorSourceRef?: React.RefObject<HTMLCanvasElement | null>;
  /** P2: fator da resolução do canvas de COMPOSIÇÃO (a máscara já é 256×256 fixa). */
  procScale?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const segmenterRef = useRef<ImageSegmenter | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const sampleRef = useRef<HTMLCanvasElement>(document.createElement("canvas")); // vídeo em baixa res p/ amostrar cor
  const eraseRef = useRef<HTMLCanvasElement>(document.createElement("canvas"));   // pincel de área fixa
  const prevAlphaRef = useRef<Float32Array | null>(null);
  const keyColorsRef = useRef<Chroma[]>([]);
  const lastTsRef = useRef(0);
  const drawingRef = useRef(false);

  const [status, setStatus] = useState<Status>("loading");
  const [feather, setFeather] = useState(2);
  const [stability, setStability] = useState(0.5);
  const [brushOn, setBrushOn] = useState(false);
  const [brushSize, setBrushSize] = useState(2);
  const [brushMode, setBrushMode] = useState<BrushMode>("color");
  const [colorTol, setColorTol] = useState(0.18); // tolerância de cor (0..1)
  const [keyCount, setKeyCount] = useState(0);
  const [cursor, setCursor] = useState<{ x: number; y: number; d: number } | null>(null);

  const featherRef = useRef(feather); featherRef.current = feather;
  const stabRef = useRef(stability); stabRef.current = stability;
  const procRef = useRef(procScale); procRef.current = procScale;
  // holder sempre atual da fonte de cor (evita closure obsoleta no loop do rAF)
  const colorSrcHolder = useRef(colorSourceRef); colorSrcHolder.current = colorSourceRef;
  const tolRef = useRef(colorTol); tolRef.current = colorTol;

  // Carrega o segmentador uma vez (GPU, fallback CPU).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const vision = await FilesetResolver.forVisionTasks(WASM);
      const make = (delegate: "GPU" | "CPU") =>
        ImageSegmenter.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL, delegate },
          runningMode: "VIDEO",
          outputCategoryMask: true,
          outputConfidenceMasks: false,
        });
      let seg: ImageSegmenter;
      try { seg = await make("GPU"); } catch { seg = await make("CPU"); }
      if (cancelled) { seg.close(); return; }
      segmenterRef.current = seg;
      setStatus("ready");
    })().catch((e) => { console.error("MediaPipe matting:", e); if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; segmenterRef.current?.close(); segmenterRef.current = null; };
  }, []);

  // Loop de segmentação enquanto ativo.
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = () => {
      const seg = segmenterRef.current;
      const v = video;
      const out = canvasRef.current;
      if (seg && v && out && v.videoWidth > 0) {
        // P2: compõe na resolução de PREVIEW (procScale); o CSS estica de volta.
        const s = Math.max(0.1, Math.min(1, procRef.current));
        const w = Math.max(2, Math.round((v.videoWidth * s) / 2) * 2);
        const h = Math.max(2, Math.round((v.videoHeight * s) / 2) * 2);
        if (out.width !== w) {
          out.width = w; out.height = h;
          eraseRef.current.width = w; eraseRef.current.height = h;
        }
        const ts = Math.max(lastTsRef.current + 1, Math.round(performance.now()));
        lastTsRef.current = ts;
        try {
          seg.segmentForVideo(v, ts, (result) => {
            const mask = result.categoryMask;
            if (!mask) return;
            const mw = mask.width, mh = mask.height;
            const mc = maskCanvasRef.current;
            if (mc.width !== mw) { mc.width = mw; mc.height = mh; }

            // vídeo em baixa res (= resolução da máscara) p/ ler cor por pixel
            const sc = sampleRef.current;
            if (sc.width !== mw) { sc.width = mw; sc.height = mh; }
            const sctx = sc.getContext("2d", { willReadFrequently: true })!;
            sctx.drawImage(v, 0, 0, mw, mh);
            const sd = sctx.getImageData(0, 0, mw, mh).data;

            const cats = mask.getAsUint8Array();
            const keys = keyColorsRef.current;
            const maxD = tolRef.current * 180; const tol2 = maxD * maxD; // distância em croma (Cb,Cr)

            // coerência temporal (EMA)
            let prev = prevAlphaRef.current;
            if (!prev || prev.length !== cats.length) { prev = new Float32Array(cats.length); prevAlphaRef.current = prev; }
            const k = 1 - stabRef.current;

            const mctx = mc.getContext("2d")!;
            const id = mctx.createImageData(mw, mh);
            for (let i = 0; i < cats.length; i++) {
              let cur = cats[i] === 0 ? 0 : 255; // pessoa vs fundo
              // pincel POR COR: remove pixel cuja cor casa com alguma amostrada
              if (cur > 0 && keys.length) {
                const r = sd[i * 4], g = sd[i * 4 + 1], b = sd[i * 4 + 2];
                const pcb = cb(r, g, b), pcr = cr(r, g, b);
                for (let j = 0; j < keys.length; j++) {
                  const dcb = pcb - keys[j].cb, dcr = pcr - keys[j].cr;
                  if (dcb * dcb + dcr * dcr < tol2) { cur = 0; break; }
                }
              }
              const sm = prev[i] * (1 - k) + cur * k;
              prev[i] = sm;
              id.data[i * 4 + 3] = sm;
            }
            mctx.putImageData(id, 0, 0);
            mask.close();

            const ctx = out.getContext("2d")!;
            ctx.clearRect(0, 0, w, h);
            ctx.globalCompositeOperation = "source-over";
            // desenha a pessoa a partir do frame corrigido (cor), se disponível; senão, do vídeo cru.
            const colorSrc = colorSrcHolder.current?.current;
            const person = colorSrc && colorSrc.width > 0 ? colorSrc : v;
            ctx.drawImage(person, 0, 0, w, h);
            ctx.globalCompositeOperation = "destination-in";
            ctx.filter = featherRef.current > 0 ? `blur(${featherRef.current}px)` : "none";
            ctx.drawImage(mc, 0, 0, w, h);
            ctx.filter = "none";
            // pincel de ÁREA fixa
            ctx.globalCompositeOperation = "destination-out";
            ctx.drawImage(eraseRef.current, 0, 0, w, h);
            ctx.globalCompositeOperation = "source-over";
          });
        } catch (e) { console.error("segmentForVideo:", e); }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); prevAlphaRef.current = null; };
  }, [active, video, status]);

  // Amostra a cor média sob o pincel e a adiciona às "cores de fundo".
  function sampleColorAt(e: React.PointerEvent) {
    const sc = sampleRef.current, c = canvasRef.current;
    if (!c || sc.width === 0) return;
    const rect = c.getBoundingClientRect();
    const sx = Math.round(((e.clientX - rect.left) / rect.width) * sc.width);
    const sy = Math.round(((e.clientY - rect.top) / rect.height) * sc.height);
    const rad = 2;
    const x0 = Math.max(0, sx - rad), y0 = Math.max(0, sy - rad);
    const wpx = Math.min(sc.width - x0, rad * 2 + 1), hpx = Math.min(sc.height - y0, rad * 2 + 1);
    const d = sc.getContext("2d", { willReadFrequently: true })!.getImageData(x0, y0, wpx, hpx).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    if (n === 0) return;
    r /= n; g /= n; b /= n;
    keyColorsRef.current.push({ cb: cb(r, g, b), cr: cr(r, g, b) });
    setKeyCount(keyColorsRef.current.length);
  }

  // Pinta na máscara de ÁREA fixa (remover/restaurar).
  function paintArea(e: React.PointerEvent, restore: boolean) {
    const c = canvasRef.current, er = eraseRef.current;
    if (!c || er.width === 0) return;
    const rect = c.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * er.width;
    const y = ((e.clientY - rect.top) / rect.height) * er.height;
    const r = (brushSize / 100) * er.width;
    const ectx = er.getContext("2d")!;
    ectx.globalCompositeOperation = restore ? "destination-out" : "source-over";
    ectx.fillStyle = "#000";
    ectx.beginPath(); ectx.arc(x, y, r, 0, Math.PI * 2); ectx.fill();
    ectx.globalCompositeOperation = "source-over";
  }

  function paint(e: React.PointerEvent) {
    if (brushMode === "color") sampleColorAt(e);
    else paintArea(e, brushMode === "restore");
  }
  function updateCursor(e: React.PointerEvent) {
    const c = canvasRef.current; if (!c) return;
    const rect = c.getBoundingClientRect();
    setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top, d: 2 * (brushSize / 100) * rect.width });
  }
  function clearArea() { const er = eraseRef.current; er.getContext("2d")!.clearRect(0, 0, er.width, er.height); }
  function clearColors() { keyColorsRef.current = []; setKeyCount(0); }

  if (!active) return null;
  const ringColor = brushMode === "restore" ? "#2ec04a" : brushMode === "color" ? "#3ba9ff" : "#ff3b3b";
  return (
    <>
      <canvas
        ref={canvasRef}
        onPointerDown={(e) => { if (brushOn) { drawingRef.current = true; e.currentTarget.setPointerCapture(e.pointerId); paint(e); updateCursor(e); } }}
        onPointerMove={(e) => { if (brushOn) { updateCursor(e); if (drawingRef.current) paint(e); } }}
        onPointerUp={() => { drawingRef.current = false; }}
        onPointerLeave={() => setCursor(null)}
        style={{
          position: "absolute", inset: 0, width: "100%", height: "100%",
          transform: `scale(${zoomScale})`, transformOrigin: "center center",
          transition: "transform 0.4s ease",
          pointerEvents: brushOn ? "auto" : "none",
          cursor: brushOn ? "crosshair" : "default",
        }}
      />
      {brushOn && cursor && (
        <div style={{
          position: "absolute", left: cursor.x, top: cursor.y, width: cursor.d, height: cursor.d,
          transform: "translate(-50%, -50%)", borderRadius: "50%", pointerEvents: "none",
          border: `2px solid ${ringColor}`, boxShadow: "0 0 0 1px rgba(0,0,0,0.4)",
        }} />
      )}
      {status !== "ready" && (
        <div style={{ position: "absolute", top: 8, left: 8, background: "rgba(0,0,0,0.6)", color: "#fff", fontSize: 11, padding: "2px 8px", borderRadius: 4 }}>
          {status === "loading" ? "carregando recorte…" : "falha ao carregar recorte (veja o console)"}
        </div>
      )}
      {status === "ready" && (
        <div style={{ position: "absolute", top: 8, left: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", maxWidth: "95%",
          background: "rgba(0,0,0,0.62)", color: "#fff", fontSize: 11, padding: "4px 8px", borderRadius: 8, pointerEvents: "auto" }}>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
            borda<input type="range" min={0} max={6} step={0.5} value={feather} onChange={(e) => setFeather(+e.target.value)} />
          </label>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }} title="segura o recorte em movimentos bruscos">
            estab.<input type="range" min={0} max={0.9} step={0.05} value={stability} onChange={(e) => setStability(+e.target.value)} />
          </label>
          <span style={{ width: 1, alignSelf: "stretch", background: "#666" }} />
          <button onClick={() => setBrushOn((v) => !v)} style={{ fontWeight: brushOn ? 700 : 400 }}>🖌 pincel</button>
          {brushOn && (
            <>
              <select value={brushMode} onChange={(e) => setBrushMode(e.target.value as BrushMode)}>
                <option value="color">por cor (todos os frames)</option>
                <option value="area">área fixa</option>
                <option value="restore">restaurar área</option>
              </select>
              {brushMode === "color" ? (
                <>
                  <label style={{ display: "flex", gap: 3, alignItems: "center" }} title="quanto de variação de cor remover junto">
                    tol.<input type="range" min={0.03} max={0.45} step={0.01} value={colorTol} onChange={(e) => setColorTol(+e.target.value)} />
                  </label>
                  <span>{keyCount} cor(es)</span>
                  <button onClick={clearColors}>limpar cores</button>
                </>
              ) : (
                <>
                  <label style={{ display: "flex", gap: 3, alignItems: "center" }}>
                    tam<input type="range" min={0.3} max={12} step={0.1} value={brushSize} onChange={(e) => setBrushSize(+e.target.value)} />
                  </label>
                  <button onClick={clearArea}>limpar área</button>
                </>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
