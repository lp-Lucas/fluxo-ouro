from flask import Flask, request, jsonify, send_file, send_from_directory
from werkzeug.utils import secure_filename
import os, json, uuid, subprocess, threading, re

app = Flask(__name__, static_folder='dist', static_url_path='')

BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
TEMP_DIR   = os.path.join(BASE_DIR, 'temp')
OUTPUT_DIR = os.path.join(BASE_DIR, 'outputs')
FLOW_FILE  = os.path.join(BASE_DIR, 'flow.json')

os.makedirs(TEMP_DIR,   exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

jobs = {}   # job_id -> {status, url, local_url, error, log}


CREDIT_LIMIT = 30   # bloqueia geração acima deste valor

def higgs(*args):
    return ['higgsfield', *args, '--json', '--no-color']


def _get_credits_report():
    """Retorna saldo atual e créditos gastos na última transação."""
    try:
        status = json.loads(subprocess.run(
            higgs('account', 'status'), capture_output=True, text=True, timeout=15
        ).stdout)
        txns = json.loads(subprocess.run(
            higgs('account', 'transactions', '--size', '1'),
            capture_output=True, text=True, timeout=15
        ).stdout)
        spent = abs(txns[0]['credits']) if txns else 0
        return {
            'spent':     spent,
            'remaining': status.get('credits', 0),
        }
    except Exception:
        return None


def _estimate_cost(model, prompt, upload_id, params):
    """Chama higgsfield generate cost e retorna créditos estimados."""
    cmd = ['higgsfield', 'generate', 'cost', model,
           '--prompt', prompt, '--json', '--no-color']
    if upload_id:
        cmd += ['--image', upload_id]
    for key, val in params.items():
        if val is not None and str(val).strip():
            cmd += [f'--{key}', str(val).lower() if isinstance(val, bool) else str(val)]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        data = json.loads(result.stdout)
        if isinstance(data, dict):
            return float(data.get('credits') or data.get('cost') or data.get('total') or 0)
        if isinstance(data, list) and data:
            return float(data[0].get('credits') or 0)
    except Exception:
        pass
    return None


def extract_video_url(obj):
    if isinstance(obj, str):
        if obj.startswith('http') and any(obj.lower().endswith(e) for e in ('.mp4', '.mov', '.webm')):
            return obj
        return None
    if isinstance(obj, list):
        for item in obj:
            r = extract_video_url(item)
            if r: return r
        return None
    if isinstance(obj, dict):
        for key in ('url', 'video_url', 'videoUrl', 'output_url', 'download_url', 'src'):
            val = obj.get(key)
            if val and isinstance(val, str) and val.startswith('http'):
                return val
        for key in ('outputs', 'results', 'videos', 'data', 'job', 'output', 'result'):
            val = obj.get(key)
            if val:
                r = extract_video_url(val)
                if r: return r
        for val in obj.values():
            if isinstance(val, (dict, list)):
                r = extract_video_url(val)
                if r: return r
    return None


def download_video(url, path):
    import urllib.request
    urllib.request.urlretrieve(url, path)


def run_job(job_id, cmd, output_filename):
    try:
        jobs[job_id]['log'] = ' '.join(cmd)
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=900)

        raw_out = result.stdout.strip()
        raw_err = result.stderr.strip()
        jobs[job_id]['raw'] = raw_out[:2000]

        if result.returncode != 0:
            jobs[job_id].update({'status': 'error', 'error': raw_err or f'Exit {result.returncode}\n{raw_out[:500]}'})
            return

        # Parse JSON — the CLI may print non-JSON lines before the payload
        data = None
        for line in reversed(raw_out.splitlines()):
            line = line.strip()
            if line.startswith('{') or line.startswith('['):
                try:
                    data = json.loads(line)
                    break
                except Exception:
                    pass
        if data is None:
            match = re.search(r'(\{.*\}|\[.*\])', raw_out, re.DOTALL)
            if match:
                try:
                    data = json.loads(match.group())
                except Exception:
                    pass

        video_url = extract_video_url(data) if data else None

        # Fallback: grep for video URL in raw text
        if not video_url:
            urls = re.findall(r'https?://[^\s\'"<>]+\.(?:mp4|mov|webm)', raw_out)
            video_url = urls[0] if urls else None

        if video_url:
            local_path = os.path.join(OUTPUT_DIR, output_filename)
            download_video(video_url, local_path)

            # ── Relatório de créditos pós-geração ──
            credits_info = _get_credits_report()

            jobs[job_id].update({
                'status':    'done',
                'url':       video_url,
                'local_url': f'/api/output/{output_filename}',
                'local_path': local_path,
                'credits':   credits_info,
            })
        else:
            jobs[job_id].update({
                'status': 'error',
                'error':  f'URL não encontrada na resposta.\n\nOutput:\n{raw_out[:800]}'
            })

    except subprocess.TimeoutExpired:
        jobs[job_id].update({'status': 'error', 'error': 'Timeout (15 min)'})
    except Exception as e:
        jobs[job_id].update({'status': 'error', 'error': str(e)})


