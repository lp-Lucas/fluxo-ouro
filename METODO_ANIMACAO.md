# MÉTODO DE ANIMAÇÃO — MotionIA
> Documento de referência: como os vídeos eram animados, como os prompts eram
> executados, como os clipes eram juntados e como a continuidade entre clipes
> acontecia sozinha. Escrito para ser reaproveitado em outro aplicativo.

---

## 0. VISÃO GERAL — os 3 motores de animação

O pipeline nunca dependeu de um único método. Havia **três motores** e cada um
resolvia um tipo de movimento diferente. Entender qual usar em cada caso é o
coração do método.

| Motor | O que faz | Onde vive | Quando usar |
|-------|-----------|-----------|-------------|
| **1. IA generativa (Higgsfield / Seedance 2.0)** | Gera vídeo a partir de imagem(ns) + prompt de movimento. Anima o "impossível": glassmorphism flutuando, luz varrendo, fragmentos de cristal driftando. | `flowstudio/`, `image1..22/` | Motion de b-roll, transições ricas, qualquer coisa que seria caro animar à mão. |
| **2. Composição programática (Python + OpenCV + PIL)** | Sobrepõe elementos (ícones, sombras, física de mola) sobre um vídeo real, frame a frame. Determinístico, pixel-perfeito. | `vid1/compose.py`, `compose_behind.py` | Quando você tem um vídeo gravado e quer adicionar elementos animados com timing exato, inclusive **atrás** da pessoa (segmentação). |
| **3. Remotion (React → vídeo)** | Legendas karaokê, overlays, zoom, tudo dirigido por timeline e `spring()`. | `motion-editor/`, `my-video/` | Legendas palavra-a-palavra, texto sincronizado com fala, edição de timeline. |

A regra mental: **IA para o que é orgânico e caro; Python para o que precisa ser
exato; Remotion para o que é dirigido por texto/tempo.**

---

## 1. COMO OS VÍDEOS ERAM ANIMADOS (motor 1 — IA)

### 1.1 O princípio fundamental: START FRAME → END FRAME

Toda animação de IA nasce de **duas imagens** (não de texto puro):

- **Start image** = o estado A da cena (ex: card azul, "problema não é quanto entra", barra 94%)
- **End image** = o estado B da cena (ex: card escuro, "e quanto some", barra 13%)

O modelo (Seedance 2.0 via Higgsfield) **interpola o movimento entre A e B**. O
prompt não descreve como as coisas *parecem* — a imagem já diz isso. O prompt
descreve **o que se move, o que persiste e como muda** (ver `VIDEO_PROMPT_RULES.md`).

> Exemplo real de job — `image1/seedance_job.log`:
> - `role: "start_image"` → card azul, barra cheia
> - `role: "end_image"` → card vermelho, barra drenada
> - `prompt`: descreve a barra drenando, o glow mudando de azul→vermelho, a
>   tipografia entrando palavra por palavra com timestamps exatos.

### 1.2 As regras de prompt (resumo operacional)

Do `VIDEO_PROMPT_RULES.md`, o que importa replicar:

- **Máx. 2500 caracteres** por prompt (limite do Higgsfield). Escrever denso.
- **Descrever movimento, não aparência.**
- **Separar elementos PERSISTENTES de TRANSITÓRIOS:**
  - Persistentes (nunca somem): background estático, glass card flutuando,
    fragmentos de cristal driftando, light sweep em loop, câmera push-in.
  - Transitórios (entram/saem por cena): a tipografia.
- **Timing interno padrão de 5s:**
  ```
  0.0–1.0s  Texto do frame A entra (pop + up, linha por linha)
  1.0–2.0s  Cena estabelecida (card flutua, fragments driftam, sweep corre)
  2.0–2.5s  Texto A sai (pop + up, bottom-to-top)
  2.5–3.0s  Pausa limpa (só card + fragments)
  3.0–5.0s  Texto do frame B entra
  ```
- **Vocabulário de movimento fixo** (pop+up, scale-in bounce, float sinusoidal,
  light sweep, draw-on line, counter numérico, chrome drift, camera push-in) —
  ver tabela REGRA V7. Reusar esse vocabulário garante consistência entre clipes.

### 1.3 Template de prompt (start/end frame)

