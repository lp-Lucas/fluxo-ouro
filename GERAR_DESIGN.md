# Como o design é gerado hoje (FLOW)

> Explicação ponta a ponta do que o app faz **atualmente** para gerar a **tela de
> design** de uma frase — do clique do usuário até o PNG 9:16 salvo no projeto.
> Reflete o código como está hoje (fluxo novo `gerar-design` + fit com outpaint e
> emenda suavizada).

---

## 0. TL;DR do fluxo atual

```
FRASE + 2 SLOTS (layout, estilo) + briefing + cores + elementos
        │
   [1] Claude-COMPILADOR vê as imagens e ESCREVE o prompt (longo, estruturado)
        │        (ou autor curto, se não houver layout / flag raw)
        ▼
   [2] GPT-5 (Responses) VÊ as MESMAS imagens + o prompt e gera via gpt-image
        │
        ▼
   [3] saveImageFit: outpaint (IA regenera as bandas) + EMENDA suavizada → 9:16
        │
        ▼
   PNG salvo em projects/<id>/assets/flow/  +  .prompt.txt (auditoria)
```

Endpoint principal: **`POST /api/flow/gerar-design`**. É um **job assíncrono**
(responde `{ jobId }`, o front faz polling em `/api/flow/progress/:id`), e é
**cancelável** (`/api/flow/cancel/:id`).

---

## 1. O que a interface envia

No [FlowPanel.tsx](frontend/src/modules/flow/FlowPanel.tsx) (`enviarGerarDesign`),
para cada frase o front manda ao backend:

| Campo | O que é |
|---|---|
| `texto` | O **headline** — a frase do momento, o único texto na tela. |
| `layout` | **Slot 1 (data URL)** — o design de referência cuja **composição** é preservada. |
| `estilo` | **Slot 2 (data URL)** — a **linguagem visual** (paleta/luz/materiais). Opcional. |
| `prompt` | O **briefing** (1 linha basta) — a cena: o que aparece, onde, o que evitar. |
| `cores` | A **COLOR LAW** do projeto (campo `cores` da identidade) — as únicas cores permitidas. |
| `elementos[]` | Até **4** objetos que devem aparecer replicados fielmente (nota, produto, logo…). |
| `modo` | `restyle` (layout é design pronto) ou `esboco` (layout é rascunho/blueprint). |
| `aspect` | Proporção da tela (padrão `9:16`). |

> **Antes disso**, dois passos preparam o terreno:
> - **Detecção de momentos** (`/api/flow/detect`, [claude.ts](backend/src/flow/claude.ts) `detectFlowMoments`): a IA lê a transcrição (+copy) e devolve **3 a 5 momentos**, cada um quebrado em **frases** por índice de palavra (cada frase = **uma cena visual = uma tela**). Regra de ouro: quebra quando a *imagem muda* ("de X → para Y" viram duas telas).
> - **Análise de estilo** (`/api/flow/analyze-style`, [visionPrompt.ts](backend/src/flow/visionPrompt.ts) `analyzeStyle`): opcional — o Claude *olha* a referência da marca e resume o look (fundo, paleta, tipografia, materiais). Isso permite que a imagem de estilo **não precise ir** ao gerador como pixel (evita cópia de conteúdo).

---

## 2. Passo [1] — o Claude escreve o prompt (o "autor")

Este é o coração do fluxo novo: **o Claude é o autor do prompt de imagem**, não o
gerador. Ele **vê** as imagens (via [visionFromPaths](backend/src/flow/visionPrompt.ts)
— API Anthropic com imagens em base64 se `ANTHROPIC_API_KEY`, senão o CLI `claude -p`
com a ferramenta Read) e escreve o texto que vai ao gerador. Há **dois autores**,
escolhidos por tarefa:

### 2.1 COMPILADOR — [promptCompiler.ts](backend/src/flow/promptCompiler.ts) `compileImagePrompt`

Usado quando **há layout** e `FLOW_PROMPT_AUTHOR=claude` (padrão). Replica o que o
ChatGPT faz internamente: expande o pedido de 1 linha num prompt **LONGO e
estruturado** (400–800 palavras) em inglês, com cabeçalhos obrigatórios:

- **COMPOSITION & LAYOUT PRESERVATION** — a composição da Imagem 1, elemento a
  elemento, com posições (o resultado deve poder ser sobreposto ao original);
- **TEXT CONTENT** — todo texto verbatim, entre aspas, e onde;
- **TYPOGRAPHY** — família/peso/caixa/tratamento (glow, caixa de destaque);
- **COLOR PALETTE** — cores exatas (nomeia e aproxima hex), o que é fundo/acento/texto;
- **LIGHTING & MATERIALS**, **BACKGROUND & DEPTH**, **RESTRICTIONS**;
- **ELEMENTS** (se houver) — cada elemento anexado descrito pelo que é, com réplica
  fiel + posição + "suas cores não influenciam a paleta".

