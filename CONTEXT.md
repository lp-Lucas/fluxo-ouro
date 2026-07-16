# Fluxo Ouro — Contexto do Projeto

Editor de vídeo web **all-in-one** assistido por IA (PT-BR), **self-hosted, usuário único**.
Recebe um vídeo bruto e entrega o MP4 final — transcrição, correção, legenda, cortes,
zooms, popups, matting ("atrás da pessoa"), correção de cor/LUT, **chromakey** e export —
**tudo no site**, sem depender de editor externo. IA (Claude) assiste na decupagem e na
conferência de legenda. Só APIs externas são permitidas (imagem/motion, ainda a fazer).

> Este arquivo é a **referência viva** da arquitetura. Atualize-o quando mudar algo estrutural.

---

## Arquitetura (monorepo)

```
AUTOMOTION/
├── frontend/   React + Vite — o site (editor)
├── backend/    Node/Express + Python — trabalho pesado (transcrição, render, matting, cor)
├── remotion/   Composição Remotion — renderiza o MP4 final
├── shared/     Fonte da verdade (schemas + lógica pura usada pelos 3)
└── CONTEXT.md  (este arquivo)
```

**Por que existe backend** mesmo sendo "um site": `faster-whisper` (transcrição) e `RVM` (matting)
são Python; o export final do Remotion precisa de Node + Chromium + ffmpeg; e as chaves de API
não podem ficar no navegador. O usuário só vê o site; o servidor faz o pesado.

### Rodar (dev)
```bash
cd backend  && npm run dev    # libera a porta 3001 e sobe (tsx watch)
cd frontend && npm run dev     # http://localhost:5173  (proxy /api,/uploads,/projects → 3001)
```
Requisitos no host: **Python 3.11 + faster-whisper + torch + torchvision**, **ffmpeg** (com `libvpx-vp9`),
Node. GPU opcional (RVM em CPU hoje; torch é CPU-only). O `dev` do backend roda `scripts/free-port.mjs`
antes de subir → nunca duas instâncias na 3001 (era causa de bugs "fantasma").
Para a IA do autocut/legenda: o **CLI `claude`** logado (padrão) **ou** `ANTHROPIC_API_KEY` no ambiente
do backend; modelo opcional via `AUTOCUT_MODEL` (default `claude-sonnet-5`).

---

## `shared/` — fonte da verdade

- **[timeline.ts](shared/timeline.ts)** — schema do que o editor produz: `TranscriptSegment/Word`,
  `Cut` (com `shiftCaption`), `Zoom`, `Popup` (união `SupportPopup | FullscreenPopup`, presets,
  `behindSubject`, `alphaVideoPath`), `MotionPoint`, `Timeline` (inclui `color` e `chroma`).
- **[captionStyle.ts](shared/captionStyle.ts)** — `CaptionStyle` (fontes, animações de entrada/loop,
  contorno, sombra, fundo, modos karaokê/estático/destaque, tipografia), `wordFx`, presets, `VIRAL_FONTS`.
- **[captions.ts](shared/captions.ts)** — `buildCaptionLines`, `activeLine`, `stripCutsFromTranscript`
  (remove/desloca palavras dentro de cortes).
- **[cutplan.ts](shared/cutplan.ts)** — `buildCutPlan` + `remapTime`: mapeia tempo do vídeo bruto →
  tempo final (com cortes emendados).
- **[color.ts](shared/color.ts)** / **[lut.ts](shared/lut.ts)** / **[colorLut.ts](shared/colorLut.ts)** —
  correção de cor + LUT: `ColorSettings`, `isColorNeutral`, `parseCube`, `transformPixel`,
  `composeColorCubeText`, presets.
- **[chroma.ts](shared/chroma.ts)** — chromakey: `ChromaSettings` (cor-chave, similarity, smoothness,
  despill, `bgClip`/`fgClip`, fundo cor/imagem/vídeo), `isChromaActive`. Documenta a fórmula do
  keying em **BT.601** (paridade shader↔ffmpeg, validada).
- **[flow.ts](shared/flow.ts)** — FLOW: `FlowState` (`moments` → `phrases`), `FlowPhrase`/`FlowMoment`,
  `FitStrategy`, `FLOW_DESIGN_PRESETS` + `buildDesignPrompt`. `FullscreenPopup` ganhou
  `media:{kind:"image"|"video",src}` (Tipo 2 real) + `flowPhraseId`.
- **[project.ts](shared/project.ts)** — sistema de projetos: `EditorDocument`, `ProjectFile`,
  `ProjectMeta`, `SCHEMA_VERSION` (v2: + `chroma`), `migrateProject`.

---

## Pipeline do editor (frontend)

