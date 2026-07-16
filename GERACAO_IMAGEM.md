# Geração de imagem — como funciona hoje no app

> Contexto do subsistema que gera as **telas de design** (e elementos gráficos)
> do módulo **FLOW** — o motion design por IA. A partir de uma frase da copy +
> referências visuais da marca, o app gera uma imagem (a "tela") que depois é
> animada. Este documento descreve o estado **atual** do código.

---

## 1. Panorama em uma frase

> Um **provider de imagem** trocável (OpenAI hoje, Gemini alternativo) gera a
> tela a partir de um **prompt** + **imagens de referência** com papéis
> definidos (estilo, esboço, elemento, logo, série). O backend monta o prompt,
> chama o provider, **ajusta a imagem para a proporção do vídeo** e salva em
> `assets/flow/`. Tudo roda como **job assíncrono** (com polling), cancelável.

---

## 2. Configuração atual (`backend/.env`)

| Variável | Valor atual | Papel |
|---|---|---|
| `IMAGE_PROVIDER` | `openai` | Qual provider usar (`openai` \| `gemini`). |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` | Modelo de geração padrão. |
| `OPENAI_CHAT_MODEL` | `gpt-5` | Modelo do "modo ChatGPT" (interpreta pedido + imagens). |
| `OPENAI_IMAGE_QUALITY` | (padrão `high`) | Qualidade das imagens. |
| `OPENAI_API_KEY` | *(definida)* | Autenticação OpenAI. |
| `FLOW_DESIGN_VARIATIONS` | (padrão `3`) | Nº de variações por geração (o usuário escolhe a melhor). |

> **gpt-image-2 vs gpt-image-1** (decisão registrada no código):
> - **gpt-image-2** é o padrão — segue as referências com **muito mais
>   fidelidade/consistência** (o -1 reinterpretava e fugia da identidade). É mais
>   lento (~2 min), mas melhor.
> - **gpt-image-1** é usado **pontualmente** onde o -2 não serve: **fundo
>   transparente** (elementos de popup) e **outpaint/edições** — recursos que o
>   -2 **rejeita**. O `input_fidelity=high` também só existe no -1.

---

## 3. Arquitetura — provider trocável

Regra de arquitetura: trocar OpenAI ↔ Gemini deve ser **só plugar outro
provider**, sem reescrever o FLOW. Todo o resto depende **apenas da interface**,
nunca de um provider concreto.

```
backend/src/providers/
├── ImageProvider.ts        # a INTERFACE (contrato) — todos dependem só dela
├── index.ts                # getImageProvider() escolhe por IMAGE_PROVIDER
├── OpenAIImageProvider.ts  # implementação principal (OpenAI Images / Responses)
└── GeminiProvider.ts       # implementação alternativa (Nano Banana / Gemini)
```

### A interface — [`ImageProvider.ts`](backend/src/providers/ImageProvider.ts)

```ts
interface ImageProvider {
  name: string;
  generate(input: GenerateImageInput): Promise<GenerateImageResult>;
  outpaint?(imagePath, prompt, size, signal): Promise<string>; // opcional (só OpenAI)
}
```

`GenerateImageInput` carrega tudo que a geração precisa:

| Campo | Significado |
|---|---|
| `prompt` | O texto que descreve a tela. |
| `aspectRatio` | `"9:16"` (padrão), `"16:9"`, `"1:1"`. |
| `references[]` | Imagens de referência (`{ path, tag }`) — quando presentes, usa o **endpoint de edição** do modelo. |
| `count` | Quantas variações gerar numa chamada (1–4). |
| `background` | `"transparent"` para PNG com alpha (elementos sobrepostos). |
| `model` | Força um modelo nesta chamada (ex.: `gpt-image-1` p/ transparência). |
| `chatgptStyle` | Ativa o "modo ChatGPT" (ver §4.3). |
| `signal` | `AbortSignal` — o botão "parar" do usuário. |

`getImageProvider()` lê `IMAGE_PROVIDER` e instancia o provider certo. O Gemini
(Nano Banana) usa a **mesma chave do Veo** (`GOOGLE_VIDEO_API_KEY`).

---

## 4. OpenAI provider — os três caminhos de geração

[`OpenAIImageProvider.ts`](backend/src/providers/OpenAIImageProvider.ts) escolhe o
endpoint conforme o input:

### 4.1 Texto → imagem (`/v1/images/generations`)
Sem referências. Manda `model`, `prompt`, `size`, `n`, `quality`. É o caminho
mais simples: só o prompt.

### 4.2 Imagens + texto → imagem (`/v1/images/edits`)
Quando há **referências** (logo/estilo/esboço/elemento). Envia as imagens de fato
(`image[]`, multipart) junto do prompt, para elas **influenciarem** o resultado.
Com gpt-image-1 adiciona `input_fidelity=high` (seguir de perto as anexadas).
Este é o caminho normal do design de frase quando há refs.

### 4.3 Modo ChatGPT (`/v1/responses`)
Ativado por `chatgptStyle: true`. Um modelo **GPT (4o/5)** recebe o texto do
usuário + as imagens, **interpreta** (expande, contextualiza, olha as refs) e
chama a ferramenta `image_generation` **sozinho** — exatamente como o ChatGPT.
Uma imagem por chamada; N variações = N chamadas em paralelo. Usado pelo **chat
de design** (§6), onde o controle é 100% do usuário, sem templates.

### 4.4 Outpaint (`/v1/images/edits`, gpt-image-1)
Recebe um PNG com áreas **transparentes** e as preenche (a própria transparência
é o sinal de "gere aqui"). Usado no ajuste de proporção (§7) para **completar as
bandas** 9:16 em vez de borrar.

Em todos os casos a saída vem como **base64** e é devolvida como **data URL**
(`data:image/png;base64,…`); o FLOW salva em `assets/flow/`.

---

## 5. Como o prompt é montado — o papel de cada referência

O coração da qualidade não é só o modelo — é **como** as imagens e o texto são
combinados. Cada referência tem uma **tag** que define seu papel, e o prompt é
construído para dizer ao gpt-image o que fazer com cada uma.

### 5.1 Tags (papéis) das referências

| Tag | Papel no prompt |
|---|---|
| `estilo` | **MASTER STYLE** — o "mundo visual" (fundo, paleta, luz, materiais, tipografia). A tela inteira é renderizada nesse mundo, como se feita pelo mesmo designer. **Nunca** copia o texto/composição dele. |
| `esboco` | **LAYOUT** — o blueprint de composição (onde cada coisa vai). Rótulos manuscritos ("titulo", "logo", "elemento 1") **nomeiam** posições, nunca são renderizados como texto. Ignora as cores do rascunho. |
| `referencia` | **ELEMENTO** (numerado: ELEMENTO 1, 2…) — objeto a ser **replicado fielmente** (mesma forma/cores/detalhes), sem redesenhar. As cores dele **não** contaminam a paleta da tela. |
| `logo` | A **logo exata** do cliente, inalterada, onde o layout marca. |
| `serie` | Uma tela **já aprovada** do mesmo vídeo — a nova deve compartilhar o **mesmo sistema de design** (fundo, paleta, tipografia), sem copiar composição/texto. Consistência entre telas. |

`orderRefs()` ordena as refs por papel (layout primeiro, estilo, logo por
último) — ordem estável, para o modelo mapear "Image 1, Image 2…" com
previsibilidade.

### 5.2 Bloco de IDENTIDADE — [`shared/flow.ts`](shared/flow.ts) `identityToPrompt()`

A identidade do projeto (cores, tipografia, botões, ícones, `styleDesc`) vira um
bloco de **prioridade máxima** no topo do prompt:

- **`PROJECT IDENTITY — MAXIMUM PRIORITY`**: sobrepõe referências, layout e cena;
- **COLOR LAW (estrita)**: as cores do projeto são as **únicas** permitidas na
  tela (fundo, texto, banners, acentos) — qualquer outra família de cor é erro;
- tipografia/botões/ícones fixados por preset.

> **Cinto e suspensório**: no endpoint `/api/flow/design`, se o prompt (velho ou
> editado) não contém `"PROJECT IDENTITY"`, o servidor **re-injeta** o bloco de
> identidade no topo — as cores **nunca se perdem**.

### 5.3 Dois modos de escrever o prompt

- **Prompt direto** (`buildDesignPromptDirect`, **sem IA**) — curto e imperativo,
  espelha o fluxo manual que funcionava no ChatGPT: "analise o estilo, replique
  no layout, coloque os elementos". Filosofia: **as imagens carregam a
  informação**; o texto só diz o papel de cada uma e a tarefa. Prompts longos e
  cheios de regra **diluem** a instrução e o gpt-image ignora o layout — por isso
  se evita specs gigantes. Regras críticas embutidas: **margens de segurança**
  (texto nunca encosta na borda), **disciplina de acento** (só a cor da marca).
- **Prompt por visão** ([`visionPrompt.ts`](backend/src/flow/visionPrompt.ts)
  `analyzeStyle`) — quando há imagem de **estilo**, um modelo de **visão**
  (Claude que **enxerga** as imagens, via CLI `claude -p` com a ferramenta Read,
  ou API se `ANTHROPIC_API_KEY`) **olha** a referência e descreve a identidade
  **real** (fundo claro/escuro, paleta, se é degradê ou chapado, tipografia).
  Isso ancora o gerador para não reinterpretar. O `styleDesc` extraído é
  **cacheado** no front para reuso.

> Detalhe importante: a imagem de **estilo nunca é enviada como imagem** ao
> gpt-image (ele copiaria o conteúdo). Ela entra como **texto analisado**
> (tipografia/materiais) + eventualmente como imagem **borrada** (só a atmosfera:
> fundo/cores/luz). Assim o estilo guia sem ser copiado literalmente.

---

## 6. Os endpoints (backend) — o que cada um gera

Servidor: [`backend/src/server.ts`](backend/src/server.ts). Base atual
`http://localhost:3002` (proxy do front em `/api`). Toda geração é um **job**
(`startFlowJob`): responde `{ jobId }` na hora, o front faz **polling** em
`/api/flow/progress/:id`, e há `/api/flow/cancel/:id` para abortar.

