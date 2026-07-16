// Renderiza UM frame (still) a partir do out/debug-props-final.json, para iterar
// rápido no diagnóstico. Uso: npx tsx scripts/still.ts <tempoSegundos>
import fs from "node:fs";
import path from "node:path";
import { renderStillDebug } from "../src/render/render.js";

const timeSec = Number(process.argv[2] ?? 1);
const OUT = path.resolve("out");
const props = JSON.parse(fs.readFileSync(path.join(OUT, "debug-props-final.json"), "utf8"));
const fps = props.fps ?? 30;
const frame = Math.round(timeSec * fps);
const outPng = path.join(OUT, "still.png");

console.log(`renderStill: t=${timeSec}s (frame ${frame}) -> ${outPng}`);
renderStillDebug(props, frame, outPng)
  .then(() => console.log("still pronto"))
  .catch((e) => { console.error("still ERRO:", e); process.exit(1); });