Estado central: **documento único** em [App.tsx](frontend/src/App.tsx) com **undo/redo global**
([useHistory.ts](frontend/src/history/useHistory.ts), coalescência de 500ms + `reset()` ao abrir projeto).
Ctrl+Z / Ctrl+Shift+Z / Ctrl+S.

1. **Ingestão + Transcrição** — upload → `faster-whisper` (timestamps por palavra). Fonte da verdade.
2. **Correção** ([TranscriptEditor.tsx](frontend/src/modules/correcao/TranscriptEditor.tsx)) —
   editar/dividir/juntar/remover/ajustar-tempo palavras; auto-correção pela **copy/roteiro** com
   **corte automático do que está fora da copy** (checkbox). Alinhamento em
   [align.ts](frontend/src/modules/correcao/align.ts): **Gotoh (gaps afins) + match fuzzy** — retakes
   viram um corte contíguo (não "fatiado") e mishears viram correção (não corte).
3. **Cor** ([ColorPanel.tsx](frontend/src/modules/color/ColorPanel.tsx)) — brilho/contraste/saturação/
   gamma + LUT `.cube` + intensidade, presets, bypass. Preview WebGL2
   ([ColorCanvas.tsx](frontend/src/modules/color/ColorCanvas.tsx)).
4. **Chromakey** ([ChromaPanel.tsx](frontend/src/modules/chroma/ChromaPanel.tsx)) — remove fundo
   verde/azul → cor/imagem/vídeo. Cor-chave por **conta-gotas**, sliders (tolerância, borda, despill,
   **preencher sujeito** `fgClip` / **limpar fundo** `bgClip`), "ver máscara". Preview no mesmo
   `ColorCanvas` (keying+despill+fundo+cor num shader; modos composto/fundo/pessoa p/ camadas).
5. **Legenda + Preview** ([KaraokePreview.tsx](frontend/src/modules/legenda/KaraokePreview.tsx)) —
   o preview é um **espelho fiel do export**: legendas e popups num "palco" na **resolução de export**
   (Full HD) escalado pra tela (WYSIWYG). Mostra ao vivo: cor, chroma, cortes (pula), zooms, popups e o
   **recorte da pessoa** (matting MediaPipe / chroma). Inclui a **timeline de cortes com forma de onda**
   ([CutTimeline.tsx](frontend/src/modules/editor/CutTimeline.tsx)): onda do áudio (Web Audio), blocos
   arrastáveis (ímã nas palavras), **zoom + rolagem**, nudge ±0.1s, "tocar só o que fica".
6. **Editor** ([Editor.tsx](frontend/src/modules/editor/Editor.tsx)) — AUTOCUT (silêncio/vício/copy/
   seleção/manual), **✨ Cortes perfeitos com IA** e **🩹 Conferir legendas (IA)** (ver Autocut IA),
   zooms (intercalado in/out), **popups** (detecção heurística + presets, tipografia por linha,
   imagens, animações, "atrás da pessoa").
7. **FLOW** ([FlowPanel.tsx](frontend/src/modules/flow/FlowPanel.tsx)) — wizard de motion design por
   IA: detectar momentos → design por frase (preset + imagem) → animar (prompt de motion + vídeo) →
   posicionar como popups fullscreen. Ver seção FLOW abaixo.
8. **Export** ([ExportPanel.tsx](frontend/src/modules/export/ExportPanel.tsx)) — job com barra de %.

---

## Backend ([backend/src/](backend/src/))

- **server.ts** — Express + rotas. Jobs de render com progresso, timeout de segurança (5 min) que
  **mata a árvore de processos**, limpeza no boot (>24h **só** em `uploads/` e `out/`; `projects/` intocado).
