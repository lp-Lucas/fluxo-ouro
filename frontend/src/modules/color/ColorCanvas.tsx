import { useEffect, useRef } from "react";
import type { ColorSettings } from "../../../../shared/color";
import type { ChromaSettings } from "../../../../shared/chroma";
import type { ParsedLut } from "../../../../shared/lut";

/**
 * Processamento de vídeo via WebGL2. Ordem (idêntica ao export):
 *   keying (alpha) → despill → composição sobre o fundo → correção de cor/LUT.
 * Só monta quando há cor OU chroma ativos (bypass total = vídeo direto).
 *
 * Fórmulas de keying/despill: ver shared/chroma.ts (mesmas do ffmpeg no export).
 */
const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main(){
  vUv = vec2(aPos.x * 0.5 + 0.5, 1.0 - (aPos.y * 0.5 + 0.5));
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uFrame;
uniform highp sampler3D uLut;
uniform sampler2D uBg;
// cor
uniform float uBrightness, uContrast, uGamma, uSaturation, uLutIntensity;
uniform bool uHasLut;
// chroma
uniform bool uChroma, uShowMask;
uniform int uMode;      // 0=composto 1=fundo 2=pessoa(transparente)
uniform vec3 uKeyRGB;
uniform float uSimilarity, uSmoothness, uDespill, uBgClip, uFgClip;
uniform int uKeyChan;   // 0=R 1=G 2=B (canal da cor-chave, p/ despill)
uniform int uBgType;    // 0=cor 1=imagem 2=vídeo 3=nenhum(preto)
uniform vec3 uBgColor;
uniform vec2 uDstRes, uBgRes;
uniform bool uBgCover;
in vec2 vUv;
out vec4 frag;
const vec3 LW = vec3(0.2126, 0.7152, 0.0722);

// RGB→(U,V) BT.601 normalizado 0..1 (Cb, Cr). O chromakey do ffmpeg calcula a
// cor-chave e o croma internamente em BT.601 (coef. fixos 0.299/0.587/0.114) →
// o keying usa 601 dos DOIS lados (validado por chroma-parity). NÃO é o LW (709)
// da correção de cor, que é outra etapa.
vec2 rgb2uv(vec3 c){
  float y = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  return vec2((c.b - y) / 1.772 + 0.5, (c.r - y) / 1.402 + 0.5);
}

// UV do fundo com ajuste cover/contain.
vec2 bgUV(vec2 uv){
  vec2 s = uDstRes / uBgRes;
  float scale = uBgCover ? max(s.x, s.y) : min(s.x, s.y);
  vec2 scaled = uBgRes * scale;
  vec2 off = (scaled - uDstRes) * 0.5;
  return (uv * uDstRes + off) / scaled;
}

// Correção de cor (mesma dos dois lados). Aplicada no fim, sobre c.
vec3 corrige(vec3 c){
  c = (c - 0.5) * uContrast + 0.5;
  c = c + uBrightness;
  c = clamp(c, 0.0, 1.0);
  c = pow(c, vec3(1.0 / uGamma));
  float luma = dot(c, LW);
  c = mix(vec3(luma), c, uSaturation);
  c = clamp(c, 0.0, 1.0);
  if (uHasLut) { c = mix(c, texture(uLut, c).rgb, uLutIntensity); }
  return c;
}

void main(){
  vec3 c = texture(uFrame, vUv).rgb;

  // ── keying + despill + composição ──
  if (uChroma) {
    // MODO FUNDO: só o fundo (colorido), sem keying — camada de baixo.
    if (uMode == 1) {
      vec3 bg = uBgType == 0 ? uBgColor
        : (uBgType == 1 || uBgType == 2) ? texture(uBg, bgUV(vUv)).rgb
        : vec3(0.0);
      frag = vec4(corrige(bg), 1.0);
      return;
    }

    // alpha pela distância no plano UV à cor-chave (similarity/smoothness)
    float diff = length(rgb2uv(c) - rgb2uv(uKeyRGB)) / 1.41421356;
    float alpha = clamp((diff - uSimilarity) / max(uSmoothness, 1e-4), 0.0, 1.0);
    // clip: remapeia [bgClip..fgClip] → [0..1] (sujeito sólido / limpa fundo)
    alpha = clamp((alpha - uBgClip) / max(uFgClip - uBgClip, 1e-4), 0.0, 1.0);

    if (uShowMask) { frag = vec4(vec3(alpha), 1.0); return; } // visualizar a máscara

    // despill: reduz o excesso do canal da cor-chave (contaminação)
    if (uDespill > 0.0) {
      if (uKeyChan == 1) { float m = (c.r + c.b) * 0.5; if (c.g > m) c.g = mix(c.g, m, uDespill); }
      else if (uKeyChan == 2) { float m = (c.r + c.g) * 0.5; if (c.b > m) c.b = mix(c.b, m, uDespill); }
      else { float m = (c.g + c.b) * 0.5; if (c.r > m) c.r = mix(c.r, m, uDespill); }
    }

    // MODO PESSOA: pessoa colorida com o alpha do keying (transparente) — camada de cima.
    if (uMode == 2) {
      vec3 cc = corrige(c);
      frag = vec4(cc * alpha, alpha); // premultiplicado (compõe sobre o DOM abaixo)
      return;
    }

    // MODO COMPOSTO: pessoa sobre o fundo, cor por último (sobre o composto).
    vec3 bg = uBgType == 0 ? uBgColor
      : (uBgType == 1 || uBgType == 2) ? texture(uBg, bgUV(vUv)).rgb
      : vec3(0.0);
    c = mix(bg, c, alpha);
  }

  frag = vec4(corrige(c), 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error("shader: " + gl.getShaderInfoLog(sh));
  return sh;
}

const hexToRgb01 = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
};

export function ColorCanvas({
  video, color, lut, zoomScale, canvasRefOut,
  chroma, bgImage, bgVideo, showMask = false, mode = "composite", procScale = 1,
}: {
  video: HTMLVideoElement | null;
  color: ColorSettings;
  lut: ParsedLut | null;
  zoomScale: number;
  canvasRefOut?: React.MutableRefObject<HTMLCanvasElement | null>;
  chroma: ChromaSettings;
  bgImage?: HTMLImageElement | null; // fundo imagem
  bgVideo?: HTMLVideoElement | null; // fundo vídeo (loop)
  showMask?: boolean;                // ver a máscara (só preview)
  mode?: "composite" | "background" | "person"; // camadas do chroma
  /** P2 (qualidade do preview): fator da resolução de PROCESSAMENTO (1, 0.5, 0.25…).
   *  Reduz o alvo do shader (4×/16× menos pixels); o CSS estica de volta. Export não usa. */
  procScale?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<WebGL2RenderingContext | null>(null);
  const progRef = useRef<WebGLProgram | null>(null);
  const frameTexRef = useRef<WebGLTexture | null>(null);
  const lutTexRef = useRef<WebGLTexture | null>(null);
  const bgTexRef = useRef<WebGLTexture | null>(null);
  const colorRef = useRef(color); colorRef.current = color;
  const lutRef = useRef(lut); lutRef.current = lut;
  const chromaRef = useRef(chroma); chromaRef.current = chroma;
  const bgImgRef = useRef(bgImage); bgImgRef.current = bgImage;
  const bgVidRef = useRef(bgVideo); bgVidRef.current = bgVideo;
  const maskRef = useRef(showMask); maskRef.current = showMask;
  const modeRef = useRef(mode); modeRef.current = mode;
  const procRef = useRef(procScale); procRef.current = procScale;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true });
    if (!gl) { console.error("WebGL2 indisponível — processamento de vídeo desligado"); return; }
    glRef.current = gl;

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.error("link:", gl.getProgramInfoLog(prog)); return; }
    gl.useProgram(prog);
    progRef.current = prog;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const mkTex2D = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return t;
    };
    frameTexRef.current = mkTex2D();
    bgTexRef.current = mkTex2D();

    gl.uniform1i(gl.getUniformLocation(prog, "uFrame"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "uLut"), 1);
    gl.uniform1i(gl.getUniformLocation(prog, "uBg"), 2);
    if (canvasRefOut) canvasRefOut.current = canvas;

    return () => {
      gl.deleteProgram(prog);
      [frameTexRef, lutTexRef, bgTexRef].forEach((r) => r.current && gl.deleteTexture(r.current));
      if (canvasRefOut) canvasRefOut.current = null;
    };
  }, []);

  // LUT como textura 3D (RGB8, trilinear).
  useEffect(() => {
    const gl = glRef.current;
    if (!gl) return;
    if (lutTexRef.current) { gl.deleteTexture(lutTexRef.current); lutTexRef.current = null; }
    if (!lut) return;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    const bytes = new Uint8Array(lut.data.length);
    for (let i = 0; i < lut.data.length; i++) bytes[i] = Math.max(0, Math.min(255, Math.round(lut.data[i] * 255)));
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, lut.size, lut.size, lut.size, 0, gl.RGB, gl.UNSIGNED_BYTE, bytes);
    lutTexRef.current = tex;
  }, [lut]);

  useEffect(() => {
    let raf = 0;
    const U = (n: string) => glRef.current!.getUniformLocation(progRef.current!, n);
    const tick = () => {
      const gl = glRef.current, prog = progRef.current, v = video, canvas = canvasRef.current;
      if (gl && prog && v && canvas && v.videoWidth > 0) {
        // P2: alvo do shader na resolução de PREVIEW (procScale); o CSS estica de volta.
        const s = Math.max(0.1, Math.min(1, procRef.current));
        const tw = Math.max(2, Math.round((v.videoWidth * s) / 2) * 2);
        const th = Math.max(2, Math.round((v.videoHeight * s) / 2) * 2);
        if (canvas.width !== tw || canvas.height !== th) { canvas.width = tw; canvas.height = th; }
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(prog);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, frameTexRef.current);
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, v); } catch { /* frame não pronto */ }

        // cor
        const b = colorRef.current.basic;
        gl.uniform1f(U("uBrightness"), b.brightness); gl.uniform1f(U("uContrast"), b.contrast);
        gl.uniform1f(U("uGamma"), b.gamma); gl.uniform1f(U("uSaturation"), b.saturation);
        const hasLut = !!lutRef.current && !!colorRef.current.lut && colorRef.current.lut.intensity > 0;
        gl.uniform1i(U("uHasLut"), hasLut ? 1 : 0);
        gl.uniform1f(U("uLutIntensity"), colorRef.current.lut?.intensity ?? 0);
        if (hasLut) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, lutTexRef.current); }

        // chroma
        const ch = chromaRef.current;
        const on = ch.enabled;
        const md = modeRef.current === "background" ? 1 : modeRef.current === "person" ? 2 : 0;
        gl.uniform1i(U("uChroma"), on ? 1 : 0);
        gl.uniform1i(U("uMode"), md);
        // showMask não faz sentido na camada de fundo (mostra a máscara na pessoa).
        gl.uniform1i(U("uShowMask"), on && maskRef.current && md !== 1 ? 1 : 0);
        if (on) {
          const k = ch.keyColor;
          gl.uniform3f(U("uKeyRGB"), k.r / 255, k.g / 255, k.b / 255);
          gl.uniform1f(U("uSimilarity"), ch.similarity);
          gl.uniform1f(U("uSmoothness"), ch.smoothness);
          gl.uniform1f(U("uDespill"), ch.despill);
          gl.uniform1f(U("uBgClip"), ch.bgClip ?? 0);
          gl.uniform1f(U("uFgClip"), ch.fgClip ?? 1);
          gl.uniform1i(U("uKeyChan"), k.r >= k.g && k.r >= k.b ? 0 : k.g >= k.b ? 1 : 2);
          gl.uniform2f(U("uDstRes"), canvas.width, canvas.height);
          gl.uniform1i(U("uBgCover"), (ch.fit ?? "cover") === "cover" ? 1 : 0);

          const bgT = ch.background?.type;
          const src = bgT === "image" ? bgImgRef.current : bgT === "video" ? bgVidRef.current : null;
          if (bgT === "color") {
            gl.uniform1i(U("uBgType"), 0);
            gl.uniform3f(U("uBgColor"), ...hexToRgb01((ch.background as { value: string }).value));
          } else if (src && (src as HTMLVideoElement).videoWidth !== 0 || (src instanceof HTMLImageElement && src.complete && src.naturalWidth)) {
            gl.uniform1i(U("uBgType"), bgT === "video" ? 2 : 1);
            const w = src instanceof HTMLImageElement ? src.naturalWidth : (src as HTMLVideoElement).videoWidth;
            const h = src instanceof HTMLImageElement ? src.naturalHeight : (src as HTMLVideoElement).videoHeight;
            gl.uniform2f(U("uBgRes"), w, h);
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, bgTexRef.current);
            try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src as TexImageSource); } catch { /* não pronto */ }
          } else {
            gl.uniform1i(U("uBgType"), 3); // nenhum → preto
          }
        }

        // MODO PESSOA: limpa transparente antes de desenhar (compõe sobre o DOM abaixo).
        if (md === 2) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [video]);

  return (
    <canvas ref={canvasRef} style={{
      position: "absolute", inset: 0, width: "100%", height: "100%",
      transform: `scale(${zoomScale})`, transformOrigin: "center center",
      transition: "transform 0.4s ease", pointerEvents: "none",
    }} />
  );
}
