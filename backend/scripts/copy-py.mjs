import { cpSync, existsSync } from "node:fs";

// O `tsc` compila só o TypeScript; os scripts Python (transcricao com faster-whisper e o
// matting RVM do chroma) NAO entram no dist. Mas o backend compilado (dist/backend/src/*)
// resolve esses .py em dist/backend/{transcribe,matting} (path.resolve("../../transcribe/...")
// a partir do modulo). Sem esta copia, em PROD o spawn do python falha com
// "can't open file '.../dist/backend/transcribe/transcribe.py'" e a transcricao (criar
// projeto) trava. Roda depois do tsc (ver package.json "build"). Cross-plataforma (fs.cpSync).
for (const dir of ["transcribe", "matting"]) {
  if (existsSync(dir)) {
    cpSync(dir, `dist/backend/${dir}`, { recursive: true });
    console.log(`[copy-py] ${dir}/ -> dist/backend/${dir}/`);
  }
}
