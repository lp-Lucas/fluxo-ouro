# VIDEO PROMPT RULES — MotionIA
> Regras específicas para geração de prompts de animação (Higgsfield).
> Separado do DESIGN_RULES.md — aqui só entram regras de motion e vídeo.

---

## REGRAS GERAIS DE PROMPT DE VÍDEO

### REGRA V1 — LIMITE DE CARACTERES DO HIGGSFIELD
**Máximo: 2500 caracteres por prompt.**

- Sempre contar os caracteres antes de entregar o prompt
- Escrever de forma densa e objetiva — sem frases introdutórias, sem repetição
- Priorizar ações e movimentos sobre descrições de aparência (a imagem já existe)
- Se necessário, cortar contexto visual e manter apenas instruções de movimento

---

### REGRA V2 — O PROMPT DE ANIMAÇÃO DESCREVE MOVIMENTO, NÃO APARÊNCIA
O Higgsfield já tem a imagem como referência visual. O prompt não precisa descrever como os elementos se parecem — só o que eles fazem.

❌ Errado: "A frosted glass card with white fill at 18% opacity and corner radius 22px floats..."
✅ Certo: "The glass card floats with a slow sinusoidal drift, 6–8px vertical, 3s cycle."

---

### REGRA V3 — START FRAME / END FRAME
Para transições entre dois slides dentro de uma mesma cena:

- **Start frame:** imagem do slide A
- **End frame:** imagem do slide B
- O elemento âncora (glass card) deve ser idêntico nos dois frames para garantir continuidade
- A tipografia é o único elemento que muda entre os dois estados
- O background deve ser idêntico nos dois frames
- Descrever no prompt: o que persiste, o que muda, e como muda

---

### REGRA V4 — ELEMENTOS PERSISTENTES VS TRANSITÓRIOS

| Elemento | Comportamento padrão |
|----------|---------------------|
| Background | Sempre estático |
| Glass card | Persistente — nunca some |
| Chrome fragments | Drift contínuo do início ao fim |
| Light sweep | Loop — repete a cada 3–4s |
| Camera push-in | Contínuo do início ao fim |
| Tipografia | Transitória — entra e sai por cena |
| Floor reflection | Segue o card passivamente |

---

### REGRA V5 — DURAÇÃO E ESTRUTURA DE CENA
- Cada momento de motion: **5 segundos**
- Um vídeo de 30s comporta até **6 momentos de motion** como b-roll
- Cada momento é uma cena independente com start e end frame próprios
- Os momentos são complementares — mesmo universo visual, cenas diferentes

---

### REGRA V6 — TIMING INTERNO DE 5 SEGUNDOS (PADRÃO)

```
0.0s – 1.0s   Tipografia do frame A entra (pop + up, linha por linha)
1.0s – 2.0s   Cena estabelecida — card flutua, fragments driftam, sweep corre
2.0s – 2.5s   Tipografia do frame A sai (pop + up exit, bottom to top)
2.5s – 3.0s   Pausa limpa — só card e fragments visíveis
3.0s – 5.0s   Tipografia do frame B entra (pop + up, top to bottom)
```

---

### REGRA V7 — VOCABULÁRIO DE MOVIMENTO

| Efeito | Descrição para o prompt |
|--------|------------------------|
| Pop + up (entrada) | "pops up from slightly below into position, fast snap, 0.2s per element" |
| Pop + up (saída) | "rises upward and fades out, fast, 0.2s per element, bottom-to-top sequence" |
| Scale in bounce | "scales from 80% to 100% with slight overshoot to 104% then settles, 0.8s" |
| Float suave | "slow sinusoidal vertical drift, 6–8px, one cycle every 3s" |
| Light sweep | "diagonal specular stripe crosses surface upper-left to lower-right over 1.5s, loops" |
| Draw-on line | "line traces its path left to right in real time, rise then sharp fall, 1.2s total" |
| Counter numérico | "number counts up from 0 to final value, 0.8s, fast acceleration then settle" |
| Chrome drift | "each fragment drifts independently in different direction, 3–5px/s, continuous" |
| Camera push-in | "slow continuous forward move, ~3% zoom over full clip duration, constant speed" |

---

## TEMPLATE DE PROMPT DE ANIMAÇÃO (START/END FRAME)

```
[PERSISTENT ELEMENTS — never cut or reset]
Glass card: [float description]. Light sweep: [loop description].
Chrome fragments: slow independent zero-gravity drift throughout.
Camera: slow push-in ~3% over full clip. Background: static.

[TYPOGRAPHY TRANSITION]
0s–Xs: Frame A text ([copy]) exits — [exit motion description], [sequence direction].
Xs–Ys: Clean pause. Only card and fragments visible.
Ys–5s: Frame B text ([copy]) enters — [entrance motion description], [sequence direction].

[CARD CONTENT]
[Descrever apenas se há animação interna: draw-on, counter, etc.]

[FEEL]
[Uma frase de mood — ex: "Premium, controlled, Apple keynote energy."]
```

---

