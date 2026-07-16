#!/usr/bin/env python3
"""
erp_zoom.py — Sequência zoom-pan pixel-perfect do ERP dashboard.
Cada frame gerado com Python (Pillow) + crop matemático → sem distorção.
"""
import subprocess, os, shutil, math

try:
    from PIL import Image
except ImportError:
    subprocess.run(["pip", "install", "Pillow", "-q"], check=True)
    from PIL import Image

SRC = r"c:\Users\Lucas\Desktop\MotionIA\image3\erp.png"
OUT = r"c:\Users\Lucas\Desktop\MotionIA\image3\erp_zoom.mp4"
TMP = r"c:\Users\Lucas\Desktop\MotionIA\image3\_zoom_tmp"

FPS  = 30
W, H = 720, 1280   # output 9:16

os.makedirs(TMP, exist_ok=True)
frames_dir = os.path.join(TMP, "frames")
os.makedirs(frames_dir, exist_ok=True)

# ── Carrega e escala a imagem para 2x (alta qualidade no zoom) ──────────────
src = Image.open(SRC).convert("RGB")
# Escala para 2160×2160 para ter qualidade no zoom
SCALE = 2160
src_large = src.resize((SCALE, SCALE), Image.LANCZOS)

# ── Padding: cria canvas 9:16 de fundo preto ─────────────────────────────────
# Imagem 2160×2160 centralizada em 2160×3840 (9:16)
CANVAS_W = 2160
CANVAS_H = 3840
PAD_TOP  = (CANVAS_H - CANVAS_W) // 2   # 840px

def make_padded():
    canvas = Image.new("RGB", (CANVAS_W, CANVAS_H), (0, 0, 0))
    canvas.paste(src_large, (0, PAD_TOP))
    return canvas

PADDED = make_padded()

# ── Coordenadas das seções no canvas 2160×3840 ────────────────────────────────
# Imagem 2160×2160 começa em y=840, termina em y=3000
# Layout estimado (imagem original 1254×1254 → canvas 2160×2160):
#   Escala: 2160/1254 = 1.722
#   Header bar: orig y=0-90    → canvas y=840+0   a 840+155   = y840..995
#   Sidebar:    orig x=0-195   → canvas x=0..336
#   Cards:      orig y=210-490 → canvas y=840+362  a 840+844   = y1202..1684
#   Chart:      orig x=0-740, y=490-800 → canvas x=0..1274, y=1684..2216
#   Alerts:     orig x=700-1254, y=490-800 → canvas x=1205..2160, y=1684..2216
#   Tabela:     orig y=800-1120 → canvas y=2216..2769
#   Cards cx:   cx=2160//2=1080, cy=(1202+1684)//2=1443
#   Chart cx:   cx=637, cy=(1684+2216)//2=1950
#   Alerts cx:  cx=1682, cy=1950
#   Tabela cy:  cy=(2216+2769)//2=2493
#   Centro:     cx=1080, cy=CANVAS_H//2=1920

def ease_inout(t):
    """Smoothstep 0→1"""
    return t * t * (3 - 2 * t)

def crop_zoom(image, cx, cy, zoom, out_w=W, out_h=H):
    """
    Extrai viewport de (out_w/zoom × out_h/zoom) centrado em (cx, cy)
    do canvas 2160×3840, e redimensiona para out_w×out_h.
    """
    vp_w = CANVAS_W / zoom
    vp_h = CANVAS_H / zoom
    x0 = cx - vp_w / 2
    y0 = cy - vp_h / 2
    # Clamp
    x0 = max(0, min(CANVAS_W - vp_w, x0))
    y0 = max(0, min(CANVAS_H - vp_h, y0))
    x1 = x0 + vp_w
    y1 = y0 + vp_h
    crop = image.crop((int(x0), int(y0), int(x1), int(y1)))
    return crop.resize((out_w, out_h), Image.LANCZOS)

# ── Segmentos ─────────────────────────────────────────────────────────────────
# (duração_s, zoom_from, zoom_to, cx_from, cy_from, cx_to, cy_to)
CX_CENTER = 1080
CY_CENTER = 1920
CX_CARDS  = 1080 ; CY_CARDS  = 1443
CX_CHART  = 637  ; CY_CHART  = 1950
CX_ALERTS = 1682 ; CY_ALERTS = 1950
CX_TABLE  = 1080 ; CY_TABLE  = 2493

SEGS = [
    (1.5, 1.0, 1.0,   CX_CENTER, CY_CENTER, CX_CENTER, CY_CENTER),  # full hold
    (1.2, 1.0, 2.5,   CX_CENTER, CY_CENTER, CX_CARDS,  CY_CARDS),   # zoom → cards
    (1.0, 2.5, 2.5,   CX_CARDS,  CY_CARDS,  CX_CARDS,  CY_CARDS),   # hold cards
    (1.0, 2.5, 2.5,   CX_CARDS,  CY_CARDS,  CX_CHART,  CY_CHART),   # pan → chart
    (0.8, 2.5, 2.5,   CX_CHART,  CY_CHART,  CX_CHART,  CY_CHART),   # hold chart
    (1.0, 2.5, 2.8,   CX_CHART,  CY_CHART,  CX_ALERTS, CY_ALERTS),  # pan → alerts
    (0.8, 2.8, 2.8,   CX_ALERTS, CY_ALERTS, CX_ALERTS, CY_ALERTS),  # hold alerts
    (1.0, 2.8, 2.8,   CX_ALERTS, CY_ALERTS, CX_TABLE,  CY_TABLE),   # pan → table
    (0.8, 2.8, 2.8,   CX_TABLE,  CY_TABLE,  CX_TABLE,  CY_TABLE),   # hold table
    (1.5, 2.8, 1.0,   CX_TABLE,  CY_TABLE,  CX_CENTER, CY_CENTER),  # pull back
    (0.8, 1.0, 1.0,   CX_CENTER, CY_CENTER, CX_CENTER, CY_CENTER),  # hold final
]

# ── Gera todos os frames ───────────────────────────────────────────────────────
total_frames = sum(int(s[0] * FPS) for s in SEGS)
frame_idx = 0

for seg_i, (dur, z0, z1, cx0, cy0, cx1, cy1) in enumerate(SEGS):
    n = int(dur * FPS)
    print(f"[{seg_i+1:02d}/{len(SEGS)}] {dur}s  z:{z0}→{z1}  ({cx0},{cy0})→({cx1},{cy1})")
    for f in range(n):
        t = f / max(1, n - 1)
        e = ease_inout(t)
        z  = z0  + (z1  - z0)  * e
        cx = cx0 + (cx1 - cx0) * e
        cy = cy0 + (cy1 - cy0) * e
        frame = crop_zoom(PADDED, cx, cy, z)
        frame.save(os.path.join(frames_dir, f"f{frame_idx:05d}.png"))
        frame_idx += 1

print(f"\n✓ {frame_idx} frames gerados. Encodando vídeo...")

# ── Encoda com FFmpeg ─────────────────────────────────────────────────────────
subprocess.run([
    "ffmpeg", "-y",
    "-r", str(FPS),
    "-i", os.path.join(frames_dir, "f%05d.png"),
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-preset", "fast", "-crf", "16",
    OUT
], check=True)

print(f"✓ Vídeo: {OUT}")
print(f"  Duração: {sum(s[0] for s in SEGS):.1f}s")

shutil.rmtree(TMP, ignore_errors=True)