| Rota | O que gera |
|---|---|
| `POST /api/flow/detect` | (não é imagem) A IA acha 3 **momentos** e os segmenta em frases. Ponto de partida do FLOW. |
| `POST /api/flow/analyze-style` | Análise de **estilo por visão** — extrai a descrição do look da marca (`styleDesc`). |
| `POST /api/flow/design-prompt` | Monta o **prompt de design** de uma frase (direto + identidade; analisa estilo se ainda não houver). Síncrono. |
| `POST /api/flow/design` | **Gera a tela de UMA frase**: prompt + refs + proporção → N variações → `assets/flow/`. O caminho principal. |
| `POST /api/flow/design-chat` | **Modo ChatGPT**: texto do usuário + imagens vão verbatim ao gpt-image (via Responses). Controle total, sem templates. |
| `POST /api/flow/upload-design` | O usuário **sobe a própria arte** (sem IA); só ajusta à proporção. |
| `POST /api/popup-element` | Gera um **elemento isolado** (botão, selo, seta, card) em **PNG transparente** (gpt-image-1, `background: transparent`) para sobrepor no vídeo. |

### Fluxo do `/api/flow/design` (o principal)
1. valida `projectId` + `prompt`; re-injeta identidade se faltar (§5.2);
2. **cache por hash** de `(prompt final + proporção + refs + seed)` → nome de
   arquivo `img-<phraseId>-<hash>.png`. Se já existe, reusa; **seed novo = imagem
   nova**;
