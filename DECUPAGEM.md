# Decupagem automática — como funciona

> Sistema de corte automático de gravações de **take único** (fala à câmera).
> A partir da transcrição com timestamps + (opcionalmente) o roteiro/copy, o
> sistema decide sozinho o que **cortar** — fora do roteiro, silêncio, tomadas
> repetidas, falsos começos, muletas e alucinações da transcrição — e devolve
> uma lista de cortes com um motivo em PT-BR para cada um.

Filosofia central: **UM BOTÃO**. O editor clica "Decupar" e recebe cortes
prontos. Duas camadas rodam por baixo — uma **determinística** (instantânea) e
uma de **IA** (em background) — mas o editor vê só o resultado.

---

## 1. Princípios inegociáveis

| Princípio | O que significa |
|---|---|
| **Tempo vem do VAD, nunca da IA** | Os timestamps das bordas de corte saem sempre da detecção acústica de fala (Silero VAD). A IA e o alinhamento decidem *quais palavras* cortar; o *quando* é medido no áudio. A IA nunca inventa tempo. |
| **Copy > IA (precedência)** | Se há roteiro, ele é a verdade do conteúdo. O que bate com o roteiro fica; o que está fora, cai. A IA só age onde o alinhamento é ambíguo (retakes). |
| **Nunca falha em silêncio** | Qualquer erro vira `error` com `cuts: []` e resposta 200 — nunca destrói o vídeo nem trava a UI. |
| **Travas de sanidade** | Se qualquer camada mandaria cortar **>70%** das palavras (copy errada / alucinação da IA), a decisão é **recusada** com erro claro. |
| **Determinístico onde dá** | Alinhamento, VAD, verificação de retake e scoring são funções puras e testáveis. A IA entra só onde texto exige julgamento semântico. |

---

## 2. Visão geral do fluxo

```
                    VÍDEO + TRANSCRIÇÃO (+ copy opcional)
                                  │
        ┌─────────────────────────┴──────────────────────────┐
        │           CAMADA DE SINAL (acústica)                │
        │  decode 16k mono → Silero VAD → segmentos fala/silêncio
        │  → ancoragem das palavras ao VAD → track de energia  │
        └─────────────────────────┬──────────────────────────┘
                                  │
   ┌──────────────────────────────┴───────────────────────────────┐
   │  FASE DETERMINÍSTICA (retorno IMEDIATO do botão)              │
   │   copyLayer  (Gotoh + guarda de mishear + alucinação)         │
   │ + silenceLayer (dead-air do VAD)                             │
   │ + falso começo acústico (zonas-cabeça)                       │
   │   → planCuts (merge → borda → snap → score ≥0.85)            │
   └──────────────────────────────┬───────────────────────────────┘
                                  │  devolve cuts + jobId
                                  │
   ┌──────────────────────────────┴───────────────────────────────┐
   │  FASE DE IA (background, polling em /progress/:id)            │
   │   aiRetakeCuts (Claude, chunks paralelos)                    │
   │   → verificaRetake (periodicidade lexical)                   │
   │   → planWithAi (re-planeja TUDO junto)                       │
   │   → caption-coverage (repara legenda de falso começo)        │
   └──────────────────────────────────────────────────────────────┘
```

O front dispara **uma** chamada, recebe os cortes determinísticos na hora e o
`jobId`; depois faz *polling* e, quando a IA termina, **substitui** os cortes
`decup-*` pelo conjunto final (determinístico + IA já re-planejados juntos).

---

## 3. Camada de sinal (acústica) — a autoridade do tempo

Arquivos: [`backend/src/decupagem/signal/`](backend/src/decupagem/signal/)

1. **Decode único** ([`audio.ts`](backend/src/decupagem/signal/audio.ts)) — o
   vídeo é decodificado **uma vez** para PCM mono 16 kHz e reaproveitado por
   todas as etapas.

