"""
Transcrição com faster-whisper — fonte de verdade do projeto (CANÔNICA).

Recebe um caminho de áudio/vídeo e devolve JSON com segmentos e palavras
com timestamps, no formato consumido por shared/timeline.ts (TranscriptSegment).

Arquivo INTEIRO, de propósito: esta é a transcrição CANÔNICA — as palavras (legenda,
copy, contexto para a IA). Ela é fluente porque o Whisper usa contexto; fluência é o que
se quer numa legenda. A ESTRUTURA de tentativas (onde cada começo começa) NÃO vem daqui —
vem do VAD (Silero), que sempre viu as pausas. Não misturar as duas fontes.

Uso:
    python transcribe.py <arquivo> [--model small] [--lang pt]
"""
import sys
import json
import argparse


def transcribe(media_path: str, model_size: str, language: str) -> dict:
    import os
    from faster_whisper import WhisperModel

    # device por env (default CPU). int8 roda bem em CPU sem GPU — adequado para
    # uso interno. Para usar GPU, instale as libs CUDA/cuBLAS e defina WHISPER_DEVICE=cuda.
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    compute_type = "float16" if device == "cuda" else "int8"
    model = WhisperModel(model_size, device=device, compute_type=compute_type)

    segments, info = model.transcribe(
        media_path,
        language=language,
        word_timestamps=True,
        # vad_filter=False: o Silero VAD (na decupagem) é a ÚNICA autoridade de tempo.
        # Não deixamos o VAD interno do Whisper massagear os timestamps antes da ancoragem.
        vad_filter=False,
    )

    out_segments = []
    for i, seg in enumerate(segments):
        # per-word: probability; herdado do segmento pai: avgLogprob, noSpeechProb, compressionRatio.
        # São sinais de confiança do reconhecimento — usados pela guarda de mishear (não pelo tempo).
        words = [
            {
                "text": w.word,
                "start": round(w.start, 3),
                "end": round(w.end, 3),
                "probability": round(float(w.probability), 4),
                "avgLogprob": round(float(seg.avg_logprob), 4),
                "noSpeechProb": round(float(seg.no_speech_prob), 4),
                "compressionRatio": round(float(seg.compression_ratio), 4),
            }
            for w in (seg.words or [])
        ]
        out_segments.append(
            {
                "id": f"seg-{i}",
                "start": round(seg.start, 3),
                "end": round(seg.end, 3),
                "text": seg.text.strip(),
                "words": words,
                "source": "whisper",
            }
        )

    return {
        "language": info.language,
        "durationSec": round(info.duration, 3),
        "transcript": out_segments,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("media")
    parser.add_argument("--model", default="small")
    parser.add_argument("--lang", default="pt")
    args = parser.parse_args()
    result = transcribe(args.media, args.model, args.lang)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