```
[PERSISTENT ELEMENTS — never cut or reset]
Glass card: [float]. Light sweep: [loop]. Chrome fragments: drift.
Camera: slow push-in ~3% over full clip. Background: static.

[TYPOGRAPHY TRANSITION]
0s–Xs: Frame A text ([copy]) exits — [motion], [direção].
Xs–Ys: Clean pause. Only card and fragments visible.
Ys–5s: Frame B text ([copy]) enters — [motion], [direção].

[CARD CONTENT]
[só se houver animação interna: draw-on, counter…]

[FEEL]
[uma frase de mood — ex: "Premium, controlled, Apple keynote energy."]
```

---

## 2. COMO OS PROMPTS ERAM EXECUTADOS (FlowStudio)

O `flowstudio/` é o executor. Não é o Higgsfield direto — é uma camada por cima
do **CLI `higgsfield`**, com controle de custo e um editor de fluxo em nós.

### 2.1 Arquitetura

- **Backend:** `flowstudio/app.py` (Flask, porta 5003).
- **Frontend:** editor de nós React Flow (`src/nodes/*.jsx`).
- **Motor de geração:** subprocess chamando o binário `higgsfield`.

### 2.2 O fluxo de uma geração (passo a passo real)

1. **Upload da imagem** → `POST /api/upload` → roda `higgsfield upload <arquivo>`
   → retorna um `upload_id`.
2. **Estimar custo antes de gerar** (`_estimate_cost`) → roda
   `higgsfield generate cost <model> --prompt … --image <id>`.
   Se passar de `CREDIT_LIMIT = 30` créditos, **bloqueia** e pede pra reduzir
   duração ou cair pra 720p. *(Trava de segurança contra queimar créditos.)*
3. **Gerar** → `POST /api/generate` dispara, em thread:
   ```
   higgsfield generate create <model>
     --prompt "<prompt>"
     --image  <upload_id>
     --wait --wait-timeout 15m --wait-interval 8s
     --json --no-color
   ```
4. **Parse robusto da resposta** (`extract_video_url`): procura a URL do `.mp4`
   em qualquer formato de JSON, com fallback de regex no texto cru. O CLI às vezes
   imprime linhas não-JSON antes do payload — por isso o parse tenta de trás pra frente.
5. **Download** do vídeo pro `outputs/`.
6. **Relatório de créditos** pós-geração (saldo + gasto na transação).

### 2.3 O editor de nós (a lógica visual)

Cada geração é montada conectando **nós** (`src/nodes/`):

- `PromptNode` → o texto do prompt
- `ImageInputNode` → a imagem (start/end frame)
- `ModelNode` → modelo + params (aspect_ratio 9:16, duration, resolution, mode, audio)
- `GenerateNode` → o botão que junta os 3 inputs e dispara `/api/generate`,
  depois faz **polling** de `/api/job/<id>` a cada 6s até `done`.
- `VideoPreviewNode` → mostra o resultado.

**Detalhe-chave para continuidade (§4):** o `GenerateNode` tem uma saída `video`
que **propaga a URL do vídeo gerado para o próximo nó** (`propagateVideo`). É isso
que permite encadear gerações — a saída de um clipe alimenta a entrada do próximo.

---

## 3. COMO OS CLIPES ERAM JUNTADOS

Há duas junções diferentes, não confundir:

### 3.1 Junção por composição (sobrepor elementos num vídeo) — Python

`vid1/compose.py` e `compose_behind.py`. Aqui você **não concatena** clipes —
você **empilha camadas** sobre um vídeo existente, frame a frame.

Física de mola (o que dá o "feel" premium sem After Effects):

```python
def spring_y(t, t0, final_y, start_y, d=5.5, w=8):
    # mola amortecida: start → final com overshoot (bounce)
    tau = t - t0
    return final_y + (start_y - final_y) * exp(-d*tau) * cos(w*tau)

def spring_scale(t, t0, d=7, w=9):   # 0 → 1 com overshoot até ~1.15
def ease_opacity(t, t0, dur=0.18):   # fade in linear
```

Cada elemento (ícone) tem:
- posição de repouso (`L_CX, L_CY`),
- um `t0` de entrada escalonado (`L_T0=0.45s`, `R_T0=0.80s` → stagger),
- sombra pré-renderizada (`add_shadow`: blur gaussiano + offset + opacidade).