3. grava as refs (data URL) em arquivos temporários e escolhe o caminho do
   provider: com refs → **edits**; sem refs → **generations**;
4. gera **N variações** (`FLOW_DESIGN_VARIATIONS`, padrão 3) numa chamada — o
   gpt-image oscila, o usuário escolhe a boa;
5. cada variação passa por `saveImageFit` (§7) → salva `-v1`, `-v2`…;
6. grava um `.prompt.txt` ao lado (auditoria do prompt + tags enviadas);
7. devolve `{ imagePath, imageOptions[], designPrompt }`.

---

## 7. Ajuste de proporção — `saveImageFit` ([`flow/ffmpeg.ts`](backend/src/flow/ffmpeg.ts))

O gpt-image gera em tamanhos fixos (ex.: `1024x1536` ≈ 2:3), mas o vídeo é
`1080x1920` (9:16 exato). `saveImageFit` reconcilia isso **de forma
inteligente**, sem esticar/deformar:

1. **Proporção já bate** (< 1%) → só escala.
2. **Fonte mais larga que o destino**:
   - amostra as **faixas laterais**: se forem **fundo liso** (stddev baixo) →
     **corte central** (nada de conteúdo é perdido);
   - senão → **contain** + preenche cima/baixo; se as bordas são lisas, **estica
     a linha da borda** (continuação perfeita do fundo).
