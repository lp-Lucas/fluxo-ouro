import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * RENDER DE TELA EM CÓDIGO (D1 do design híbrido): recebe um HTML autocontido e o
 * fotografa em PNG no tamanho exato, via Chrome/Edge headless — zero dependência nova
 * (todo Windows tem Edge; Chrome se houver). Determinístico: mesmo HTML = mesmo PNG.
 *
 * `--virtual-time-budget` faz o Chromium esperar fontes/render antes do screenshot
 * (Google Fonts via <link> carrega dentro desse orçamento).
 */

const CANDIDATOS = [
  process.env.CHROME_PATH ?? "",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);

function acharNavegador(): string {
  for (const p of CANDIDATOS) if (fs.existsSync(p)) return p;
  throw new Error("Nenhum Chrome/Edge encontrado para renderizar a tela — defina CHROME_PATH.");
}

export async function renderHtmlToPng(html: string, outPath: string, w: number, h: number, signal?: AbortSignal): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-html-"));
  const htmlPath = path.join(dir, "tela.html");
  fs.writeFileSync(htmlPath, html, "utf8");
  const browser = acharNavegador();
  // perfil temporário isolado: não briga com o Chrome aberto do usuário
  const args = [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    `--user-data-dir=${path.join(dir, "profile")}`,
    `--window-size=${w},${h}`,
    `--screenshot=${outPath}`,
    "--virtual-time-budget=15000",
    "--no-first-run", "--no-default-browser-check", "--mute-audio",
    `file:///${htmlPath.replace(/\\/g, "/")}`,
  ];
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(browser, args);
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* */ } reject(new Error("render headless excedeu 60s")); }, 60_000);
    const onAbort = () => { clearTimeout(timer); try { proc.kill(); } catch { /* */ } reject(new Error("render cancelado")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    let err = "";
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // headless devolve exit code 0 mesmo com falha em alguns builds → valida pelo arquivo
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) resolve();
      else reject(new Error(`screenshot não gerado: ${err.slice(-300)}`));
    });
  }).finally(() => fs.rm(dir, { recursive: true, force: true }, () => {}));
}