O loop principal, por frame:
1. lê o frame do vídeo, redimensiona pra 1080×1920;
2. calcula `t = frame_n / fps`;
3. compõe cada ícone na posição/escala/opacidade daquele `t`;
4. escreve o frame.

**Versão "behind" (`compose_behind.py`)** — o truque avançado: coloca o ícone
**atrás da pessoa**. Ordem das camadas por frame:
```
Layer 0: frame original (background)
Layer 1: ícones animados (mola)
Layer 2: pessoa recortada (rembg / u2net segmenta a pessoa)  ← colada por cima
```
A pessoa é segmentada em meia-resolução (540×960) por velocidade e a máscara é
reescalada. Resultado: o ícone parece estar no ambiente, atrás do apresentador.

**Áudio:** em ambos, o vídeo é reescrito sem áudio e depois o ffmpeg remuxa o
áudio original:
```
ffmpeg -i out_raw.mp4 -i original.mp4 -map 0:v -map 1:a? \
       -c:v libx264 -crf 17 -preset fast -c:a copy out_final.mp4 -y
```

### 3.2 Junção por concatenação (clipe A + clipe B em sequência)

Quando você tem vários clipes de 5s gerados pela IA e quer um vídeo único, a
concatenação é com ffmpeg. Duas formas:

**a) Concat sem re-encode** (rápido, exige mesmos codec/resolução/fps):
```
# lista.txt:
#   file 'v2_personalizado.mp4'
#   file 'v3_marca.mp4'
ffmpeg -f concat -safe 0 -i lista.txt -c copy saida.mp4
```

**b) Concat com re-encode** (quando os clipes divergem em params):
```
ffmpeg -i a.mp4 -i b.mp4 \
  -filter_complex "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]" \
  -map "[v]" -map "[a]" saida.mp4
```

> Os `v2_personalizado.mp4`, `v3_marca.mp4`, `v4_pix.mp4`, `v5_recorrencia.mp4`
> na raiz são exatamente esse tipo de saída — clipes temáticos que compõem uma
> sequência maior.

### 3.3 Junção por timeline (Remotion — legendas/overlays)

No `motion-editor/`, a "junção" é o render final da Remotion: `VideoLayer` +
`OverlayLayer` + `CaptionLayer` compostos numa `MainComposition` e exportados via
`renderMedia()`. Aqui o vídeo-base e as legendas viram um único MP4.

---

## 4. CONTINUIDADE AUTOMÁTICA ENTRE CLIPES (o segredo)

Esta é a parte que "se junta sozinha". Não é mágica de edição — é **um invariante
imposto na geração**. Dois mecanismos combinados:

### 4.1 A regra do frame compartilhado (continuidade visual)

**O END FRAME do clipe A é o START FRAME do clipe B.**

- Clipe 1: start = imagem_1, end = imagem_2
- Clipe 2: start = **imagem_2**, end = imagem_3
- Clipe 3: start = **imagem_3**, end = imagem_4
- …

Como o último frame renderizado do clipe A é (praticamente) igual à imagem_2, e o
primeiro frame do clipe B parte da mesma imagem_2, a emenda fica **invisível**. O
espectador vê um movimento contínuo, não um corte.

### 4.2 A regra do elemento-âncora (continuidade de identidade)

Dentro dessa cadeia, alguns elementos **nunca podem mudar** entre A e B (REGRA V3/V4):

- O **glass card** (âncora) é **idêntico** nos dois frames — mesma posição, mesmo
  tilt 3D, mesma opacidade. Ele é a "constante" da cena.
- O **background** é idêntico nos dois frames.
- A **tipografia** é a única coisa que muda.

Frase-mantra do método (aparece nos prompts): *"One card. Four states. No cuts.
Only motion."* / *"Card is the constant. Typography is the story."*

Assim, mesmo gerando 4–6 clipes independentes, todos partilham o mesmo universo
visual e a mesma âncora → parecem um único vídeo.

### 4.3 Multi-image numa só geração (continuidade sem emenda)

Para cadeias curtas, dá pra pular a concatenação: o Seedance aceita **várias
imagens no campo multi-image** e gera um clipe contínuo passando por todas.
Ver "Série Estoque" no `VIDEO_PROMPT_RULES.md`:

