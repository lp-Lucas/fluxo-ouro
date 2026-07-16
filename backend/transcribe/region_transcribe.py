"""
Transcreve regiões (janelas em ms) com timestamps de PALAVRA — para recuperar repetições que a
transcrição canônica achatou (ex.: "com a crux você" dito 2x colado em "sabe" 2s). NÃO entra na
canônica; alimenta só a detecção de repetição fina dentro de uma região de disfluência.

Uso: python region_transcribe.py <arquivo> <janelas.json>
  janelas.json = [{"startMs":..,"endMs":..}, ...]
  saída: [[{"text":..,"start":segundos_abs,"end":segundos_abs}, ...], ...]  (na ordem das janelas)
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
    for win in windows:
        start = win["startMs"] / 1000.0
        s = max(0, int(round(win["startMs"] / 1000 * SR)))
        e = min(len(audio), int(round(win["endMs"] / 1000 * SR)))
        if e - s < int(0.1 * SR):
            out.append([])
            continue
        segs, _ = model.transcribe(
            audio[s:e], language="pt", word_timestamps=True, vad_filter=False,
            condition_on_previous_text=False,
        )
        words = []
        for seg in segs:
            for wd in (seg.words or []):
                words.append({"text": wd.word, "start": start + wd.start, "end": start + wd.end})
        out.append(words)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
