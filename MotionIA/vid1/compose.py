import cv2
import numpy as np
from PIL import Image, ImageFilter
import math
import subprocess
import os

# ── Animation helpers ──────────────────────────────────────────────────────────

def spring_y(t, t0, final_y, start_y, d=5.5, w=8):
    """Damped spring: start_y → final_y with overshoot bounce."""
    if t < t0:
        return int(start_y)
    tau = t - t0
    val = final_y + (start_y - final_y) * math.exp(-d * tau) * math.cos(w * tau)
    return int(val)

def spring_scale(t, t0, d=7, w=9):
    """Scale 0 → 1 with bounce overshoot."""
    if t < t0:
        return 0.0
    tau = t - t0
    val = 1.0 - math.exp(-d * tau) * math.cos(w * tau)
    return max(0.0, min(1.15, val))

def ease_opacity(t, t0, dur=0.18):
    """Fade in over `dur` seconds."""
    if t < t0:
        return 0.0
    return min(1.0, (t - t0) / dur)

# ── Shadow helper ──────────────────────────────────────────────────────────────

def add_shadow(icon_rgba, offset=(12, 18), blur=14, opacity=0.45):
    """Return icon composited onto its own drop shadow."""
    w, h = icon_rgba.size
    pad = blur * 2 + max(abs(offset[0]), abs(offset[1])) + 10
    canvas_w = w + pad * 2
    canvas_h = h + pad * 2

    shadow_layer = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    alpha = icon_rgba.split()[3]
    dark = Image.new("RGBA", (w, h), (0, 0, 0, int(255 * opacity)))
    dark.putalpha(alpha)
    shadow_layer.paste(dark, (pad + offset[0], pad + offset[1]), dark)
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(blur))

    result = shadow_layer.copy()
    result.paste(icon_rgba, (pad, pad), icon_rgba)
    return result, (pad, pad)  # return image and offset to anchor point

# ── Paths ──────────────────────────────────────────────────────────────────────

BASE = r"c:\Users\Lucas\Desktop\MotionIA\vid1"
vid_path    = os.path.join(BASE, "C9115_3.mp4")
icon_l_path = os.path.join(BASE, "ChatGPT Image 24 de jun. de 2026, 17_23_46 1.png")
icon_r_path = os.path.join(BASE, "ChatGPT Image 24 de jun. de 2026, 17_27_52 1.png")
out_raw     = os.path.join(BASE, "output_raw.mp4")
out_final   = os.path.join(BASE, "output_icons.mp4")

# ── Settings ───────────────────────────────────────────────────────────────────

OUT_W, OUT_H = 1080, 1920
ICON_SIZE = 340        # base icon size in output pixels

# Final resting positions (center of icon)
L_CX, L_CY = 218, 640   # left icon center  (Claude)
R_CX, R_CY = 860, 580   # right icon center (GPT)

# Animation timings
L_T0 = 0.45   # left icon starts bouncing at t=0.45s
R_T0 = 0.80   # right icon starts bouncing at t=0.80s

START_Y = OUT_H + 600   # off-screen starting Y

# Spring physics
D, W = 5.5, 8.0   # damping, frequency

# ── Pre-process icons ──────────────────────────────────────────────────────────

print("Loading icons...")
icon_l_base = Image.open(icon_l_path).convert("RGBA").resize(
    (ICON_SIZE, ICON_SIZE), Image.LANCZOS)
icon_r_base = Image.open(icon_r_path).convert("RGBA").resize(
    (ICON_SIZE, ICON_SIZE), Image.LANCZOS)

# Pre-build shadow versions at full size
icon_l_shadow, (sl_ox, sl_oy) = add_shadow(icon_l_base)
icon_r_shadow, (sr_ox, sr_oy) = add_shadow(icon_r_base)

# ── Open video ─────────────────────────────────────────────────────────────────

cap = cv2.VideoCapture(vid_path)
fps    = cap.get(cv2.CAP_PROP_FPS)
n_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
print(f"Video: {fps:.3f}fps, {n_frames} frames, {n_frames/fps:.2f}s")

fourcc = cv2.VideoWriter_fourcc(*'mp4v')
writer = cv2.VideoWriter(out_raw, fourcc, fps, (OUT_W, OUT_H))

# ── Process frames ─────────────────────────────────────────────────────────────

def composite_icon(frame_pil, icon_base, icon_shadow, shadow_anchor,
                   cx, final_cy, t, t0, start_y):
    """Animate and composite one icon onto frame_pil (RGBA)."""
    # Spring position (top-left of base icon)
    cy = spring_y(t, t0, final_cy, start_y, D, W)

    # Skip if fully off-screen
    if cy > OUT_H + ICON_SIZE:
        return frame_pil

    # Spring scale
    sc = spring_scale(t, t0)
    if sc < 0.01:
        return frame_pil

    # Opacity
    op = ease_opacity(t, t0)
    if op < 0.01:
        return frame_pil

    sz = max(10, int(ICON_SIZE * sc))

    # Resize shadow composite to current scale
    sw_full = icon_shadow.size[0]
    sh_full = icon_shadow.size[1]
    sw = int(sw_full * sc)
    sh = int(sh_full * sc)
    if sw < 5 or sh < 5:
        return frame_pil

    shadow_scaled = icon_shadow.resize((sw, sh), Image.LANCZOS)

    # Apply opacity to entire shadow+icon composite
    r, g, b, a = shadow_scaled.split()
    a = a.point(lambda x: int(x * op))
    shadow_scaled = Image.merge("RGBA", (r, g, b, a))

    # Anchor: the top-left of the BASE icon within the shadow image
    anchor_x = int(shadow_anchor[0] * sc)
    anchor_y = int(shadow_anchor[1] * sc)

    # Paste position: center icon at (cx, cy)
    paste_x = cx - sz // 2 - anchor_x
    paste_y = cy - sz // 2 - anchor_y

    frame_pil.paste(shadow_scaled, (paste_x, paste_y), shadow_scaled)
    return frame_pil


frame_n = 0
while True:
    ret, frame = cap.read()
    if not ret:
        break

    t = frame_n / fps

    # Scale frame to 1080×1920
    frame_resized = cv2.resize(frame, (OUT_W, OUT_H))
    frame_pil = Image.fromarray(
        cv2.cvtColor(frame_resized, cv2.COLOR_BGR2RGB)).convert("RGBA")

    # Composite left icon (Claude)
    frame_pil = composite_icon(
        frame_pil, icon_l_base, icon_l_shadow, (sl_ox, sl_oy),
        L_CX, L_CY, t, L_T0, START_Y)

    # Composite right icon (GPT)
    frame_pil = composite_icon(
        frame_pil, icon_r_base, icon_r_shadow, (sr_ox, sr_oy),
        R_CX, R_CY, t, R_T0, START_Y)

    # Write frame
    result = cv2.cvtColor(
        np.array(frame_pil.convert("RGB")), cv2.COLOR_RGB2BGR)
    writer.write(result)

    frame_n += 1
    if frame_n % 30 == 0 or frame_n == n_frames:
        pct = 100 * frame_n / n_frames
        print(f"  [{pct:5.1f}%] frame {frame_n}/{n_frames}")

cap.release()
writer.release()
print("Frames done. Merging audio...")

# ── Merge audio ────────────────────────────────────────────────────────────────

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
print(f"\nDone! → {out_final}")
