from flask import Flask, request, jsonify, render_template, send_file
import os, json, threading, webbrowser

app = Flask(__name__)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
NOTES_FILE = os.path.join(BASE_DIR, 'notes.json')
VIDEO_EXTS = ('.mp4', '.mov', '.webm', '.avi', '.mkv')


def load_notes():
    try:
        with open(NOTES_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def save_notes_data(data):
    with open(NOTES_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/videos')
def list_videos():
    folder = request.args.get('folder', '').strip()
    if not folder:
        return jsonify({'videos': [], 'error': ''})

    folder = os.path.normpath(folder)
    if not os.path.isdir(folder):
        return jsonify({'videos': [], 'error': 'Pasta não encontrada'})

    videos = [f for f in os.listdir(folder) if f.lower().endswith(VIDEO_EXTS)]
    videos.sort(key=lambda f: os.path.getmtime(os.path.join(folder, f)), reverse=True)

    return jsonify({'videos': videos, 'folder': folder})


@app.route('/api/video')
def serve_video():
    folder = request.args.get('folder', '').strip()
    filename = request.args.get('file', '').strip()
    if not folder or not filename:
        return 'Missing params', 400

    full_path = os.path.normpath(os.path.join(folder, filename))
    folder_abs = os.path.abspath(folder)
    if not full_path.startswith(folder_abs + os.sep) and full_path != folder_abs:
        return 'Forbidden', 403
    if not os.path.isfile(full_path):
        return 'File not found', 404

    ext = os.path.splitext(filename)[1].lower()
    mime = {'mp4': 'video/mp4', 'mov': 'video/quicktime', 'webm': 'video/webm',
            'avi': 'video/x-msvideo', 'mkv': 'video/x-matroska'}.get(ext.lstrip('.'), 'video/mp4')
    return send_file(full_path, conditional=True, mimetype=mime)


@app.route('/api/notes', methods=['GET'])
def get_notes():
    key = request.args.get('key', '')
    data = load_notes()
    return jsonify(data.get(key, {'model': '', 'prompt': '', 'notes': ''}))


@app.route('/api/notes', methods=['POST'])
def save_notes():
    body = request.json or {}
    key = body.get('key', '').strip()
    if not key:
        return jsonify({'error': 'No key'}), 400

    data = load_notes()
    data[key] = {
        'model':  body.get('model', ''),
        'prompt': body.get('prompt', ''),
        'notes':  body.get('notes', ''),
    }
    save_notes_data(data)
    return jsonify({'ok': True})


if __name__ == '__main__':
    def open_browser():
        import time; time.sleep(1.2)
        webbrowser.open('http://localhost:5002')
    threading.Thread(target=open_browser, daemon=True).start()
    print('[MotionIA Viewer] http://localhost:5002')
    app.run(debug=False, port=5002, host='127.0.0.1')
