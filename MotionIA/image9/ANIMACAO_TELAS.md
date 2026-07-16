# image9 — Animação de Telas (Fluxo)

Pipeline para gerar animações Apple-style de screenshots de UI com Seedance 2.0, sincronizadas com narração.

---

## Conceito

Cada imagem de tela vira um vídeo independente (sem encadeamento de frames).
Todos usam o **mesmo prompt** — só muda a imagem de entrada (`--image`).
Após geração: speed-up individual por clip → trim → concatenação.

---

## Estrutura de pastas

```
image9/
├── tela1.png          → "um CRM desenvolvido para corretores autônomos"
├── tela2.png          → "que mostra quem abriu, voltou, revisitou"
├── tela 3.png         → "e demonstrou interesse real nos imóveis que você enviu."
└── v_final.mp4        → output final concatenado
```

---

## Prompt Seedance 2.0

> Mesmo prompt para todos os clips. Apenas `--image` muda.

```
Apple-style motion design animation of a clean modern SaaS dashboard UI screen
on white background. TEXT ANIMATION: headline text fades in with smooth
fade-in-up rising 20px while blurring from 8px to 0px opacity 0 to 100%
premium Apple keynote easing ease-out slow elegant settle. INTERFACE ANIMATION:
UI elements cards rows table items avatars badges buttons charts pills animate
in with subtle staggered bounce appearing sequentially top-to-bottom each
scaling from 0.95 to 1.0 with soft spring overshoot timing interleaved
alternating so layout assembles in rhythmic cascade tags and status elements pop
in with gentle elastic settle. STYLE: smooth fluid premium high-end Apple motion
design buttery 60fps feel refined spring physics no harsh movements soft shadows
subtle glassmorphism camera completely static clean white background cinematic
but minimal. Mouse cursor glides smoothly across the screen hovering over
interactive elements. NEGATIVE: no warping no text morphing no distortion no
flickering no camera movement no zoom no panning all elements stay crisp sharp
legible.
```

---

## Etapa 1 — Geração (jobs independentes, podem ser submetidos juntos)

```powershell
$p = 'Apple-style motion design animation...'  # prompt acima em linha única

# Submete os 3 ao mesmo tempo
higgsfield generate create seedance_2_0 "--prompt" $p "--image" "tela1.png" "--duration" "4" "--aspect_ratio" "9:16" "--json" "--no-color" 2>&1
higgsfield generate create seedance_2_0 "--prompt" $p "--image" "tela2.png" "--duration" "4" "--aspect_ratio" "9:16" "--json" "--no-color" 2>&1
higgsfield generate create seedance_2_0 "--prompt" $p "--image" "tela 3.png" "--duration" "4" "--aspect_ratio" "9:16" "--json" "--no-color" 2>&1
```

### Jobs gerados

| Clip | Job ID | URL |
|------|--------|-----|
| V1 | `8f10c3cb-2cd5-466b-8709-a6aa2df618dd` | `hf_20260626_043838_8f10c3cb...mp4` |
| V2 | `dc6d9117-0f1e-48d0-94ff-cf66f3b15109` | `hf_20260626_043850_dc6d9117...mp4` |
| V3 | `736cc499-a002-43c9-8e71-7e9f07b697f2` | `hf_20260626_043903_736cc499...mp4` |

```
Base URL: https://d8j0ntlcm91z4.cloudfront.net/user_3DPNssNokpEjo1hW4m76lcQvSM1/
```

---

## Etapa 2 — Timing e sincronização

### Timestamps da narração

```
00:16.300  um
00:16.840  CRM
00:17.640  desenvolvido
00:17.840  para
00:18.360  corretores
00:19.100  autônomos,
00:19.180  que          ← início V2
00:19.540  mostra
00:19.780  quem
00:20.420  abriu,
00:20.980  voltou,
00:21.560  revisitou
00:21.820  e            ← início V3
00:22.380  demonstrou
00:22.920  interesse
00:23.300  real
00:23.560  nos
00:23.900  imóveis
00:24.060  que
00:24.340  você
00:24.900  enviu.       ← fim estimado
```

### Durações alvo por clip