2. **Silero VAD** ([`vad.ts`](backend/src/decupagem/signal/vad.ts)) — modelo
   ONNX (v5.1, **pinado por sha256** porque o export do master usa janela 256 e
   quebra). Roda janela a janela (512 amostras ≈ 32 ms) e produz uma
   probabilidade de fala por janela. `probsToSegments` (função **pura**,
   testável sem o modelo) converte isso em segmentos fala/silêncio **sem
   buracos**, cobrindo `[0, totalMs]`, com bordas no grid de 10 ms. Algoritmo =
   `get_speech_timestamps` do Silero: histerese (entra ≥0.5, sai <0.35),
   `minSilence` (150 ms padrão) e `speechPad` (30 ms).

   - **VAD de tempo** (minSilence 150 ms): fonte da ancoragem e do silêncio.
   - **VAD de zona** (minSilence 30 ms, fino): fragmenta a fala para detectar
     cabeças-de-bloco repetidas (falso começo). Ver §5.

3. **Ancoragem** ([`anchor.ts`](backend/src/decupagem/anchor.ts)) — cada palavra
   do Whisper é amarrada a um segmento de fala do VAD; a partir daí o tempo da
   palavra é `vadStartMs`/`vadEndMs` (do VAD), não o do Whisper. Regras:
   - dentro de um trecho de fala → clampa as bordas ao trecho;
   - cruzando fronteira → estende para cobrir os trechos tocados;
   - a ≤100 ms de um trecho → **absorve** (fecha o micro-gap);
   - a >100 ms de qualquer fala → **órfã** (`vadSegmentIdx = -1`), guardando o
     tamanho do silêncio que a contém (`vadHallGapMs`). Órfã em silêncio longo
     (≥400 ms) = alucinação real; em fala densa = fronteira incerta (só marca).

4. **Energia** ([`energy.ts`](backend/src/decupagem/signal/energy.ts)) — track de
   energia (dBFS) usado no *snap*: a borda do corte é atraída ao **vale de
   energia** mais próximo, para o corte cair no silêncio e não lascar fala.

---

## 4. Fase determinística (resposta imediata)

Orquestrada por `runCopyLayer` + `runDecupagem`
([`decupagem/index.ts`](backend/src/decupagem/index.ts)).

### 4.1 Camada de copy — [`semantic/copyLayer.ts`](backend/src/decupagem/semantic/copyLayer.ts)

Com roteiro, faz **alinhamento global Gotoh** (ver §6) entre as palavras
faladas e os tokens da copy:

- palavra **`match`/`sub`** (bate com o roteiro) → **mantém**;
- palavra **`del`** (fora do roteiro) → candidata a corte, mas com freios:
  - **Guarda de mishear** ([`misheardGuard.ts`](backend/src/decupagem/semantic/misheardGuard.ts),
    usa dicionário Hunspell): se a palavra é um *garble* de uma palavra do
    roteiro (o Whisper ouviu errado), **nunca corta** — `mishear_provavel`.
    Erro do transcritor ≠ erro do apresentador.
  - se o **texto** bate com o roteiro mas foi marcado `del` → é **repetição
    curta**; o copyLayer se cala e deixa para a IA decidir no contexto;
  - só corta (`fora_do_roteiro`) quando realmente não bate com nada da copy.
- **órfã** (VAD idx -1) em silêncio longo (≥400 ms) → `whisper_hallucination`
  (corta); em fala densa → `fronteira_vad_incerta` (só marca).
- Sem copy: o conteúdo **não é julgado aqui** — vai inteiro para a IA.

### 4.2 Camada de silêncio — [`plan/silenceLayer.ts`](backend/src/decupagem/plan/silenceLayer.ts)

Usa os segmentos não-fala do VAD para cortar **dead-air** (silêncio morto),
respeitando as zonas de retake (não corta dentro de fala repetida, onde o
"silêncio" pode ser fronteira de tomada).