Dois **modos**:
- **`restyle`** (padrão): Imagem 1 é um design **pronto** → preservar a composição
  elemento a elemento; a Imagem 2 fornece só a "pele" visual.
- **`esboco`**: Imagem 1 é um **sketch/blueprint** → restrição **geométrica 100%**
  (posição/escala/alinhamento/margens/enquadramento), **nunca** estética; o traço
  cru vira arte final polida nos mesmos lugares. Regra de conflito explícita: *"the
  sketch has priority over the style reference."*

Robustez: exige a saída entre `<PROMPT_FINAL>…</PROMPT_FINAL>` com ≥150 palavras;
**2 tentativas**; se falhar o formato, cai para o **autor curto**.

### 2.2 AUTOR CURTO — [authorPrompt.ts](backend/src/flow/authorPrompt.ts) `authorDesignPrompt`

Usado **sem layout** (compor a partir do estilo + briefing) ou como **fallback** do
compilador, ou com `FLOW_PROMPT_AUTHOR=raw`. Escreve um corpo **curto** (alvo ~60
palavras, teto duro 120) — calibrado para *compor de esboço*, não para restyle
denso. Também pode extrair um `<STYLE_DESC>` da imagem de estilo. Se não há estilo
(ganho ~nulo), degrada para `raw` (delta cru + identidade).

### 2.3 COLOR LAW — [shared/flow.ts](shared/flow.ts) `colorLaw`

O campo `cores` do projeto vira um bloco de **prioridade máxima** injetado no prompt:

> *PROJECT IDENTITY — MAXIMUM PRIORITY. COLOR LAW (strict): the ONLY colors allowed
> anywhere on screen … are `<cores>`. Any other color family is an ERROR. Reference
> images keep their own colors but never change the screen's palette.*

É o que impede a paleta de "vazar" das imagens de referência para a tela.

---

## 3. Passo [2] — GPT-5 vê as imagens e gera (modo ChatGPT)

O prompt compilado **+ as mesmas imagens** (layout, estilo, elementos, **na mesma
ordem**) vão ao provider com `chatgptStyle: true`:

```ts
getImageProvider().generate({
  prompt: promptFinal,
  aspectRatio: aspect,
  references: [layout, estilo, ...elementos],
  chatgptStyle: true,
})
```

No [OpenAIImageProvider](backend/src/providers/OpenAIImageProvider.ts) isso vira uma
chamada ao **`/v1/responses`** com o **`OPENAI_CHAT_MODEL` (gpt-5)**: o GPT-5
recebe o texto + as imagens como `input_image`, **enxerga** tudo e chama a
ferramenta `image_generation` sozinho (que por baixo usa o gpt-image) — exatamente
como o ChatGPT. Retorna a imagem em base64 (data URL). Uma imagem por chamada.

> Por que "modo ChatGPT" e não o `/images/edits` direto: o GPT-5 no meio **vê** as
> imagens e concilia composição (layout) + estilo + elementos com julgamento, em vez
> de o gpt-image tentar fundir tudo cru. É o que dá paridade com o resultado manual.

---

## 4. Passo [3] — encaixe na proporção com bordas por IA — [ffmpeg.ts](backend/src/flow/ffmpeg.ts) `saveImageFit`

O gpt-image **não gera 9:16 nativo** (o máximo em retrato é 2:3, 1024×1536). Para
virar 1080×1920 (9:16) com cara de **imagem nativa** (fundo contínuo, sem parecer
adaptada), o `saveImageFit` usa **INPAINT MASCARADO** (`outpaintBordas`):

1. Monta um canvas **completo** no tamanho do gpt-image com a imagem no centro e as
   faixas restantes **pré-preenchidas** esticando a linha da borda. *Nada de
   transparência* — canvas transparente convidava o modelo a "continuar o desenho"
   (era a causa das **bandas com conteúdo duplicado**).
2. Manda ao `/images/edits` (**gpt-image-2**; cai pro -1 se recusar) com **máscara
   explícita**: transparente = repintar (faixas), opaco = manter (centro). O modelo
   vê a imagem **inteira** (contexto → continuidade) e repinta **só as bordas**.
3. O prompt leva uma **âncora de cor amostrada** da própria imagem (o hex real da
   junção, ex.: `#050b1f`) e proíbe textura/ruído/vinheta — sem isso o modelo
   alucinava o tom da faixa (navy → marrom texturizado, visto em teste).
4. Recorta o frame da proporção alvo, escala para WxH e **crava o original de
   volta** no centro (feather curto de 24px só para dissolver microdesvio de cor).
5. **Fallback** (sem provider ou IA falhou): contain + linha da borda esticada.
   **Sem corte central e sem blur** — banidos (liam como "imagem adaptada").

Resultado: borda = fundo regenerado pela IA em continuidade com o design; centro =
original pixel a pixel. Validado nos dois casos reais que falhavam (emenda escura e
logos duplicados).