- **transcribe/** — `faster-whisper` (CPU, `int8`). Mantém o upload (vira asset de projeto).
- **render/render.ts** — bundle + `renderMedia` do Remotion. `capDimensions` (cap Full HD),
  `renderStillDebug`, `onProgress`, carrega fontes/imagens.
- **matting/** — `MattingProvider` (abstração) → `RVMProvider` → `rvm_matte.py` (RobustVideoMatting).
  Gera **WebM VP9 com alpha** (`yuva420p`) só do trecho de cada popup `behindSubject`; cacheado.
- **color/colorPrePass.ts** — pré-passe **ffmpeg `lut3d`** (LUT composta: correção+LUT+intensidade),
  saída Full HD + `faststart`, tags BT.709 iguais ao alpha (sem pop de tonalidade).
- **chroma/chromaPrePass.ts** — pré-passe do chromakey em ffmpeg (`chromakey` + clip via `lut` no alpha
  + `despill` + composição sobre o fundo + `lut3d` da cor). 3 modos: **assado** (1 passe, plano opaco),
  **pessoa** (WebM VP9 alpha) e **fundo** (plano opaco) — os 2 últimos p/ camadas (popup entre fundo e pessoa).
- **autocut/aiCut.ts** — autocut com IA: a IA **decide** manter/cortar por índice de palavra; os
  **timestamps são do whisper** (bordas cronometradas). Provedor trocável: `ANTHROPIC_API_KEY` →
  API Anthropic; senão → **CLI `claude -p`** (usa o Claude Code logado). Modelo via `AUTOCUT_MODEL`.
- **autocut/captionCoverage.ts** — conferência de legenda pós-corte: acha trechos do vídeo final
  **sem legenda** (determinístico) e, com a copy, a IA decide o texto que falta; preenche no segmento
  que contém o buraco (dedup dos vizinhos).
- **flow/** — motion design (ver seção FLOW): `claude.ts` (detecção + prompt de motion),
  `videoProvider.ts` (Google Veo image-to-video), `timeFit.ts` (speed/trim/hold), `ffmpeg.ts` (utils).
- **providers/** — `ImageProvider` (interface) + `OpenAIImageProvider` (gpt-image-1, padrão) e
  `GeminiProvider` (alternativa). `getImageProvider()` seleciona por `IMAGE_PROVIDER`.
- **projects/store.ts** — storage de projetos (ver abaixo). Assets do FLOW: dehidratados p/
  `flow/<arquivo>` em disco, hidratados p/ URL absoluta; `pruneFlowAssets` remove gerações órfãs ao salvar.

### Rotas
`/api/transcribe`, `/api/render` (+ `/progress/:id`, `/result/:id`), `/api/lut`,
`/api/autocut-ai`, `/api/caption-coverage`, `/api/projects` (GET/POST/PUT/PATCH/DELETE),
`/api/flow/{detect,design,motion-prompt,animate,refit,progress/:id}`.
Estáticos: `/uploads`, `/projects`.

### Paridade (validação por script)
`scripts/color-parity.ts` e `scripts/chroma-parity.ts` (`npx tsx`) comparam a matemática do shader
(preview) com a saída ffmpeg (export), pixel a pixel. Chroma: keying em **BT.601**, limiares sem
escala, erro em área sólida < 1/255 (bordas divergem — inerente, como o 4:2:0 da cor).

---

## Export / Remotion ([remotion/src/CaptionedVideo.tsx](remotion/src/CaptionedVideo.tsx))

Composição em camadas, **reusando os mesmos componentes do preview** (paridade):
**vídeo (com cortes emendados + zoom) → popups → pessoa recortada (alpha, `transparent`) → legendas.**
- Cortes reais via `<Sequence>` + `OffthreadVideo startFrom`; tudo remapeado (`remapTime`).
- Fontes Google carregadas só as usadas (por eventos reais, sem travar).
- Render é **rebundlado a cada export** (sem cache stale).
- Cor entra como **pré-passe** no vídeo fonte (fundo **e** recorte ficam com a cor; legenda/popups não).
- **Chroma no export:** o backend escolhe o caminho. Sem popup "atrás da pessoa" → plano **assado**
  (keying+fundo+cor já compostos, vira o `videoSrc`). Com popup "atrás" → **camadas**: `chromaBackgroundPass`
  (fundo) + `chromaPersonPass` (pessoa transparente, prop `personSrc`) → Remotion empilha
  **fundo → popup "atrás" → pessoa → popups da frente → legendas**. Com chroma, a pessoa vem do keying
  (dispensa RVM).

---

## Sistema de projetos

**Projeto** = `EditorDocument` (JSON) + assets (vídeo fonte, `.cube`). Persistido no backend:
```
projects/<id>/
  project.json   (escrita atômica: tmp + rename)
  thumb.jpg      (frame a ~10%, 320px)
  assets/        (vídeo + .cube — movidos de uploads/ ao salvar)
  exports/       (cópia dos MP4 exportados)
```
- **Conflito da limpeza de 24h resolvido:** `projects/` nunca é limpo; ao salvar, os assets em
  `uploads/` são **movidos** pra `projects/<id>/assets/` e as refs viram nome de arquivo.
- **Imagens de popup** ficam como **data URL** no documento (o export as externaliza) — evita loop de re-hidratação.
- **Hydrate/dehydrate:** disco guarda nome de arquivo; ao ler, vira URL `/projects/<id>/assets/...`.
- **Migração** por versão (`migrateProject`); versão futura → erro legível.
- **Autosave** (debounce 3s pós-mudança) + Ctrl+S + indicador + aviso `beforeunload`. Histórico não é persistido.

---

## IA (Claude) no autocut/legenda

Híbrido: **a IA decide, os timestamps continuam do whisper** (a IA nunca inventa tempo → precisão).
- **Cortes perfeitos com IA** — a IA lê a transcrição (+copy) e devolve os trechos a cortar por
  índice; `spansToCuts` monta os cortes com bordas cronometradas. Modos: `copy` (roteiro é verdade),
  `judgment` (sem roteiro, melhor take/muletas) e `auto`.
- **Conferir legendas (IA)** — pós-corte, acha fala sem legenda e preenche com a copy.
- **Provedor**: por padrão o **CLI `claude -p`** já logado (sem chave, ~US$0,03–0,04/chamada por
  causa do cache do Claude Code); com `ANTHROPIC_API_KEY` no ambiente, passa a usar a **API** direta
  (mais barato) sem outra mudança. Só o **texto** da transcrição sai da máquina. Limite ~4000 palavras/passe.

## FLOW — motion design por IA (Módulo 7)

Transforma trechos da fala em vídeos de motion sincronizados, inseridos como popups fullscreen (Tipo 2).
Mesma regra de ouro: **a IA decide por índice de palavra; os tempos são do whisper**.

Fluxo (wizard [FlowPanel.tsx](frontend/src/modules/flow/FlowPanel.tsx)):
1. **Detectar** (`/api/flow/detect`) — Claude acha **3 momentos** e segmenta cada um em **frases**
   (por índice de palavra), com `reason` PT-BR. Cada frase vira UM vídeo.
2. **Design** (`/api/flow/design`) — por frase: preset ([FLOW_DESIGN_PRESETS](shared/flow.ts)) + prompt →
   `getImageProvider()` (OpenAI gpt-image-1) → imagem 1920×1080 em `assets/flow/`. Aprovar/regenerar.
3. **Motion** (`/api/flow/motion-prompt`, síncrono) — Claude converte o pedido do usuário (PT-BR) num
   prompt técnico (EN). **Animate** (`/api/flow/animate`) — `getVideoProvider()` (Google Veo) gera o
   vídeo bruto → **time-fit**.
4. **Time-fit** ([timeFit.ts](backend/src/flow/timeFit.ts)) — ajusta o vídeo à duração da frase no
   tempo FINAL (pós-cortes, via `remapTime`): `speed` (0.5–2.5×), `trim` (>2.5×) ou `hold` (<0.5×,
   congela o último frame). Saída 1920×1080 H.264 BT.709. **Re-sincronizar** (`/api/flow/refit`)
   refaz só o time-fit quando os cortes mudam (sem regenerar imagem/vídeo → sem custo de API).
5. **Posicionar** — cria `FullscreenPopup` de vídeo nos tempos das frases; `placeFlowPopups` faz upsert
   por `flowPhraseId`. Preview e Remotion renderizam o Tipo 2 pelo MESMO `FullscreenPopupView`
   (paridade): preview usa `<video>` sincronizado; export usa `<OffthreadVideo>` num `<Sequence>`.

Jobs **por frase** (`startFlowJob`, timeout 12 min que mata a árvore). Cache: imagem por hash do prompt,
vídeo por (imagem, prompt), time-fit por (bruto, target). Chaves só no backend
([.env.example](backend/.env.example)): `OPENAI_API_KEY`, `GOOGLE_VIDEO_API_KEY`; a IA (detect/motion)
usa o CLI `claude` logado ou `ANTHROPIC_API_KEY`. Só **texto** da transcrição sai da máquina.

## Estado atual / limitações

- **Matting em CPU** (torch CPU-only; a RTX 3060 existe mas precisa de torch CUDA pra acelerar).
- **Export matting = RVM puro** — não reflete os ajustes do preview (pincel de cor/área do MediaPipe).
  Com **chroma** ativo, a pessoa vem do keying (não usa RVM).
- **FLOW v1**: exatamente 3 momentos por detecção (schema já suporta n); motions **mudos**; sem
  transição entre frases do mesmo momento (cada frase = 1 popup); regeneração se o vídeo vier ruim é
  **manual**. Providers de imagem/vídeo (OpenAI/Google) implementados mas dependem de chave — o
  shape exato do Veo deve ser confirmado na doc do Google.
- Popups: detecção (Tipo 1) é **heurística** (marcas/números/nomes/frases).
- Chroma: garbage matte / keying por trecho / light wrap fora do escopo v1 (schema extensível).
- Cobertura de legenda (IA): tempos das palavras preenchidas são **distribuídos** no buraco
  (a IA não ouve o áudio); posicionamento bom, sincronia fina de karaokê pode precisar de ajuste manual.

## Convenções

- Comentários e UI em **PT-BR**. Schemas novos vivem em `shared/`.
- Undo/redo por snapshot; estado editável no documento central ganha undo de graça.
- Assets pesados nunca vão como base64 em campo multipart (lição do bug do `fieldSize`);
  imagens de popup e o **fundo do chroma** no export vão como **arquivos** (`img_N` / `chromabg` + token `ref:`).
- Keying (chroma) usa **BT.601** dos dois lados (shader e ffmpeg); a correção de cor usa luma BT.709 —
  são etapas diferentes, não confundir.
