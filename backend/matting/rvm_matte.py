"""
Matting de pessoa com RobustVideoMatting (RVM) → WebM VP9 com alpha.

Pipeline SEM PNGs:
  1. ffmpeg extrai SÓ o trecho [start,end] do vídeo bruto como rawvideo rgb24
     no stdout (nunca o vídeo inteiro, nunca PNGs).
  2. RVM processa frame a frame (com estado recorrente = coerência temporal) e
     produz foreground (fgr) + alpha (pha).
  3. Escreve rgba cru no stdin de um ffmpeg que grava WebM VP9 com alpha (yuva420p).

Uso:
  python rvm_matte.py --input v.mp4 --output a.webm --start-frame 30 --end-frame 120 \
    --fps 30 --width 1080 --height 1920 --device cuda
"""
import argparse
import subprocess
import sys


def build_ffmpeg_in(path, start_sec, dur_sec, fps, w, h):
    # -ss antes do -i = seek rápido; recorta só o trecho e reescala p/ WxH.
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-ss", f"{start_sec:.3f}", "-t", f"{dur_sec:.3f}", "-i", path,
        "-vf", f"scale={w}:{h},fps={fps}",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]


def build_ffmpeg_out(path, fps, w, h):
    # WebM VP9 com alpha (yuva420p). -auto-alt-ref 0 é obrigatório p/ preservar alpha.
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}", "-r", f"{fps}", "-i", "-",
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0",
        # MESMAS tags de cor do fundo (colorPrePass) → fundo e recorte decodam
        # idênticos no Chromium (sem pop de tonalidade na entrada/saída do recorte).
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
        "-b:v", "0", "-crf", "20", path,
    ]


def run(args) -> None:
    import numpy as np
    import torch

    device = args.device if (args.device != "cuda" or torch.cuda.is_available()) else "cpu"
    if device != args.device:
        print(f"aviso: CUDA indisponível, usando {device}", file=sys.stderr)

    # RVM (mobilenetv3 = leve e rápido). Baixa pesos na 1ª vez (torch.hub cache).
    model = torch.hub.load("PeterL1n/RobustVideoMatting", "mobilenetv3", trust_repo=True).eval().to(device)

    w, h, fps = args.width, args.height, args.fps
    start_sec = args.start_frame / fps
    dur_sec = max(1, args.end_frame - args.start_frame) / fps

    p_in = subprocess.Popen(build_ffmpeg_in(args.input, start_sec, dur_sec, fps, w, h),
                            stdout=subprocess.PIPE)
    p_out = subprocess.Popen(build_ffmpeg_out(args.output, fps, w, h), stdin=subprocess.PIPE)

    frame_bytes = w * h * 3
    # downsample_ratio menor = mais rápido; 0.25 é bom p/ ~1080p.
    downsample = 0.25 if max(w, h) >= 1024 else 0.4
    rec = [None] * 4

    with torch.no_grad():
        while True:
            raw = p_in.stdout.read(frame_bytes)
            if len(raw) < frame_bytes:
                break
            arr = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3)
            src = torch.from_numpy(arr.copy()).to(device).permute(2, 0, 1).unsqueeze(0).float() / 255.0
            _fgr, pha, *rec = model(src, *rec, downsample)
            # Cor = frame ORIGINAL (nítido). Alpha = pha "apertado" (smoothstep)
            # para reduzir o halo borrado da borda.
            pa = pha.clamp(0, 1)[0, 0].cpu().numpy()
            lo, hi = 0.35, 0.7
            t = np.clip((pa - lo) / (hi - lo), 0.0, 1.0)
            a = (t * t * (3 - 2 * t) * 255).astype(np.uint8)
            rgba = np.dstack([arr, a])
            p_out.stdin.write(rgba.tobytes())

    p_in.stdout.close()
    p_out.stdin.close()
    p_in.wait()
    p_out.wait()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--start-frame", type=int, required=True)
    p.add_argument("--end-frame", type=int, required=True)
    p.add_argument("--fps", type=float, default=30)
    p.add_argument("--width", type=int, required=True)
    p.add_argument("--height", type=int, required=True)
    p.add_argument("--device", default="cuda")
    run(p.parse_args())


if __name__ == "__main__":
    main()