---

## 5. Onde salva e auditoria

`projects/<projectId>/assets/flow/`:
- `design-<phraseId>-<ts>.png` — a tela gerada;
- `design-<phraseId>-<ts>.png.prompt.txt` — **auditoria**: a fonte do prompt
  (`compilador` / `autor curto` / `raw`), a contagem de palavras, tentativas e o
  **prompt final** usado.

As imagens de referência (data URLs) são gravadas em `.tmp-design-<phraseId>/` só
durante a geração e apagadas ao fim.

---

## 6. Caminhos irmãos (ainda existem)

| Rota | Uso hoje |
|---|---|
| **`/api/flow/gerar-design`** | **Fluxo principal atual** (este documento). |
| `/api/flow/design-chat` | Chat estilo ChatGPT — refinar/"continuar" a partir do último resultado, texto verbatim + imagens. Ainda ligado no painel. |
| `/api/flow/upload-design` | Subir a própria arte (sem IA) — só ajusta a proporção. |
| `/api/popup-element` | Elemento isolado em **PNG transparente** (gpt-image-1, `background: transparent`) para sobrepor no vídeo. |
| `/api/flow/design` | **Legado (Fase 2)** — multi-tag por `orderRefs`/`buildDesignPromptDirect`. Fora do fluxo atual. |

---

## 7. Configuração relevante (`backend/.env`)

| Variável | Valor / padrão | Papel |
|---|---|---|
| `IMAGE_PROVIDER` | `openai` | Provider de imagem (trocável: `openai`/`gemini`). |
| `OPENAI_CHAT_MODEL` | `gpt-5` | Modelo que **vê as imagens e gera** (modo ChatGPT / Responses). |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` | Modelo de imagem padrão (o outpaint usa `gpt-image-1`). |
| `OPENAI_IMAGE_QUALITY` | `high` | Qualidade. |
| `FLOW_PROMPT_AUTHOR` | `claude` | `claude` = usa o compilador; `raw` = desativa (delta cru). |
| `ANTHROPIC_API_KEY` | (opcional) | Se presente, a **visão** do autor usa a API; senão o CLI `claude -p` logado. |
| `ANTHROPIC_VISION_MODEL` | `claude-sonnet-5` | Modelo de visão do autor. |

---

## 8. Papéis das imagens — resumo

| Papel | Regra |
|---|---|
| **LAYOUT** (Imagem 1) | A **composição** é sagrada (restyle) ou a **geometria** é sagrada (esboço). |
| **ESTILO** (Imagem 2) | Só a **linguagem visual** (paleta/luz/materiais/tipografia). Nunca composição nem, sob COLOR LAW, a paleta. |
| **ELEMENTOS** (até 4) | Objetos **replicados fielmente**; cores do elemento **não** contaminam a paleta da tela. |
| **COLOR LAW** (campo `cores`) | As **únicas** cores permitidas na tela. |
| **texto** | O **headline** — o único texto renderizado. |

---

## 9. Mapa de arquivos

```
frontend/src/modules/flow/
└── FlowPanel.tsx              # enviarGerarDesign / enviarChat / detectar / analisarEstilo

backend/src/
├── server.ts                 # /api/flow/gerar-design, detect, analyze-style, cancel, progress
├── flow/
│   ├── promptCompiler.ts      # compileImagePrompt — o Claude-COMPILADOR (prompt longo)
│   ├── authorPrompt.ts        # authorDesignPrompt — autor CURTO (fallback / sem layout)
│   ├── visionPrompt.ts        # visionFromPaths, analyzeStyle (Claude que ENXERGA)
│   ├── claude.ts              # detectFlowMoments (frases), refRole/orderRefs (legado)
│   └── ffmpeg.ts              # saveImageFit + outpaintBordas (inpaint mascarado das bordas)
├── providers/
│   ├── ImageProvider.ts       # interface (contrato)
│   ├── index.ts               # getImageProvider() por IMAGE_PROVIDER
│   └── OpenAIImageProvider.ts # Responses (modo ChatGPT/gpt-5) + edits + outpaint
└── shared/flow.ts            # aspectDims, colorLaw, FlowIdentity, FlowMoment/FlowPhrase

projects/<id>/assets/flow/    # design-*.png + .prompt.txt (auditoria)
```

---

## 10. Resumo em uma frase

> Hoje o design nasce assim: o **Claude vê as 2 imagens** (layout + estilo) e
> **compila um prompt longo e estruturado** (preservando composição, aplicando a
> linguagem visual, obedecendo a COLOR LAW); esse prompt **+ as mesmas imagens** vão
> ao **GPT-5, que enxerga tudo e gera** via gpt-image; e o `saveImageFit` **regenera
> as bordas com IA e suaviza a emenda** para entregar a tela 9:16 — tudo assíncrono,
> cancelável e auditado num `.prompt.txt`.