# ── API ─────────────────────────────────────────────────────────────────────

@app.route('/api/upload', methods=['POST'])
def upload_file():
    file = request.files.get('file')
    if not file:
        return jsonify({'error': 'No file'}), 400

    filename = secure_filename(file.filename)
    local_path = os.path.join(TEMP_DIR, filename)
    file.save(local_path)
    preview_url = f'/api/temp/{filename}'

    try:
        result = subprocess.run(higgs('upload', local_path), capture_output=True, text=True, timeout=120)
        data = json.loads(result.stdout)
        upload_id = (data.get('id') or data.get('upload_id') or data.get('uploadId') or '')
        return jsonify({'upload_id': upload_id, 'preview_url': preview_url, 'local_path': local_path})
    except Exception as e:
        return jsonify({'upload_id': '', 'preview_url': preview_url, 'local_path': local_path, 'warn': str(e)})


@app.route('/api/generate', methods=['POST'])
def generate():
    body = request.json or {}
    model     = body.get('model', 'seedance_2_0')
    prompt    = (body.get('prompt') or '').strip()
    upload_id = (body.get('upload_id') or '').strip()
    params    = body.get('params', {})

    if not prompt:
        return jsonify({'error': 'Prompt obrigatório'}), 400

    # ── Verificar custo antes de gerar ──
    estimated = _estimate_cost(model, prompt, upload_id, params)
    if estimated is not None and estimated > CREDIT_LIMIT:
        return jsonify({
            'error': f'Custo estimado ({estimated} créditos) excede o limite de {CREDIT_LIMIT}.\n'
                     f'Reduza a duração ou mude para 720p.'
        }), 400

    job_id = str(uuid.uuid4())[:8]
    output_filename = f'{job_id}_{model}.mp4'

    cmd = [
        'higgsfield', 'generate', 'create', model,
        '--prompt', prompt,
        '--wait', '--wait-timeout', '15m', '--wait-interval', '8s',
        '--json', '--no-color',
    ]

    if upload_id:
        cmd += ['--image', upload_id]

    for key, val in params.items():
        if val is not None and str(val).strip():
            cmd += [f'--{key}', str(val).lower() if isinstance(val, bool) else str(val)]

    jobs[job_id] = {
        'status': 'running', 'url': None, 'local_url': None,
        'error': None, 'log': '', 'estimated_cost': estimated,
    }
    t = threading.Thread(target=run_job, args=(job_id, cmd, output_filename), daemon=True)
    t.start()

    return jsonify({'job_id': job_id, 'estimated_cost': estimated})


@app.route('/api/job/<job_id>')
def get_job(job_id):
    return jsonify(jobs.get(job_id, {'status': 'not_found'}))


@app.route('/api/temp/<filename>')
def serve_temp(filename):
    return send_from_directory(TEMP_DIR, filename)


@app.route('/api/output/<filename>')
def serve_output(filename):
    return send_file(os.path.join(OUTPUT_DIR, filename), conditional=True)


@app.route('/api/save-flow', methods=['POST'])
def save_flow():
    with open(FLOW_FILE, 'w', encoding='utf-8') as f:
        json.dump(request.json or {}, f, ensure_ascii=False, indent=2)
    return jsonify({'ok': True})


@app.route('/api/load-flow')
def load_flow():
    if os.path.exists(FLOW_FILE):
        with open(FLOW_FILE, 'r', encoding='utf-8') as f:
            return jsonify(json.load(f))
    return jsonify(None)


@app.route('/api/outputs')
def list_outputs():
    files = sorted(
        [f for f in os.listdir(OUTPUT_DIR) if f.endswith('.mp4')],
        key=lambda f: os.path.getmtime(os.path.join(OUTPUT_DIR, f)),
        reverse=True
    )
    return jsonify(files)


# ── Serve built frontend ────────────────────────────────────────────────────

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_frontend(path):
    dist = os.path.join(BASE_DIR, 'dist')
    if not os.path.isdir(dist):
        return '<h2>Frontend não buildado — execute install.bat</h2>', 503
    target = os.path.join(dist, path)
    if path and os.path.isfile(target):
        return send_from_directory(dist, path)
    return send_from_directory(dist, 'index.html')


if __name__ == '__main__':
    import webbrowser, time
    def open_browser():
        time.sleep(1.5)
        webbrowser.open('http://localhost:5003')
    threading.Thread(target=open_browser, daemon=True).start()
    print('[FlowStudio] http://localhost:5003')
    app.run(debug=False, port=5003, host='127.0.0.1')
