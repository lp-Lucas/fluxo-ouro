# image8 — Processo de Geração de Vídeo

Documentação completa do pipeline: Seedance 2.0 → speed-up → concatenação.

---

## Estrutura de pastas

```
image8/
├── 1/   ChatGPT Image *.png   → keyframe V1 (cena com mapa, peão, bandeira)
├── 2/   ChatGPT Image *.png   → keyframe V2 (cena azul com texto "e te ajudar com isso")
├── 3/
│   ├── 1.png                  → keyframe intermediário V3 (peão + feixe lateral)
│   └── 2.png                  → keyframe final V3 (cone + logo + texto)
├── extract_last_frame.py      → script para extrair último frame de vídeo
├── prompts_seedance.md        → prompts completos e checklist
└── v_final.mp4                → output final concatenado
```

---

## Etapa 1 — Geração com Seedance 2.0 (Higgsfield CLI)

### Modelo e parâmetros base

```
Modelo:       seedance_2_0
Duração:      4s (mínimo do modelo)
Resolução:    720p  (18 créditos/geração)
Aspect ratio: 9:16
```

### Padrão de comando que funcionou

```powershell
$p = 'prompt em linha única sem aspas internas'
higgsfield generate create seedance_2_0 "--prompt" $p "--start-image" $start "--end-image" $end "--duration" "4" "--aspect_ratio" "9:16" "--json" "--no-color" 2>&1
```

> **Atenção:** here-strings do PowerShell (`@'...'@`) causam erro `Too many positional args`.
> Usar variável de string simples e passar direto.

### Aguardar geração

```powershell
higgsfield generate wait <job_id> --timeout 20m --interval 10s --json --no-color 2>&1
```

### Download

```powershell
Invoke-WebRequest -Uri $result_url -OutFile video.mp4 -TimeoutSec 120
```

---

## Etapa 2 — Encadeamento por último frame

Cada vídeo gerado serve de `--start-image` para o próximo. O script `extract_last_frame.py` extrai o frame final usando OpenCV:

```powershell
python extract_last_frame.py v1.mp4 last_v1.png
python extract_last_frame.py v2.mp4 last_v2.png
python extract_last_frame.py v3.mp4 last_v3.png
```

---

## Etapa 3 — Vídeos gerados

| Clip | Job ID | Imagens usadas | Duração gerada |
|------|--------|----------------|----------------|
| V1 | `eada3036-4c1e-43e1-a386-a763c4000167` | `1/*.png` (única) | 4.04s |
| V2 | `b01352aa-2c8f-4bd4-a2d9-19c8546da520` | start: `last_v1.png` / end: `2/*.png` | 4.04s |
| V3 | `724f2385-9a40-49e3-a7f0-b27278d8e7a8` | start: `last_v2.png` / end: `3/2.png` | 4.04s |

### URLs CloudFront

```
V1: https://d8j0ntlcm91z4.cloudfront.net/user_3DPNssNokpEjo1hW4m76lcQvSM1/hf_20260626_031009_eada3036-4c1e-43e1-a386-a763c4000167.mp4
V2: https://d8j0ntlcm91z4.cloudfront.net/user_3DPNssNokpEjo1hW4m76lcQvSM1/hf_20260626_031420_b01352aa-2c8f-4bd4-a2d9-19c8546da520.mp4
V3: https://d8j0ntlcm91z4.cloudfront.net/user_3DPNssNokpEjo1hW4m76lcQvSM1/hf_20260626_032302_724f2385-9a40-49e3-a7f0-b27278d8e7a8.mp4
```

---

## Etapa 4 — Timing e sincronização

### Timestamps da fala (copy.md)

| Palavra | Timestamp |
|---------|-----------|
| nós | 00:17.920 |
| mapear | 00:18.940 |
| e | 00:19.540 |
| isso | 00:20.420 |
| colocar | 00:20.900 |
| operação | 00:23.140 |

### Duração alvo por clip

| Clip | Início | Fim | Duração alvo |
|------|--------|-----|-------------|
| V1 | 17.920s | 19.540s | **1.62s** |
| V2 | 19.540s | 20.900s | **1.36s** |
| V3 | 20.900s | 23.800s | **2.90s** |

---

## Etapa 5 — Speed-up com FFmpeg

Cada vídeo de 4.04s foi acelerado para bater a duração alvo.

### Fórmula

```
fator_pts  = duração_alvo / duração_original
fator_speed = 1 / fator_pts
```

| Clip | Duração original | Duração alvo | Fator pts | Velocidade |
|------|-----------------|-------------|-----------|------------|
| V1 | 4.04s | 1.62s | 0.401 | **2.49x** |
| V2 | 4.04s | 1.36s | 0.337 | **2.97x** |
| V3 | 4.04s | 2.90s | 0.718 | **1.39x** |

### Comandos FFmpeg

```powershell
# V1 — 2.494x (atempo encadeado porque > 2x)
ffmpeg -y -i v1.mp4 `
  -filter_complex "[0:v]setpts=0.401*PTS[v];[0:a]atempo=2.0,atempo=1.247[a]" `
  -map "[v]" -map "[a]" v1_fast.mp4

# V2 — 2.971x (atempo encadeado porque > 2x)
ffmpeg -y -i v2.mp4 `
  -filter_complex "[0:v]setpts=0.3367*PTS[v];[0:a]atempo=2.0,atempo=1.4855[a]" `
  -map "[v]" -map "[a]" v2_fast.mp4

# V3 — 1.393x (atempo simples)
ffmpeg -y -i v3.mp4 `
  -filter_complex "[0:v]setpts=0.7179*PTS[v];[0:a]atempo=1.393[a]" `
  -map "[v]" -map "[a]" v3_fast.mp4
```

> **Nota:** `atempo` aceita apenas valores entre 0.5 e 2.0 por filtro.
> Para velocidades > 2x encadeia-se: `atempo=2.0,atempo=X` onde `2.0 × X = velocidade total`.

### Trim para duração exata

```powershell
ffmpeg -y -i v1_fast.mp4 -t 1.62 -c copy v1_trim.mp4
ffmpeg -y -i v2_fast.mp4 -t 1.36 -c copy v2_trim.mp4
ffmpeg -y -i v3_fast.mp4 -t 2.90 -c copy v3_trim.mp4
```

---

## Etapa 6 — Concatenação

```powershell
# concat_list.txt (sem BOM — usar WriteAllText, não Out-File)
[System.IO.File]::WriteAllText("concat_list.txt", "file 'v1_trim.mp4'`nfile 'v2_trim.mp4'`nfile 'v3_trim.mp4'`n")

ffmpeg -y -f concat -safe 0 -i concat_list.txt -c copy v_final.mp4
```

> **Atenção:** `Out-File -Encoding utf8` adiciona BOM e quebra o concat demuxer do FFmpeg.
> Usar `[System.IO.File]::WriteAllText()` que escreve UTF-8 sem BOM.

---

## Resultado final

| Arquivo | Duração | Resolução |
|---------|---------|-----------|
| `v_final.mp4` | **~6.08s** | 720×1280 (9:16) |

### Posição na timeline principal

Colocar `v_final.mp4` a partir de **17.920s**. Os cortes internos já estão embutidos:

```
17.920s ──[V1 1.62s]──► 19.540s ──[V2 1.36s]──► 20.900s ──[V3 2.90s]──► 23.800s
```

---

## Arquivos intermediários (podem ser deletados)

```
v1_fast.mp4   v2_fast.mp4   v3_fast.mp4
v1_trim.mp4   v2_trim.mp4   v3_trim.mp4
concat_list.txt
last_v1.png   last_v2.png   last_v3.png
```
