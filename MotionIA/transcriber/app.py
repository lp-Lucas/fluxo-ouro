from flask import Flask, request, jsonify, render_template
import os
import tempfile
import threading
import webbrowser
import subprocess

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # 500MB

model_cache = {}


def _check_ffmpeg():
    try:
        r = subprocess.run(['ffmpeg', '-version'], capture_output=True, timeout=8)
        return r.returncode == 0
    except Exception:
        return False


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/health')
def health():
    return jsonify({'ok': True, 'ffmpeg': _check_ffmpeg()})


@app.route('/transcribe', methods=['POST'])
def transcribe():
    if 'file' not in request.files:
        return jsonify({'error': 'Nenhum arquivo enviado'}), 400

    file = request.files['file']
    if not file.filename:
        return jsonify({'error': 'Arquivo inválido'}), 400

    model_name = request.form.get('model', 'base')
    suffix = os.path.splitext(file.filename)[1] or '.mp4'

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        file.save(tmp.name)
        tmp_path = tmp.name

    try:
        try:
            import whisper
        except ImportError:
            return jsonify({'error': 'Whisper não instalado. Execute: pip install openai-whisper'}), 500

        if not _check_ffmpeg():
            return jsonify({'error': 'ffmpeg não encontrado no PATH.\nInstale com: winget install Gyan.FFmpeg\nDepois feche e reabra o terminal.'}), 500

        if model_name not in model_cache:
            print(f'[Transcriber] Carregando modelo {model_name}...')
            model_cache[model_name] = whisper.load_model(model_name)

        model = model_cache[model_name]
        print(f'[Transcriber] Transcrevendo: {file.filename}')

        result = model.transcribe(
            tmp_path,
            word_timestamps=True,
            language='pt',
            verbose=False
        )

        words = []
        for segment in result['segments']:
            for word in segment.get('words', []):
                words.append({
                    'word': word['word'],
                    'start': round(word['start'], 3),
                    'end': round(word['end'], 3)
                })

        segments = [{
            'text': s['text'].strip(),
            'start': round(s['start'], 3),
            'end': round(s['end'], 3)
        } for s in result['segments']]

        return jsonify({
            'text': result['text'].strip(),
            'words': words,
            'segments': segments
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500

    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


@app.route('/motion', methods=['POST'])
def motion():
    body = request.get_json(silent=True) or {}
    text = (body.get('text') or '').strip()
    if not text:
        return jsonify({'error': 'Texto vazio'}), 400

    prompt = (
        'Você é um diretor criativo especializado em motion design para redes sociais verticais.\n\n'
        'Analise a transcrição abaixo e identifique as 3 frases mais impactantes para animar com motion design. '
        'Priorize frases que:\n'
        '- Geram retenção (curiosidade, impacto emocional, revelação, números)\n'
        '- São curtas e visualmente fortes (máx 8 palavras)\n'
        '- Têm ritmo natural que combina com animação palavra por palavra\n\n'
        'Transcrição:\n'
        f'"""\n{text}\n"""\n\n'
        'Responda APENAS com as 3 frases numeradas, sem explicação. Formato exato:\n'
        '1. "frase aqui"\n'
        '2. "frase aqui"\n'
        '3. "frase aqui"'
    )

    try:
        import os
        env = os.environ.copy()
        env['_MOTION_PROMPT'] = prompt
        result = subprocess.run(
            ['powershell', '-NoProfile', '-NonInteractive', '-Command', 'claude -p $env:_MOTION_PROMPT'],
            capture_output=True, text=True, encoding='utf-8', timeout=90, env=env
        )
        output = result.stdout.strip()
        if not output:
            err = result.stderr.strip()
            return jsonify({'error': err or 'Claude não retornou resposta'}), 500
        return jsonify({'result': output})
    except FileNotFoundError:
        return jsonify({'error': 'PowerShell não encontrado'}), 500
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Timeout — Claude demorou mais de 90s'}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    def open_browser():
        import time
        time.sleep(1.2)
        webbrowser.open('http://localhost:5001')

    threading.Thread(target=open_browser, daemon=True).start()
    print('[Transcriber] Rodando em http://localhost:5001')
    app.run(debug=False, port=5001, host='127.0.0.1')
