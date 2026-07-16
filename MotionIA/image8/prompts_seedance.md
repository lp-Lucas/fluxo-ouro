# image8 — Prompts Seedance 2.0

---

## TIMING (macete)

| Clip | Fala | Início   | Fim      | Duração | Gerar no Seedance | Trim p/ timeline |
|------|------|----------|----------|---------|-------------------|-----------------|
| V1   | "nós da Blue Ocean vamos mapear" | 17.920s | 19.540s | **1.62s** | 3s | 1.62s |
| V2   | "e te ajudar com isso"           | 19.540s | 20.900s | **1.36s** | 3s | 1.36s |
| V3   | "colocar inteligência artificial… operação" | 20.900s | 23.80s | **2.90s** | 3s | 2.90s |

**Regra de trim:** coloca cada clip no início da fala (timeline position = coluna "Início"), deixa rolar pelo tempo da coluna "Trim", corta o resto.

---

## ORDEM DE GERAÇÃO

```
1. Gerar V1   (1 imagem: pasta 1)
2. Extrair último frame de V1:
   python extract_last_frame.py v1_gerado.mp4 last_v1.png
3. Gerar V2   (start frame: last_v1.png | end frame: pasta 2)
4. Extrair último frame de V2:
   python extract_last_frame.py v2_gerado.mp4 last_v2.png
5. Gerar V3   (3 imagens em sequência: last_v2.png → 3/1.png → 3/2.png)
```

---

## V1 — Pasta 1 (imagem única)

> Animação de entrada de todos os elementos da cena.

```
Single-image entrance animation. Dark blue scene.

TEXT ENTRANCE (top of frame):
"nós da Blue Ocean / vamos mapear" — both lines start 28px below final
position with a strong gaussian blur (radius ~12px). Each line eases
upward into place while blur dissolves to sharp, one line at a time,
top to bottom. Line 1 starts at 0.0s, line 2 at 0.2s. Each line takes
0.5s to fully settle. Motion is smooth and gentle — no overshoot.

MAP BOARD (3D blue platform with S-curve track):
Board starts at 82% scale, springs up to 100% with bounce overshoot
to 106% then settles. Duration: 0.6s, starts at 0.1s. The entire
platform rises slightly from 12px below its final position as it pops.

PAWN (blue chess piece, bottom-left of board):
Same pop-in as board, delayed 0.15s after board starts. Scale 78% → 100%
with bounce to 108%, settles in 0.5s. Rises 8px from below as it pops.

MAP LABELS — draw-on stroke effect:
"você está aqui" traces its text left-to-right as if being written,
stroke draws over 0.4s, starts at 0.4s.
"+faturamento" traces same way, starts at 0.65s, 0.35s duration.

WAVE LOGO (on flag top-right):
Starts flat/dark with no depth. Over 0.5s the logo gains 3D relief —
highlights brighten, shadow deepens underneath, creating an emboss/raise
effect as if the logo is physically rising from the surface. Starts at 0.3s.

FLAG (with wave logo, top-right):
Flag starts 20px below its final position. Rises upward with a smooth
spring pop (0.4s, slight bounce). Once in position, the flag fabric
sways gently — slow sinusoidal wave, 2px amplitude, 1.2s cycle, continuous.
Flag entrance starts at 0.25s.

CAMERA: very slow push-in, ~2% forward over full clip. Static background.
```

**~1.480 chars ✅**

---

## V2 — Pasta 2 (start frame: last_v1.png | end frame: pasta 2)

> Apenas animação de texto. Start/end frame no Seedance.

```
Start-to-end frame transition. 3 seconds.

START (last frame of V1): full map scene — board, pawn, flag, text all
visible and settled.

END (image from folder 2): clean blue scene with wave logo and text
"e te ajudar com isso".

TRANSITION:
0.0s–0.6s: Map board, pawn, flag, and top text all fade out together —
simple opacity fade, no motion, 0.6s.
0.6s–0.9s: Clean blue background. Only the faint gradient glow remains.

TEXT ENTRANCE ("e te ajudar com isso"):
Starts at 0.9s. Text begins 30px below final position with soft gaussian
blur (radius ~10px). Eases up and sharpens over 0.5s into final resting
position. Single block, all at once. Motion is smooth and fluid — no snap,
no bounce. Fully settled by 1.4s.

WAVE LOGO:
Already present or fades in softly (0.3s opacity fade) from 0.8s.

After 1.4s: scene is completely still. No motion, no drift.
Camera: static throughout. Background: static blue gradient.
```

**~1.000 chars ✅**

---

## V3 — Pasta 3 (3 imagens: last_v2.png → 3/1.png → 3/2.png)

> Efeito lanterna girando para revelar o cone com logo. Multi-image Seedance.

```
Three images. One continuous fluid scene. 3 seconds.

IMAGE 1 (last frame V2): "e te ajudar com isso" text, wave logo, blue
background. This is the opening state — it carries over directly from V2.

IMAGE 2 (3/1.png): dark blue scene, blue pawn on left, a neon blue
triangular light beam projecting right from the pawn — like a flashlight
or lantern beam. No text visible.

IMAGE 3 (3/2.png): same pawn, the beam has rotated/expanded upward into a
full cone of neon light pointing up. Inside the cone: the Blue Ocean wave
logo at center. Text "colocar inteligência artificial / que gera ROI /
na sua operação" above the scene.

PHASE 1 — 0.0s to 0.6s:
V2 text ("e te ajudar com isso") and logo fade out with soft blur.
Background transitions to deeper dark blue. Scene goes dark and minimal.

PHASE 2 — 0.6s to 1.4s:
Pawn and flashlight beam (image 2) fade in. The triangular beam is
initially pointing to the right. Over 0.8s the beam slowly rotates
clockwise — the triangle pivots upward as if the lantern is tilting —
neon light sweeps across the dark background as it turns.

PHASE 3 — 1.4s to 3.0s:
The beam completes its rotation upward, expanding into the full cone
shape (image 3). The Blue Ocean wave logo materializes inside the cone —
scales in from 60% with a soft glow pulse, settles in 0.4s.

TEXT ENTRANCE ("colocar inteligência artificial / que gera ROI /
na sua operação"):
Starts at 1.6s. Lines appear one by one from 28px below with gaussian
blur (radius ~10px), easing up and sharpening. Line 1 at 1.6s, line 2
at 1.85s, line 3 at 2.1s. Each line takes 0.45s to settle.
Motion is smooth and gentle — same style as V1 and V2.

Neon cone glow pulses softly once as text settles (2.5s), then holds.
Camera: static. Background: deep dark blue, completely static.
```

**~1.680 chars ✅**

---

## CHECKLIST

- [ ] Gerar V1 no Seedance 2.0 (1 imagem, 3s)
- [ ] `python extract_last_frame.py v1.mp4 last_v1.png`
- [ ] Gerar V2 no Seedance 2.0 (start: last_v1.png | end: pasta2.png, 3s)
- [ ] `python extract_last_frame.py v2.mp4 last_v2.png`
- [ ] Gerar V3 no Seedance 2.0 (3 imagens: last_v2.png + 3/1.png + 3/2.png, 3s)
- [ ] Colocar V1 na timeline em 17.920s, trim 1.62s
- [ ] Colocar V2 na timeline em 19.540s, trim 1.36s
- [ ] Colocar V3 na timeline em 20.900s, trim 2.90s
