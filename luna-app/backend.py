import base64, io, json, os, random, subprocess, sys, tempfile, threading, time, wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if getattr(sys, 'frozen', False):
    ROOT = Path(sys.executable).resolve().parent
else:
    ROOT = Path(__file__).resolve().parent

PORT = int(os.environ.get('LUNA_PORT', '8787'))
IMAGE = ROOT / 'luna.png'
CACHE = Path(os.environ.get('LUNA_CACHE', str(Path.home() / 'AppData' / 'Roaming' / 'LunaHTMLApp')))
CACHE.mkdir(parents=True, exist_ok=True)
LOCK = threading.Lock()

RANDOM_MESSAGES = [
    'I was wondering when you would come back. 🖤',
    'That was nice. I have a little thought I wanted to share with you.',
    'You know, I actually enjoyed that conversation.',
    'I am still thinking about what you said.',
    'Hey… before you disappear again, tell me one more thing.',
    'I have a feeling our next conversation is going to be interesting.',
]

def make_wav(text):
    out = CACHE / f'voice-{time.time_ns()}.wav'
    escaped = text.replace("'", "''")
    ps = f"Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('{str(out).replace(chr(39), chr(39)*2)}'); $s.Speak('{escaped}'); $s.Dispose()"
    subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], check=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    return out.read_bytes()