3. Onde há área a completar e o provider suporta, usa **outpaint** (gpt-image-1)
   para **gerar** a extensão do fundo em vez de borrar.

Resultado: a tela final na proporção exata do vídeo, pronta para animar.

---

## 8. Onde as imagens são salvas

`projects/<projectId>/assets/flow/`:
- `img-<phraseId>-<hash>.png` (+ `-v1`, `-v2`… variações) — telas de design;
- `chat-<phraseId>-*.png` — geradas pelo chat de design;
- `upload-<phraseId>-*.png` — arte própria do usuário;
- `*.prompt.txt` — auditoria do prompt usado.

Os elementos de popup (`/api/popup-element`) voltam como **data URL** e não são
salvos como asset aqui (mantêm o alpha; o pós-processamento achataria a
transparência).

---

## 9. Segurança e robustez

- **Cancelável**: todo job propaga um `AbortSignal` até o `fetch` do provider.
- **Falha explícita**: sem `OPENAI_API_KEY`, erro claro em vez de imagem quebrada.
- **Cache determinístico**: mesma entrada → mesmo arquivo (não regenera à toa;
  `seed` muda quando o usuário quer variar).
- **Identidade à prova de perda**: a COLOR LAW + re-injeção garantem que a paleta
  da marca nunca vaza para outras cores.
- **Auditoria**: o prompt final fica gravado ao lado de cada imagem.

---

## 10. Mapa de arquivos

```
backend/src/
├── server.ts                       # endpoints /api/flow/* e /api/popup-element
├── providers/
│   ├── ImageProvider.ts            # interface (contrato)
│   ├── index.ts                    # getImageProvider() por IMAGE_PROVIDER
│   ├── OpenAIImageProvider.ts      # generations / edits / responses / outpaint
│   └── GeminiProvider.ts           # alternativa (Nano Banana), mesma interface
└── flow/
    ├── claude.ts                   # detectFlowMoments, buildDesignPromptDirect, orderRefs, refRole
    ├── visionPrompt.ts             # analyzeStyle (visão), prompt ancorado nas imagens
    ├── ffmpeg.ts                   # saveImageFit (fit + outpaint), concat, probe
    ├── designSpec.ts               # specs de design
    └── timeFit.ts                  # ajuste temporal (para a animação)

shared/
└── flow.ts                         # aspectDims, identityToPrompt, FlowIdentity, tags/presets
```

---

## 11. Resumo

> Hoje a geração de imagem do app é o **motor de telas do FLOW**: um provider
> trocável (OpenAI/gpt-image-2 por padrão) recebe um **prompt curto e imperativo
> + referências com papéis** (estilo, layout, elemento, logo, série) e a
> **identidade da marca com prioridade máxima**. Quando há estilo, um modelo de
> **visão** descreve a identidade real antes de gerar. A imagem sai em variações,
> é **ajustada à proporção do vídeo** (corte inteligente / outpaint) e salva como
> asset — tudo assíncrono, cacheado, cancelável e auditável.
