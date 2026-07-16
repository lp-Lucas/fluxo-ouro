"""
Transcreve a CABEÇA de cada bloco de fala (janelas em ms) — só o começo de cada tentativa,
para a detecção de zona de retake por cabeça-de-bloco. NÃO entra na transcrição canônica;
decide só fronteira de zona. Garble ataca o meio da frase, não a primeira palavra, então a
cabeça é robusta mesmo em clipe curto.

Uso: python head_transcribe.py <arquivo> <janelas.json>
  janelas.json = [{"startMs":..,"endMs":..}, ...]   (saída: [{"text": ".."}, ...] na ordem)
"""
import sys
import json


def main() -> None:
    import os
    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio

    video = sys.argv[1]
    with open(sys.argv[2], encoding="utf-8") as f:
        windows = json.load(f)

    device = os.environ.get("WHISPER_DEVICE", "cpu")
    compute_type = "float16" if device == "cuda" else "int8"
    model = WhisperModel("small", device=device, compute_type=compute_type)

    SR = 16000
    audio = decode_audio(video, sampling_rate=SR)
    out = []
    for w in windows:
        s = max(0, int(round(w["startMs"] / 1000 * SR)))
        e = min(len(audio), int(round(w["endMs"] / 1000 * SR)))
        if e - s < int(0.05 * SR):
            out.append({"text": ""})
            continue
        segs, _ = model.transcribe(audio[s:e], language="pt", word_timestamps=False, vad_filter=False)
        out.append({"text": " ".join(seg.text.strip() for seg in segs).strip()})
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
