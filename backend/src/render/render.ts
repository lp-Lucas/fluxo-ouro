import path from "node:path";
import fs from "node:fs";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia, renderStill } from "@remotion/renderer";

const REMOTION_ENTRY = path.resolve("../remotion/src/index.ts");

/**
 * Empacota o projeto Remotion. Em dev, rebundlar a cada render garante que as
 * mudanças na composição sempre entram (sem cache stale). Custa alguns segundos.
 */
async function getServeUrl(): Promise<string> {
  return bundle({ entryPoint: REMOTION_ENTRY });
}

/**
 * Limita a resolução a uma caixa de 1920×1080 (lado maior ≤ 1920, menor ≤ 1080),
 * mantendo a proporção. Vídeos 4K/8K são reduzidos → render mais leve e rápido.
 * Retorna dimensões pares (exigência do H.264).
 */
export function capDimensions(w: number, h: number): { width: number; height: number } {
  // Lado maior ≤ 1920 e lado menor ≤ 1080, preservando a proporção.
  const scale = Math.min(1920 / Math.max(w, h), 1080 / Math.min(w, h), 1);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(w * scale), height: even(h * scale) };
}

export interface RenderInput {
  videoSrc: string; // URL http que o Chrome do Remotion consegue buscar
  audioSrc?: string; // WAV decupado (Fase 4): áudio único; sem ele, o áudio vem dos vídeos
  personSrc?: string; // chroma em camadas: pessoa recortada (WebM alpha) por cima do fundo
  transcript: unknown[];
  cuts: unknown[];
  zooms: unknown[];
  popups: unknown[];
  style: unknown;
  durationSec: number; // duração bruta; a composição aplica os cortes
  fps: number;
  width: number;
  height: number;
  outputPath: string;
  onProgress?: (progress: number) => void; // 0..1
}

/** Renderiza UM frame (still) — iteração rápida de diagnóstico. */
export async function renderStillDebug(inputProps: Record<string, unknown>, frame: number, outPng: string): Promise<void> {
  const serveUrl = await getServeUrl();
  const composition = await selectComposition({ serveUrl, id: "FluxoOuro", inputProps });
  await renderStill({
    serveUrl, composition, frame, output: outPng, inputProps,
    onBrowserLog: (log) => { if (log.text.includes("[COMPO]")) console.log(log.text); },
  });
}

/** Renderiza a composição FluxoOuro (vídeo + legendas) para um MP4. */
export async function renderVideo(input: RenderInput): Promise<void> {
  const serveUrl = await getServeUrl();
  const inputProps = {
    videoSrc: input.videoSrc,
    audioSrc: input.audioSrc,
    personSrc: input.personSrc,
    transcript: input.transcript,
    cuts: input.cuts,
    zooms: input.zooms,
    popups: input.popups,
    style: input.style,
    durationSec: input.durationSec,
    fps: input.fps,
    width: input.width,
    height: input.height,
  };

  // (c) PONTO 3 — grava EM DISCO o inputProps EXATO passado ao Remotion.
  const dumpPath = path.join(path.dirname(input.outputPath), "debug-props-final.json");
  fs.writeFileSync(dumpPath, JSON.stringify(inputProps, null, 2));
  console.log(`[EXPORT-DEBUG] (c) inputProps gravado em ${dumpPath}`);

  const composition = await selectComposition({
    serveUrl,
    id: "FluxoOuro",
    inputProps,
  });

  let lastLog = 0;
  await renderMedia({
    serveUrl,
    composition,
    codec: "h264",
    outputLocation: input.outputPath,
    inputProps,
    timeoutInMilliseconds: 120000, // dá folga p/ carregar fontes/vídeo
    // Encaminha os console.log da composição (headless) para o stdout do backend.
    onBrowserLog: (log) => { if (log.text.includes("[COMPO]")) console.log(log.text); },
    onProgress: ({ progress }) => {
      input.onProgress?.(progress);
      const pct = Math.round(progress * 100);
      if (pct >= lastLog + 10) {
        lastLog = pct;
        console.log(`render: ${pct}%`);
      }
    },
  });
}
