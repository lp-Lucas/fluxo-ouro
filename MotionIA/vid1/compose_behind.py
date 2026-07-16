import cv2
import numpy as np
from PIL import Image, ImageFilter
from rembg import remove, new_session
import math
import subprocess
import os
import time

# ── Animation helpers ──────────────────────────────────────────────────────────

def spring_y(t, t0, final_y, start_y, d=5.5, w=8):
    if t < t0:
        return int(start_y)
    tau = t - t0
    val = final_y + (start_y - final_y) * math.exp(-d * tau) * math.cos(w * tau)
    return int(val)

def spring_scale(t, t0, d=7, w=9):
    if t < t0:
        return 0.0
    tau = t - t0
    val = 1.0 - math.exp(-d * tau) * math.cos(w * tau)
    return max(0.0, min(1.15, val))

def ease_opacity(t, t0, dur=0.18):
    if t < t0:
        return 0.0
    return min(1.0, (t - t0) / dur)

def add_shadow(icon_rgba, offset=(12, 18), blur=14, opacity=0.45):
    w, h = icon_rgba.size
    pad = blur * 2 + max(abs(offset[0]), abs(offset[1])) + 10
    canvas_w, canvas_h = w + pad * 2, h + pad * 2
    shadow_layer = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    alpha = icon_rgba.split()[3]
    dark = Image.new("RGBA", (w, h), (0, 0, 0, int(255 * opacity)))
    dark.putalpha(alpha)
    shadow_layer.paste(dark, (pad + offset[0], pad + offset[1]), dark)
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(blur))
    result = shadow_layer.copy()
    result.paste(icon_rgba, (pad, pad), icon_rgba)
    return result, (pad, pad)

def composite_icon(canvas, icon_shadow, shadow_anchor, cx, final_cy, t, t0, start_y,
                   d=5.5, w=8, icon_size=340, out_h=1920):
    cy = spring_y(t, t0, final_cy, start_y, d, w)
    if cy > out_h + icon_size:
        return canvas
    sc = spring_scale(t, t0)
    if sc < 0.01:
        return canvas
    op = ease_opacity(t, t0)
    if op < 0.01:
        return canvas
    sz = max(10, int(icon_size * sc))
    sw = int(icon_shadow.size[0] * sc)
    sh = int(icon_shadow.size[1] * sc)
    if sw < 5 or sh < 5:
        return canvas
    shadow_scaled = icon_shadow.resize((sw, sh), Image.LANCZOS)
    r, g, b, a = shadow_scaled.split()
    a = a.point(lambda x: int(x * op))
    shadow_scaled = Image.merge("RGBA", (r, g, b, a))
    anchor_x = int(shadow_anchor[0] * sc)
    anchor_y = int(shadow_anchor[1] * sc)
    paste_x = cx - sz // 2 - anchor_x
    paste_y = cy - sz // 2 - anchor_y
    canvas.paste(shadow_scaled, (paste_x, paste_y), shadow_scaled)
    return canvas

# ── Paths ──────────────────────────────────────────────────────────────────────

BASE = r"c:\Users\Lucas\Desktop\MotionIA\vid1"
vid_path    = os.path.join(BASE, "C9115_3.mp4")
icon_l_path = os.path.join(BASE, "ChatGPT Image 24 de jun. de 2026, 17_23_46 1.png")
icon_r_path = os.path.join(BASE, "ChatGPT Image 24 de jun. de 2026, 17_27_52 1.png")
out_raw     = os.path.join(BASE, "behind_raw.mp4")
out_final   = os.path.join(BASE, "output_behind.mp4")

# ── Settings ───────────────────────────────────────────────────────────────────

OUT_W, OUT_H = 1080, 1920
ICON_SIZE = 340

# Segmentation at half-res for speed (mask upscaled after)
SEG_W, SEG_H = 540, 960

# Final icon positions (center of icon, in 1080x1920 space)
L_CX, L_CY = 218, 640   # Claude (left)
R_CX, R_CY = 860, 580   # ChatGPT (right)

