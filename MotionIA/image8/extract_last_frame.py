"""
extract_last_frame.py
Extrai o último frame de um vídeo gerado e salva como PNG.
Uso: python extract_last_frame.py <video.mp4> [output.png]
"""

import cv2
import sys
import os

def extract_last_frame(video_path: str, output_path: str | None = None) -> str:
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Não conseguiu abrir: {video_path}")

    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps   = cap.get(cv2.CAP_PROP_FPS)
    print(f"  {os.path.basename(video_path)} → {total} frames @ {fps:.2f}fps = {total/fps:.2f}s")

    # Vai até o último frame
    cap.set(cv2.CAP_PROP_POS_FRAMES, total - 1)
    ret, frame = cap.read()
    cap.release()

    if not ret:
        raise RuntimeError("Não conseguiu ler o último frame.")

    if output_path is None:
        base = os.path.splitext(video_path)[0]
        output_path = base + "_lastframe.png"

    cv2.imwrite(output_path, frame)
    print(f"  Salvo: {output_path}")
    return output_path


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Uso: python extract_last_frame.py <video.mp4> [output.png]")
        sys.exit(1)

    video = sys.argv[1]
    out   = sys.argv[2] if len(sys.argv) > 2 else None
    extract_last_frame(video, out)