| Clip | Início | Fim | Duração alvo |
|------|--------|-----|-------------|
| V1 | 16.300s | 19.180s | **2.88s** |
| V2 | 19.180s | 21.820s | **2.64s** |
| V3 | 21.820s | 24.900s | **3.08s** |

---

## Etapa 3 — Speed-up com FFmpeg

### Fórmula

```
fator_speed = duração_gerada / duração_alvo
pts_fator   = 1 / fator_speed   (= duração_alvo / duração_gerada)
```

| Clip | Gerado | Alvo | PTS fator | Velocidade |
|------|--------|------|-----------|------------|
| V1 | 4s | 2.88s | 0.720 | **1.39x** |
| V2 | 4s | 2.64s | 0.660 | **1.52x** |
| V3 | 4s | 3.08s | 0.770 | **1.30x** |

> Todos < 2x → `atempo` funciona em passo único (sem encadeamento).

### Comandos

```powershell
$dir = 'c:\...\image9'

# Speed-up
ffmpeg -y -i "$dir\v1.mp4" -filter_complex "[0:v]setpts=0.720*PTS[v];[0:a]atempo=1.389[a]" -map "[v]" -map "[a]" "$dir\v1_fast.mp4"
ffmpeg -y -i "$dir\v2.mp4" -filter_complex "[0:v]setpts=0.660*PTS[v];[0:a]atempo=1.515[a]" -map "[v]" -map "[a]" "$dir\v2_fast.mp4"
ffmpeg -y -i "$dir\v3.mp4" -filter_complex "[0:v]setpts=0.770*PTS[v];[0:a]atempo=1.299[a]" -map "[v]" -map "[a]" "$dir\v3_fast.mp4"

# Trim exato (re-encode para corte frame-accurate)
ffmpeg -y -i "$dir\v1_fast.mp4" -t 2.88 -c:v libx264 -c:a aac "$dir\v1_trim.mp4"
ffmpeg -y -i "$dir\v2_fast.mp4" -t 2.64 -c:v libx264 -c:a aac "$dir\v2_trim.mp4"
ffmpeg -y -i "$dir\v3_fast.mp4" -t 3.08 -c:v libx264 -c:a aac "$dir\v3_trim.mp4"
```

> **Nota:** usar `-c:v libx264 -c:a aac` no trim (não `-c copy`) para corte preciso.
> `-c copy` snap no keyframe mais próximo e gera leve excesso de duração.

---

## Etapa 4 — Concatenação

```powershell
# Escrever lista sem BOM (Out-File -Encoding utf8 quebra o concat demuxer)
[System.IO.File]::WriteAllText("$dir\concat_list.txt", "file 'v1_trim.mp4'`nfile 'v2_trim.mp4'`nfile 'v3_trim.mp4'`n")

ffmpeg -y -f concat -safe 0 -i "$dir\concat_list.txt" -c copy "$dir\v_final.mp4"
```

---

## Resultado final

| Arquivo | Duração | Resolução |
|---------|---------|-----------|
| `v_final.mp4` | **~8.60s** | 720×1280 (9:16) |

### Posição na timeline principal

Colocar `v_final.mp4` a partir de **16.300s**:

```
16.300s ──[V1 2.88s]──► 19.180s ──[V2 2.64s]──► 21.820s ──[V3 3.08s]──► 24.900s
```

---

## Diferenças em relação ao fluxo image8

| | image8 (cenas animadas) | image9 (animação de telas) |
|-|------------------------|---------------------------|
| Encadeamento | Sim — último frame vira start-image do próximo | Não — cada vídeo é independente |
| Flag usada | `--start-image` / `--end-image` | `--image` (única) |
| Prompt | Diferente por clip | Mesmo prompt para todos |
| Extração de frame | Sim (`extract_last_frame.py`) | Não necessário |
| Submissão | Sequencial (depende do frame anterior) | Paralela (todos de uma vez) |

---

## Arquivos intermediários (podem ser deletados)

```
v1.mp4   v2.mp4   v3.mp4
v1_fast.mp4   v2_fast.mp4   v3_fast.mp4
v1_trim.mp4   v2_trim.mp4   v3_trim.mp4
concat_list.txt
```
