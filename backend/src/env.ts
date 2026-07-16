/**
 * Carrega o backend/.env no início e o torna a FONTE DA VERDADE (sobrescreve o que
 * já estiver no ambiente do sistema). Importado ANTES de tudo em server.ts.
 *
 * Por que sobrescrever: o `process.loadEnvFile` nativo NÃO substitui variáveis já
 * definidas no SO — então uma `OPENAI_API_KEY` esquecida nas variáveis do Windows
 * "vencia" o .env silenciosamente. Aqui o .env sempre manda (comportamento esperado
 * ao editar o arquivo). Silencioso se o .env não existir.
 */
import fs from "node:fs";
import path from "node:path";

const envPath = path.resolve(".env");
try {
  const txt = fs.readFileSync(envPath, "utf8");
  for (const linha of txt.split(/\r?\n/)) {
    const l = linha.trim();
    if (!l || l.startsWith("#")) continue;
    const eq = l.indexOf("=");
    if (eq < 0) continue;
    const key = l.slice(0, eq).replace(/^export\s+/, "").trim();
    let val = l.slice(eq + 1).trim();
    // remove aspas ao redor, se houver
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) process.env[key] = val; // sobrescreve o ambiente do SO
  }
} catch {
  /* sem .env — segue com as variáveis do ambiente (ou nenhuma) */
}
// diagnóstico (mascarado): confirma qual chave o SERVIDOR carregou de fato.
const _ok = (process.env.OPENAI_API_KEY ?? "").trim();
console.log(`[env] OPENAI_API_KEY ativa: ${_ok ? "…" + _ok.slice(-4) + " (len " + _ok.length + ")" : "AUSENTE"}`);