### 4.3 Falso começo acústico

Nas zonas detectadas por **cabeça-de-bloco** (§5), o trecho abandonado muitas
vezes não tem palavras canônicas próprias — a IA (que lê texto) não o corta, mas
a **estrutura de bloco** corta (`falso_comeco`, confiança 0.9). Gate de
segurança: se o corte **atravessa** uma palavra (o Whisper colou as duas
tentativas numa palavra só), cortar quebraria a legenda →
- **com copy**: aplica e marca `needs_caption_repair` (a legenda é reparada
  depois, §7.3);
- **sem copy**: **bloqueia** (`blocked_by`) e vira marcador acionável ("cole a
  copy para cortar") — o erro foi achado, mas o corte fica travado.

### 4.4 Plano de corte — [`plan/index.ts`](backend/src/decupagem/plan/index.ts)

`planCuts` roda o pipeline puro sobre todos os intervalos brutos:

1. **merge** — une + dilata cortes sobrepostos/vizinhos;
2. **regra de borda** — encolhe cortes que invadem uma palavra **mantida**
   (keeper) — as palavras boas são invioláveis;
3. **snap** — puxa a borda ao vale de energia (silêncio real);
4. **score** ([`plan/score.ts`](backend/src/decupagem/plan/score.ts)) — decide
   `applied`:
   - `applied = confidence ≥ 0.85`;
   - fala periférica (prob <0.15 fora da copy) dá **+0.05** de confiança;
   - razões que **marcam mas nunca aplicam**: `vad_breath` (respiração),
     `fronteira_vad_incerta`;
   - `blocked_by` (detecção confiável mas incapaz de agir) nunca aplica.

Resultado: `cuts` (aplicados, ≥0.85, já rotulados) volta na hora + `rawIntervals`
(para a IA re-planejar) + zonas/candidatos de retake.

---

## 5. Zonas de retake — [`semantic/retakeZones.ts`](backend/src/decupagem/semantic/retakeZones.ts)

Regiões onde há **fala repetida** e o alinhamento por posição não sabe qual
tomada manter. Detectadas por **três métodos**, unidos (`unirZonas`):

- **Periodicidade** — o texto se repete (mesma sequência de palavras 2+ vezes);
- **Cabeça-de-bloco** — começos de blocos do VAD-de-zona que soam parecidos
  (falso começo acústico), transcritos por [`heads.ts`](backend/src/transcribe/heads.ts);
- **Bloco** — reformulação com texto canônico parecido entre blocos.

Dentro de qualquer zona o `copyLayer` **se cala** (nem alucinação, nem
fronteira — tudo isso é misclassificação dentro de fala repetida). A zona
inteira vai **livre para a IA** decidir.

---

## 6. Alinhamento Gotoh — [`shared/gotoh.ts`](shared/gotoh.ts)

Alinhamento global palavra↔roteiro com **gaps afins** (Gotoh) + **match fuzzy**.
Compartilhado entre o backend (decupagem) e a correção do frontend — a mesma
"verdade do que bate com a copy".

- **Gaps afins**: *abrir* um corte é caro (`GAP_OPEN=1.0`), *estender* é barato
  (`GAP_EXT=0.25`) → uma tomada repetida inteira vira **um corte contíguo**, em
  vez de o alinhador fatiar em pedaços.
- **Match fuzzy** (`MATCH_SIM=0.82`, via Levenshtein normalizado): um *mishear*
  de palavra do roteiro conta como **correção** (`sub`, custo 0.6), não como
  fora-do-roteiro (`del`).
- **Pareamento 2→1**: duas palavras do Whisper = um token da copy
  (ex.: "Scale"+"4" = "Scale4").

> Nota de manutenção registrada no código: a ordem dos argumentos na recorrência
> `Y` (inserção) é `0=M, 1=X, 2=Y`. Já houve um bug histórico com `(M,Y,X)` que
> fazia o alinhador cortar tudo — não reordenar.

---

## 7. Fase de IA (background)

### 7.1 IA de retake — [`semantic/aiRetake.ts`](backend/src/decupagem/semantic/aiRetake.ts)

Decide **retakes** e **falsos começos** que o alinhamento não resolve. Usa o
Claude via [`autocut/aiCut.ts`](backend/src/autocut/aiCut.ts) (`runClaude`).

- **Chunking paralelo**: janelas de 800 palavras, overlap 50 — falso começo e
  retake têm raio ~30 palavras, então contexto global não importa; paralelizar
  cai de ~150 s para <30 s. Na sobreposição, índice marcado por **qualquer**
  chunk conta (união).
- **Método forçado**: o modelo escreve a análise em texto **antes** do JSON
  (melhora a precisão) e devolve `{"cuts":[{"from":idx,"to":idx}]}`.
- **`restrictTo`**: com copy, fora das zonas a IA fica **restrita** aos
  candidatos ambíguos do copyLayer (a copy tem precedência); dentro das zonas,
  decide livre. Sem copy, a IA julga tudo.
- **Trava de 70%**: se a IA marcar >70% das palavras, recusa.

### 7.2 Verificação de retake — [`semantic/verificaRetake.ts`](backend/src/decupagem/semantic/verificaRetake.ts)

Cada span que a IA marcou é **verificado lexicalmente** (a definição virando
teste, não heurística): um retake é texto que se **repete periodicamente**.
- `simExterna` = o span se repete nas N palavras seguintes;
- `simInterna` = o span dividido em k∈{2,3,4} partes iguais bate entre si (MIN
  entre todos os pares);
- `sim = max(externa, interna)`.

Se `sim ≥ 0.6` → **verificado**, confiança **0.95** (aplica). Senão → confiança
0.70, `ai_retake_nao_verificado` (só marca, não corta).

### 7.3 Re-plano e reparo

- **`planWithAi`** — junta os cortes da IA com os `rawIntervals` do
  determinístico e **re-planeja tudo** (merge/borda/snap/score) num conjunto
  final coerente. Nunca lança: em erro, degrada para o determinístico.
- **Regra de borda** protege as palavras mantidas nas zonas (keeper) —
  `keeperEdges` define o que é inviolável.
- **Caption-coverage** ([`autocut/captionCoverage.ts`](backend/src/autocut/captionCoverage.ts)) —
  quando um falso começo aplicado com copy deixa a legenda do recomeço com
  buraco, esta camada detecta trechos do vídeo final **sem legenda** e, usando a
  copy como verdade, preenche o **texto** que falta (com timestamps dentro do
  trecho que ficou — de novo, a IA não inventa tempo).
- **Marcadores de revisão** (`regions`) — falsos começos bloqueados (sem copy) e
  disfluências prováveis viram marcadores "olhe aqui" na timeline, em vez de
  sumir.

---

## 8. Motivos legíveis — [`decupagem/reasons.ts`](backend/src/decupagem/reasons.ts)

Cada corte carrega um `reason[]` de códigos internos; `reasonSummary` os traduz
para **uma frase em PT-BR** (a razão principal primeiro, modificadores entre
parênteses). O editor nunca vê código.

| Código | Rótulo PT-BR |
|---|---|
| `fora_do_roteiro` | Fora do roteiro |
| `whisper_hallucination` | Alucinação da transcrição |
| `ai_retake_detection` | Tomada repetida |
| `ai_retake_nao_verificado` | Possível retake (não confirmado) |
| `falso_comeco` | Falso começo |
| `disfluencia_provavel` | Possível repetição — ouça |
| `dead_air` / `vad_silence` | Silêncio |
| `vad_breath` | Respiração |
| `fronteira_vad_incerta` | Fronteira de fala incerta |
| `filler` | Muleta |
| `fala_periferica` | Fala periférica (modificador) |
| `mishear_provavel` | Provável erro de transcrição |
| `needs_caption_repair` | reparo de legenda (modificador) |

---

## 9. API (backend)

Servidor: [`backend/src/server.ts`](backend/src/server.ts). Base atual:
`http://localhost:3002` (proxy do front em `/api`).

| Método | Rota | O que faz |
|---|---|---|
| `POST` | `/api/decupagem` | Recebe vídeo + transcrição (+ copy). Roda a fase determinística e devolve `cuts`, `detail`, `needsAi` e um `jobId`. Dispara a IA em background. |
| `GET` | `/api/decupagem/progress/:id` | Polling do job de IA. Quando `done`, devolve o conjunto **final** de cortes, transcrição reparada e `regions` (marcadores). |
| `POST` | `/api/caption-coverage` | Detecta e (com copy) preenche buracos de legenda pós-corte. |
| `POST` | `/api/autocut-ai` | Autocut mais simples/antigo (IA decide direto por índice de palavra), sem a camada de sinal. |

O provedor de IA é trocável: usa a **API Anthropic** se `ANTHROPIC_API_KEY`
existir, senão o **`claude` CLI** já logado (modo headless `-p`). Modelo em
`AUTOCUT_MODEL` (padrão `claude-sonnet-5`).

---

## 10. Mapa de arquivos

```
backend/src/
├── server.ts                      # endpoints /api/decupagem, polling, orquestração
├── autocut/
│   ├── aiCut.ts                    # runClaude (API/CLI), autocut simples, spansToCuts
│   └── captionCoverage.ts          # buracos de legenda + preenchimento por copy
├── transcribe/
│   └── heads.ts                    # transcrição das cabeças de bloco (falso começo)
└── decupagem/
    ├── index.ts                    # runDecupagem, planWithAi, buildRestrictTo
    ├── reasons.ts                  # códigos → PT-BR
    ├── anchor.ts                   # palavras ↔ VAD (tempo real)
    ├── signal/
    │   ├── audio.ts                # decode 16k mono
    │   ├── vad.ts                  # Silero VAD → segmentos
    │   ├── energy.ts               # track de energia (snap)
    │   ├── fft.ts / nonSpeech.ts   # respiração/não-fala
    ├── semantic/
    │   ├── copyLayer.ts            # Gotoh + mishear + alucinação (determinístico)
    │   ├── retakeZones.ts          # zonas de retake (3 métodos)
    │   ├── aiRetake.ts             # IA de retake (chunks paralelos)
    │   ├── verificaRetake.ts       # verificação lexical de periodicidade
    │   ├── misheardGuard.ts        # dicionário Hunspell
    │   └── cascade.ts / copyLayer  # composição das camadas
    └── plan/
        ├── index.ts                # planCuts = merge → borda → snap → score
        ├── merge.ts / snap.ts      # união/dilatação; snap ao vale de energia
        ├── score.ts                # applied ≥ 0.85, exceções
        ├── edges.ts                # keeperEdges, regra de borda
        ├── silenceLayer.ts         # dead-air do VAD
        └── disfluenciaLayer.ts     # marcadores "ouça aqui"

shared/
├── gotoh.ts                        # alinhamento global (backend + frontend)
├── text.ts                         # levenshtein, normalizeWord
├── timeline.ts                     # Word, TranscriptSegment, Cut
├── cutplan.ts                      # buildCutPlan, remapTime (tempo fonte↔saída)
└── captions.ts                     # stripCutsFromTranscript
```

---

## 11. Resumo em uma frase

> O VAD mede **onde** há fala; a copy (via Gotoh) decide **o que** pertence ao
> roteiro; a IA resolve **as ambiguidades** (retakes, falsos começos); tudo é
> re-planejado junto, pontuado (≥0.85 aplica) e rotulado em PT-BR — com travas
> que recusam qualquer decisão que apagaria o vídeo.