L_T0 = 0.45
R_T0 = 0.80
START_Y = OUT_H + 600
D, W = 5.5, 8.0

# ── Setup ──────────────────────────────────────────────────────────────────────

print("Loading icons...")
icon_l_base = Image.open(icon_l_path).convert("RGBA").resize((ICON_SIZE, ICON_SIZE), Image.LANCZOS)
icon_r_base = Image.open(icon_r_path).convert("RGBA").resize((ICON_SIZE, ICON_SIZE), Image.LANCZOS)
icon_l_shadow, sl_anchor = add_shadow(icon_l_base)
icon_r_shadow, sr_anchor = add_shadow(icon_r_base)

print("Loading segmentation model (first run may download ~170MB)...")
session = new_session("u2net")
print("Model ready.\n")

cap = cv2.VideoCapture(vid_path)
fps      = cap.get(cv2.CAP_PROP_FPS)
n_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
print(f"Video: {fps:.3f}fps  {n_frames} frames  {n_frames/fps:.2f}s")

fourcc = cv2.VideoWriter_fourcc(*'mp4v')
writer = cv2.VideoWriter(out_raw, fourcc, fps, (OUT_W, OUT_H))

# ── Main loop ──────────────────────────────────────────────────────────────────

t0_wall = time.time()
frame_n  = 0

while True:
    ret, frame = cap.read()
    if not ret:
        break

    t = frame_n / fps

    # ── Layer 0: background (original frame at output res) ────────────────────
    frame_out = cv2.resize(frame, (OUT_W, OUT_H))
    bg = Image.fromarray(cv2.cvtColor(frame_out, cv2.COLOR_BGR2RGB)).convert("RGBA")

    # ── Layer 1: icons (animated, spring bounce) ──────────────────────────────
    icon_canvas = Image.new("RGBA", (OUT_W, OUT_H), (0, 0, 0, 0))
    icon_canvas = composite_icon(icon_canvas, icon_l_shadow, sl_anchor,
                                 L_CX, L_CY, t, L_T0, START_Y, D, W, ICON_SIZE, OUT_H)
    icon_canvas = composite_icon(icon_canvas, icon_r_shadow, sr_anchor,
                                 R_CX, R_CY, t, R_T0, START_Y, D, W, ICON_SIZE, OUT_H)
    bg.paste(icon_canvas, (0, 0), icon_canvas)

    # ── Layer 2: person (segmented at half-res, upscaled) ─────────────────────
    frame_seg = cv2.resize(frame, (SEG_W, SEG_H))
    frame_seg_pil = Image.fromarray(cv2.cvtColor(frame_seg, cv2.COLOR_BGR2RGB))
    person_small = remove(frame_seg_pil, session=session)
    person = person_small.resize((OUT_W, OUT_H), Image.LANCZOS)
    bg.paste(person, (0, 0), person)

    # ── Write ─────────────────────────────────────────────────────────────────
    result = cv2.cvtColor(np.array(bg.convert("RGB")), cv2.COLOR_RGB2BGR)
    writer.write(result)

    frame_n += 1
    if frame_n % 10 == 0 or frame_n == n_frames:
        elapsed = time.time() - t0_wall
        fps_proc = frame_n / elapsed if elapsed > 0 else 0
        remaining = (n_frames - frame_n) / fps_proc if fps_proc > 0 else 0
        print(f"  [{100*frame_n/n_frames:5.1f}%] frame {frame_n}/{n_frames}"
              f"  {fps_proc:.1f}fps  ~{remaining:.0f}s restantes")

cap.release()
writer.release()

total = time.time() - t0_wall
print(f"\nFrames prontos em {total:.0f}s. Adicionando áudio...")

subprocess.run([
    "ffmpeg",
    "-i", out_raw,
    "-i", vid_path,
    "-map", "0:v",
    "-map", "1:a?",
    "-c:v", "libx264", "-crf", "17", "-preset", "fast",
    "-c:a", "copy",
    out_final, "-y"
], check=True)

os.remove(out_raw)
print(f"\nPronto! → {out_final}")
