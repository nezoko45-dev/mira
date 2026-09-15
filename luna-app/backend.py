import base64, io, json, os, random, subprocess, sys, tempfile, threading, time, wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if getattr(sys, 'frozen', False):
    ROOT = Path(sys.executable).resolve().parent
else:
    ROOT = Path(__file__).resolve().parent

PORT = int(os.environ.get('LUNA_PORT', '8787'))
IMAGE = ROOT / 'luna.png'
WAV2LIP = ROOT / 'Wav2LipRunner' / 'Wav2LipRunner.exe'
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
    return out

def make_video(wav_path):
    if not WAV2LIP.exists():
        raise RuntimeError('Wav2LipRunner.exe is missing from the packaged Luna app.')
    if not IMAGE.exists():
        raise RuntimeError('luna.png is missing from the backend folder.')
    out = CACHE / f'luna-{time.time_ns()}.mp4'
    # Wav2Lip takes the single still image and synthesised speech and generates
    # genuine AI lip movement synchronized to the speech audio.
    cmd = [
        str(WAV2LIP),
        '--checkpoint_path', str(ROOT / 'Wav2LipRunner' / 'checkpoints' / 'wav2lip.pth'),
        '--face', str(IMAGE),
        '--audio', str(wav_path),
        '--outfile', str(out),
        '--fps', '25',
        '--resize_factor', '2',
        '--pads', '0', '20', '0', '0',
        '--nosmooth',
        '--wav2lip_batch_size', '16',
    ]
    p = subprocess.run(cmd, cwd=str(ROOT / 'Wav2LipRunner'), capture_output=True, text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if p.returncode or not out.exists():
        raise RuntimeError((p.stderr or p.stdout or 'Wav2Lip inference failed')[-2500:])
    data = out.read_bytes()
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
        if p == '/health': return self.json(200, {'ok': True, 'app': 'Luna HTML App', 'video': IMAGE.exists(), 'wav2lip': WAV2LIP.exists()})
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