## PROMPT — Slide 1 → Slide 2 (versão ~2.480 chars)

```
Continuous 5-second scene. Same silver-pearl universe throughout.

PERSISTENT — all 5 seconds:
Glass card floats with slow sinusoidal vertical drift, 6–8px range, one full cycle
every 3 seconds. The card maintains its slight 3D perspective tilt at all times —
it never flattens or resets.
Diagonal light sweep crosses card surface from upper-left to lower-right over 1.5
seconds — a sharp white specular stripe with soft feathered edges that fades out
after crossing. Repeats once, beginning again at approximately 3 seconds into the
clip. As the sweep passes, nearby chrome fragments catch the light and flash briefly
brighter before returning to their base reflectivity.
Chrome crystal fragments drift in continuous zero-gravity motion. Each fragment moves
in a unique direction at a slightly different speed, 3–5px per second. Motion is
organic and never synchronized between fragments. They never stop moving, never pause,
never reset.
Camera: slow continuous push-in, approximately 3% forward over the full 5 seconds.
Constant speed, no easing, no pause, no reversal.
Background: pearl-silver radial gradient, completely static throughout. No pulse,
no vignette, no shift.
Floor reflection below the card mirrors the card vertical float with a 0.1-second
passive delay.

TYPOGRAPHY TRANSITION — the only element that changes:
0s–1.0s: Frame A text enters line by line, top to bottom. Each line pops up from 8px
below its final position and snaps into place — 0.2s snap per line, 0.15s stagger.
Lines: "investir em", "anúncio" in Light weight gray. Then "sem", "estratégia" in
Black Heavy weight, visibly larger with tight tracking, entering with more force.
1.5s–2.0s: Frame A text exits — lines rise upward and fade out bottom to top, 0.2s
per line, clean and fast.
2.0s–2.5s: Upper-left zone completely empty. Card, fragments, sweep, and camera
push-in remain active. This pause is intentional — it creates breath between states.
2.5s–5.0s: Frame B text enters line by line, top to bottom, same pop-and-rise.
Lines: "e todo mês", "o orçamento", "some" in Light weight gray. Then "a mesma",
"conta." in Black Heavy weight, larger, tight tracking. "conta." lands as a
definitive visual stop — the period is the end of the sentence and the scene.

Card interior — line chart, "R$ 2.847,00", "Sem retorno visível" — static throughout.

One continuous world. Card is the constant. Typography is the story.
Premium, controlled, Apple keynote energy.
```

**Caracteres: ~2.480 / 2.500 ✅**

---

---

## PROMPT — Série Estoque (4 frames, ~10 segundos)

> Upload: 4 imagens no campo multi-image do Seedance. Câmera contínua, sem cuts.

```
Four images, one continuous world. Electric blue background static throughout.

PERSISTENT — all 10 seconds:
Crystal fragments: scale in with bounce at each phase start, then drift
continuously in zero-gravity, 3–5px/s, each fragment unique direction,
never synchronized.
Camera: slow continuous push-in, ~6% forward over full 10 seconds. Never
cuts, never resets. This movement IS the transition between phases.
Light sweep: diagonal white specular stripe crosses card upper-left to
lower-right over 1.5s, loops every 4s.

ENTRANCE RULE — applies at start of every phase:
Black card scales from 72% to 100% with bounce overshoot to 106%,
settles in 0.8s.
Typography above card pops up line by line, 8px rise, 0.2s snap per
line, 0.15s stagger.
Fragments scale in around card with bounce, staggered 0.1s each.

PHASE 1 — 0s–2.2s ("você vende,")
Card entrance. Fragments scale in. Text "você vende," pops up above.
At 1.8s: blue "Comprar agora" button scales 100%→95%→102%→100% over
0.3s — tap simulation. Immediately: bright white flash on card surface,
0.2s. Card content morphs directly into Phase 2. No cut.

PHASE 2 — 2.2s–4.8s ("o cliente paga,")
Checkmark circle draws in with circular stroke animation, 0.4s.
"R$ 247,00" counts up from zero in 0.5s. Pix symbol scales in bounce.
Text "o cliente paga," pops up above card. Exits upward fast at 4.3s.

PHASE 3 — 4.8s–7.4s ("mas o produto")
Folder icon closed scales in with bounce. Product rows appear top to
bottom, 0.2s each: Tênis Runner Pro, Camiseta Dry Fit, Mochila Sport.
"3 produtos em estoque" in green scales in last. Text "mas o produto"
pops up. Exits upward at 6.9s.

PHASE 4 — 7.4s–10s ("não tem.")
Folder icon morphs open — neon white outline traces edges as it opens,
0.5s. Dashed circle draws on 0% to 100%, 0.6s.
"não" snaps in heavy. "tem." follows with more force — 0.1s micro-shake
on landing. Card outer glow pulses once, fades.
Fragments continue drifting. Camera still pushing forward.

One card. Four states. No cuts. Only motion.
```

**Caracteres: ~2.020 / 2.500 ✅**

---

*Atualizar conforme novos aprendizados com o Higgsfield/Seedance.*
