// Libera a porta informada antes de subir o backend (mata instância órfã).
// Cross-platform: Windows (netstat + taskkill) e Unix (lsof + kill).
import { execSync } from "node:child_process";

const port = process.argv[2] ?? "3001";

try {
  if (process.platform === "win32") {
    // pega os PIDs escutando na porta e mata cada um
    const out = execSync(`netstat -ano -p tcp | findstr LISTENING | findstr :${port}`, {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    const pids = new Set(
      out.split(/\r?\n/).map((l) => l.trim().split(/\s+/).pop()).filter((p) => p && p !== "0"),
    );
    for (const pid of pids) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" }); console.log(`[free-port] matou PID ${pid} na porta ${port}`); } catch { /* já morto */ }
    }
  } else {
    const out = execSync(`lsof -ti tcp:${port} || true`, { encoding: "utf8" });
    for (const pid of out.split(/\s+/).filter(Boolean)) {
      try { execSync(`kill -9 ${pid}`); console.log(`[free-port] matou PID ${pid} na porta ${port}`); } catch { /* já morto */ }
    }
  }
} catch {
  // findstr/lsof não acham nada = porta livre; segue.
}