> "Four images, one continuous world. … Camera: slow continuous push-in … Never
> cuts, never resets. **This movement IS the transition between phases.**"

Aqui a câmera em push-in contínuo é o que costura as 4 fases — não há emenda
porque é um render só. Cada "PHASE" no prompt tem sua janela de tempo
(0–2.2s, 2.2–4.8s, …) e o modelo transita entre elas dentro do mesmo clipe.

### 4.4 Encadeamento automático no FlowStudio

No editor de nós, `GenerateNode.propagateVideo()` empurra a saída de um clipe
para o próximo nó. A lógica de encadeamento é: **a saída de um estágio vira a
entrada do seguinte**, então montar a cadeia A→B→C é conectar nós, não editar
manualmente. (Hoje propaga a URL do vídeo; a extensão natural — ver §6 — é
propagar o *último frame* como start-image do próximo clipe, automatizando a
regra 4.1.)

---

## 5. RECEITA COMPLETA — do zero a um vídeo contínuo

1. **Roteiro + copy** com timestamps (ver `copy.md`: transcrição palavra-a-palavra
   com tempos → define as janelas de cada fase/cena).
2. **Gerar os frames-chave** (imagens estáticas): imagem_1, imagem_2, … — cada
   par vira uma cena. Manter o card-âncora e o background idênticos entre frames
   vizinhos.
3. **Escrever o prompt de movimento** (≤2500 chars) para cada par start/end,
   usando o vocabulário fixo e o timing de 5s.
4. **Executar no FlowStudio**: upload das imagens → checar custo → gerar → baixar.
   Encadear: end de um = start do próximo.
5. **(Opcional) Composição Python** por cima de trechos gravados (ícones/física,
   inclusive atrás da pessoa via segmentação).
6. **(Opcional) Legendas/overlays** no motion-editor (Remotion, karaokê sincronizado).
7. **Juntar tudo** com ffmpeg (concat sem re-encode se os params baterem; senão
   filter_complex concat), remuxando o áudio.

---

## 6. O QUE LEVAR PARA O OUTRO APLICATIVO

Os princípios transferíveis (independentes de Higgsfield/Seedance):

1. **Animação nasce de estados, não de texto.** Modele tudo como
   `start_state → end_state` e deixe o motor interpolar. Prompt = o *delta*.
2. **Separe PERSISTENTE de TRANSITÓRIO.** Defina, por cena, o que é âncora
   (nunca muda) e o que é história (entra/sai). Isso sozinho resolve 90% da
   sensação de continuidade.
3. **Continuidade = invariante, não pós-produção.** Compartilhe o frame de
   fronteira (end de A = start de B) e um elemento-âncora idêntico. A emenda
   some por construção.
4. **Prefira um render contínuo (multi-image) a concatenar**, quando a cadeia é
   curta — a câmera contínua vira a própria transição.
5. **Vocabulário de movimento fixo e reutilizável** (pop+up, spring scale, float,
   sweep, draw-on, counter, drift, push-in) → consistência entre clipes gerados
   em momentos diferentes.
6. **Física de mola determinística** (`spring_y`, `spring_scale`, `ease_opacity`)
   para o que precisa ser exato — barato, sem dependência de IA, replicável em
   qualquer linguagem.
7. **Camadas com segmentação** (background → elemento animado → pessoa recortada)
   para inserir gráficos "no mundo" atrás do apresentador.
8. **Trava de custo antes de gerar** (estimar → bloquear acima de um limite) e
   **parse robusto de resposta** (múltiplos formatos + fallback regex) — dois
   detalhes de engenharia que evitam dor com CLIs de IA generativa.
9. **Encadeamento por grafo** (nós conectados, saída→entrada) é o modelo mental
   certo para pipelines de vídeo multi-etapa. A propagação automática do último
   frame como start-image do próximo clipe é a evolução natural a implementar.

---

*Referências no repositório: `VIDEO_PROMPT_RULES.md` (regras de prompt),
`DESIGN_RULES.md` (identidade visual), `copy.md` (roteiro com timestamps),
`flowstudio/app.py` (executor), `flowstudio/src/nodes/` (grafo),
`vid1/compose*.py` (composição/física/segmentação),
`motion-editor/contextoeditor.md` (legendas/timeline/Remotion),
`image1/seedance_job.log` (exemplo real de job start/end frame).*