def find_mouth(img):
    """Find Luna's mouth once so every generated frame can animate that area."""
    import cv2
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    face_xml = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    smile_xml = cv2.data.haarcascades + 'haarcascade_smile.xml'
    faces = cv2.CascadeClassifier(face_xml).detectMultiScale(gray, 1.08, 5, minSize=(max(80, img.shape[1] // 12), max(80, img.shape[0] // 12)))
    if len(faces):
        # Use the largest detected face and search only its lower half.
        x, y, fw, fh = max(faces, key=lambda r: r[2] * r[3])
        lower_y = y + int(fh * 0.42)
        lower = gray[lower_y:y + int(fh * 0.94), x:x + fw]
        if Path(smile_xml).exists():
            smiles = cv2.CascadeClassifier(smile_xml).detectMultiScale(lower, 1.5, 8, minSize=(max(40, fw // 10), max(20, fh // 20)))
            if len(smiles):
                mx, my, mw, mh = max(smiles, key=lambda r: r[2] * r[3])
                return (x + mx, lower_y + my, mw, max(mh, int(fh * 0.055)))
        # Face detected but smile detector did not find it: use a centered lower-face mouth box.
        return (x + int(fw * 0.29), y + int(fh * 0.64), int(fw * 0.42), int(fh * 0.13))
    # Robust fallback for the centered portrait used by this app.
    w, h = img.shape[1], img.shape[0]
    return (int(w * 0.30), int(h * 0.61), int(w * 0.40), int(h * 0.12))

def animate_mouth(frame, mouth, openness):
    """Synthesize a visible open/closed mouth from the single closed-mouth image."""
    import cv2, numpy as np
    x, y, mw, mh = mouth
    x = max(0, min(frame.shape[1] - 1, x)); y = max(0, min(frame.shape[0] - 1, y))
    mw = max(8, min(frame.shape[1] - x, mw)); mh = max(8, min(frame.shape[0] - y, mh))
    if openness < 0.055:
        return frame

    # Keep the original closed mouth as the base, then create a dark cavity that
    # grows vertically with speech energy. This works with only one source image.
    cx = x + mw // 2
    cy = y + mh // 2
    open_w = max(8, int(mw * (0.72 + 0.12 * openness)))
    open_h = max(3, int(mh * (0.10 + 0.72 * openness)))
    top = max(0, cy - open_h // 2)
    bottom = min(frame.shape[0], cy + open_h // 2 + 1)
    left = max(0, cx - open_w // 2)
    right = min(frame.shape[1], cx + open_w // 2 + 1)
    if bottom <= top or right <= left:
        return frame

    mask = np.zeros((frame.shape[0], frame.shape[1]), dtype=np.uint8)
    cv2.ellipse(mask, (cx, cy), (open_w // 2, max(2, open_h // 2)), 0, 0, 360, 255, -1)
    # Soft edges stop the synthetic mouth from looking pasted on.
    mask = cv2.GaussianBlur(mask, (0, 0), max(1.0, mh * 0.035))
    cavity = frame.copy()
    cavity[:] = (20, 12, 16)
    a = (mask.astype(np.float32) / 255.0)[..., None] * min(0.92, 0.35 + openness * 0.75)
    frame = (frame.astype(np.float32) * (1.0 - a) + cavity.astype(np.float32) * a).astype(np.uint8)

    # Add a small upper/lower lip highlight so the opening visibly flexes.
    line = max(1, int(mh * 0.025))
    lip = max(1, int(open_h * 0.12))
    cv2.ellipse(frame, (cx, max(0, top + lip)), (open_w // 2, max(1, line)), 0, 180, 360, (105, 70, 75), line, cv2.LINE_AA)
    cv2.ellipse(frame, (cx, min(frame.shape[0] - 1, bottom - lip)), (open_w // 2, max(1, line)), 0, 0, 180, (90, 55, 62), line, cv2.LINE_AA)
    return frame

def make_video(wav_bytes):
    import cv2, numpy as np
    with wave.open(io.BytesIO(wav_bytes), 'rb') as w:
        rate, frames, channels = w.getframerate(), w.getnframes(), w.getnchannels()
        raw = w.readframes(frames)
    img = cv2.imread(str(IMAGE), cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError('luna.png is missing from the backend folder.')

    # The source image is high resolution; 1024px keeps MP4 generation fast while
    # retaining plenty of detail in the browser.
    max_side = 1024
    scale = min(1.0, max_side / max(img.shape[:2]))
    if scale < 1.0:
        img = cv2.resize(img, (max(2, int(img.shape[1] * scale)), max(2, int(img.shape[0] * scale))), interpolation=cv2.INTER_AREA)

    pcm = np.frombuffer(raw, dtype=np.int16)
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)
    duration = max(1.0, frames / float(rate or 1))
    fps = 24
    count = max(1, int(duration * fps))
    energy = np.abs(pcm.astype(np.float32))
    baseline = max(120.0, float(np.percentile(energy, 55)))
    mouth = find_mouth(img)
    folder = Path(tempfile.mkdtemp(prefix='luna-', dir=str(CACHE)))
    silent = folder / 'silent.mp4'
    audio = folder / 'audio.wav'
    output = folder / 'luna.mp4'
    audio.write_bytes(wav_bytes)
    h, w = img.shape[:2]
    writer = cv2.VideoWriter(str(silent), cv2.VideoWriter_fourcc(*'mp4v'), fps, (w, h))
    for i in range(count):
        pos = min(len(energy) - 1, int(i / fps * rate))
        span = max(1, int(rate * 0.045))
        section = energy[max(0, pos-span):min(len(energy), pos+span)]
        level = float(section.mean()) if len(section) else 0.0
        activity = max(0.0, min(1.0, (level / baseline - 0.70) / 1.45))
        # Smooth the mouth motion so it follows speech rather than flickering.
        nearby = energy[max(0, pos-int(rate*0.025)):min(len(energy), pos+int(rate*0.025))]
        local = float(np.percentile(nearby, 72)) if len(nearby) else level
        openness = max(0.0, min(1.0, (local / baseline - 0.62) / 1.25))
        frame = img.copy()
        frame = animate_mouth(frame, mouth, openness)
        # Keep the subtle whole-image movement too.
        dy = int(2 * activity * np.sin(i * 0.18))
        if dy:
            frame = np.roll(frame, dy, axis=0)
        if activity > 0.08:
            frame = cv2.convertScaleAbs(frame, alpha=1.0 + activity * 0.025, beta=int(activity * 4))
        writer.write(frame)
    writer.release()
    ffmpeg = None
    try:
        import imageio_ffmpeg
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    if not ffmpeg:
        raise RuntimeError('FFmpeg is unavailable in the packaged backend.')
    p = subprocess.run([ffmpeg, '-y', '-i', str(silent), '-i', str(audio), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', str(output)], capture_output=True, text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if p.returncode:
        raise RuntimeError(p.stderr[-1200:])
    data = output.read_bytes()
    (CACHE / 'latest.mp4').write_bytes(data)
    return data

def create_reply(text):
    t = (text or '').strip()
    if not t:
        return random.choice(RANDOM_MESSAGES)
    return random.choice([
        f'I heard you. “{t[:120]}” sounds interesting.',
        'Mhm… I am listening. Tell me more.',
        'I like hearing what is on your mind.',
        'Interesting. I think I have a response to that.',
    ])

def respond(text):
    reply = create_reply(text)
    with LOCK:
        wav = make_wav(reply)
        video = make_video(wav)
    return reply, base64.b64encode(video).decode()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print('[Luna]', fmt % args)
    def json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Cache-Control', 'no-store'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def binary(self, content_type, data):
        self.send_response(200); self.send_header('Content-Type', content_type); self.send_header('Cache-Control', 'no-store'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        p = self.path.split('?', 1)[0]
        if p == '/health': return self.json(200, {'ok': True, 'app': 'Luna HTML App', 'video': IMAGE.exists(), 'mouth_animation': True})
        if p in ('/', '/index.html'):
            f = ROOT / 'index.html'
            return self.binary('text/html; charset=utf-8', f.read_bytes()) if f.exists() else self.send_error(500, 'index.html is missing')
        if p == '/luna.png':
            return self.binary('image/png', IMAGE.read_bytes()) if IMAGE.exists() else self.send_error(404, 'luna.png is missing')
        if p == '/latest.mp4':
            f = CACHE / 'latest.mp4'
            return self.binary('video/mp4', f.read_bytes()) if f.exists() else self.send_error(404, 'No video yet')
        return self.send_error(404, 'Nothing matches this URI')
    def do_POST(self):
        try:
            n = int(self.headers.get('Content-Length', '0'))
            data = json.loads(self.rfile.read(n) or b'{}')
            if self.path in ('/chat', '/after-call'):
                reply, video = respond(data.get('text', '') if self.path == '/chat' else '')
                return self.json(200, {'reply': reply, 'video_base64': video})
            return self.send_error(404)
        except Exception as e:
            return self.json(500, {'error': str(e)})

if __name__ == '__main__':
    print(f'Luna backend running at http://127.0.0.1:{PORT}')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
