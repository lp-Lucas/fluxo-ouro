Arquitetura Geral

caption-studio/
├── server/
│   ├── index.ts          — Express: /video, /transcribe, /correct, /autocut, /render/*
│   ├── transcribe.ts     — Spawna faster-whisper via Python
│   ├── transcribe.py     — faster-whisper large-v3 → JSON de palavras
│   ├── claude.ts         — callClaudeLocal() via PowerShell
│   └── render.ts         — Remotion renderMedia() (não lido ainda)
└── src/
    ├── types/timeline.ts — Todas as interfaces + EMPTY_TIMELINE
    ├── store/
    │   ├── timeline.store.ts  — Zustand: estado do projeto
    │   └── editor.store.ts    — Zustand: UI (frame, playing, painel ativo)
    ├── transcription/
    │   └── whisper.ts         — fetch /api/transcribe + buildCues()
    ├── editor/
    │   ├── layout/EditorLayout.tsx     — Shell: header + sidebar esq + preview + sidebar dir + timeline
    │   ├── upload/VideoUpload.tsx      — Upload, transcrever, corrigir com Claude, autocut
    │   ├── preview/PlayerWrapper.tsx   — @remotion/player sincronizado com store
    │   ├── timeline/TimelinePanel.tsx  — Régua + tracks drag-and-drop
    │   └── properties/
    │       ├── PropertiesPanel.tsx     — Tabs: Legendas/Overlays/Zoom/Presets + Export
    │       ├── CaptionProperties.tsx   — Tipografia, background, posição, editor de cues
    │       ├── OverlayProperties.tsx   — Controles de overlay
    │       ├── ZoomProperties.tsx      — Auto-zoom alternado
    │       └── PresetManager.tsx       — Salvar/carregar presets
    └── remotion/
        ├── MainComposition.tsx         — VideoLayer + OverlayLayer + CaptionLayer + scale fast-mode
        └── layers/
            ├── VideoLayer.tsx          — OffthreadVideo + zoom spring
            ├── CaptionLayer.tsx        — Karaokê word-by-word + 4 entradas animadas
            └── OverlayLayer.tsx        — Imagem/texto com entrada/saída animada
Modelo de Dados (Timeline)

Timeline {
  id, version: 1
  meta: { title, fps, width, height, durationFrames }
  video: { src, width, height, durationFrames, fps } | null
  captionStyle: CaptionStylePreset   // tipografia, background, posição, entrada
  wordsPerCue: number                // palavras por bloco de legenda
  rawWords: Word[] | null            // palavras flat com timestamps em frames
  cues: CaptionCue[]                 // grupos de words para exibição
  overlays: Overlay[]                // texto/imagem com posição e timing
  zooms: ZoomEffect[]                // in/out com escala
}
Fluxo de Produção

1. Upload vídeo → POST /api/video → videoStore (persiste entre restarts)
2. Transcrever → POST /api/transcribe → faster-whisper → words[]
       → buildCues() → CaptionCue[] no store
3. Corrigir → POST /api/correct → segmenta por pausas → Claude local
       → corrige ortografia/pontuação → remapeia timestamps
4. Autocut → POST /api/autocut → ffmpeg silencedetect + Claude analisa
       → retakes/repetições/muletas com timestamps
5. Editar → Timeline panel drag-and-drop, CaptionProperties, OverlayProperties
6. Export → POST /api/render → Remotion renderMedia() → poll status → download
Detalhes Técnicos
Canvas: sempre normalizado (1080×1920 portrait / 1920×1080 landscape), independente da resolução do vídeo. Fast mode renderiza em 720p escalando com CSS transform.

Karaokê: CaptionLayer detecta palavra ativa por frame >= word.startFrame, aplica highlightColor + highlightWeight. Cue ativa = startFrame ≤ frame ≤ endFrame + 3.

4 entradas de legenda: slide-up-fade-blur (padrão), pop, fade, none — todas via spring() do Remotion.

Timeline drag: CueBar, OverlayBar, ZoomBar — todos com handle de move + trim in/out via mousemove global.

Proxy Vite: /api/* → localhost:3001 (rewrite remove /api). /video/* → localhost:3001 direto.

Persistência de vídeo: ~/.cache/caption-studio/videos/ — sobrevive a restarts do servidor.

Claude local: powershell -Command 'claude -p $env:_CS_PROMPT' com prompt em env var para evitar escaping.