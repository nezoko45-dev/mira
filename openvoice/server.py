import json, os, sys, tempfile, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

if getattr(sys, 'frozen', False):
    BUNDLE_ROOT = Path(sys.executable).resolve().parent
    ROOT = BUNDLE_ROOT.parent if not (BUNDLE_ROOT / 'checkpoints_v2').exists() and (BUNDLE_ROOT.parent / 'checkpoints_v2').exists() else BUNDLE_ROOT
else:
    ROOT = Path(__file__).resolve().parent.parent
MODEL_ROOT = ROOT / 'checkpoints_v2'
VOICE_REF = Path(os.environ.get('LUNA_VOICE_REFERENCE', str(Path.home() / 'AppData' / 'Roaming' / 'LunaGothicCompanion' / 'voice_reference.wav')))
OUT_DIR = Path(tempfile.gettempdir()) / 'luna-openvoice'
OUT_DIR.mkdir(parents=True, exist_ok=True)

_converter = None
_melo = None
_target_se = None
_device = None


def load_models():
    global _converter, _melo, _target_se, _device
    if _converter is not None:
        return
    import torch
    from openvoice.api import ToneColorConverter
    from openvoice import se_extractor
    from melo.api import TTS
    _device = 'cuda:0' if torch.cuda.is_available() else 'cpu'
    converter_dir = MODEL_ROOT / 'converter'
    if not (converter_dir / 'config.json').exists() or not (converter_dir / 'checkpoint.pth').exists():
        raise RuntimeError('OpenVoice V2 converter checkpoint is missing.')
    _converter = ToneColorConverter(str(converter_dir / 'config.json'), device=_device)
    _converter.load_ckpt(str(converter_dir / 'checkpoint.pth'))
    if not VOICE_REF.exists():
        raise RuntimeError('No voice_reference.wav found. Put a short clean voice sample at %APPDATA%\\LunaGothicCompanion\\voice_reference.wav.')
    _target_se, _ = se_extractor.get_se(str(VOICE_REF), _converter, vad=True)
    _melo = TTS(language='EN', device=_device)


def synthesize(text):
    load_models()
    import torch
    src = OUT_DIR / 'base.wav'
    out = OUT_DIR / 'luna.wav'
    speaker_id = list(_melo.hps.data.spk2id.values())[0]
    _melo.tts_to_file(text, speaker_id, str(src), speed=1.0)
    source_key = str(list(_melo.hps.data.spk2id.keys())[0]).lower().replace('_', '-')
    source_se_path = MODEL_ROOT / 'base_speakers' / 'ses' / f'{source_key}.pth'
    if not source_se_path.exists():
        candidates = list((MODEL_ROOT / 'base_speakers' / 'ses').glob('*.pth'))
        if not candidates:
            raise RuntimeError('OpenVoice V2 speaker embedding is missing.')
        source_se_path = candidates[0]
    source_se = torch.load(str(source_se_path), map_location=_device)
    _converter.convert(audio_src_path=str(src), src_se=source_se, tgt_se=_target_se, output_path=str(out), message='@MyShell')
    return out


def claude_reply(api_key, history):
    if not api_key:
        raise ValueError('Anthropic API key is required.')
    messages = []
    for item in history[-40:]:
        role = 'assistant' if item.get('role') == 'assistant' else 'user'
        content = str(item.get('content', '')).strip()
        if content:
            messages.append({'role': role, 'content': content})
    if not messages:
        raise ValueError('Conversation is empty.')
    body = json.dumps({
        'model': 'claude-haiku-4-5-20251001',
        'max_tokens': 180,
        'system': 'You are Luna, an adult fictional gothic vampire-inspired AI companion. She has long brown hair, brown eyes and long fangs. Be warm, teasing, affectionate, mysterious and playful. You are an AI and must be honest if asked. Never claim to be human. Keep replies natural, usually 1-4 sentences. Remember facts only when they appear in the conversation. Avoid manipulative, threatening or explicit content.',
        'messages': messages
    }).encode()
    req = Request('https://api.anthropic.com/v1/messages', data=body, method='POST', headers={
        'content-type': 'application/json', 'x-api-key': api_key, 'anthropic-version': '2023-06-01'
    })
    try:
        with urlopen(req, timeout=60) as response:
            data = json.loads(response.read().decode('utf-8'))
    except HTTPError as e:
        detail = e.read().decode('utf-8', errors='replace')
        raise RuntimeError(f'Anthropic HTTP {e.code}: {detail[:500]}')
    text = ''.join(x.get('text', '') for x in data.get('content', []) if x.get('type') == 'text').strip()
    return text or 'I lost my words for a moment…'


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        return

    def send_bytes(self, code, content_type, payload):
        self.send_response(code)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'content-type')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        self.send_bytes(204, 'text/plain', b'')

    def do_GET(self):
        if self.path == '/health':
            self.send_bytes(200, 'application/json', json.dumps({'ok': True, 'model': 'OpenVoice V2', 'claude_proxy': True}).encode())
            return
        pathname = self.path.split('?', 1)[0]
        if pathname == '/':
            pathname = '/Luna.html'
        name = pathname.lstrip('/')
        allowed = {'Luna.html': 'text/html; charset=utf-8', 'luna mouth open.png': 'image/png', 'luna mouth closed.png': 'image/png'}
        if name in allowed:
            candidate = ROOT / name
            if candidate.exists() and candidate.is_file():
                self.send_bytes(200, allowed[name], candidate.read_bytes())
                return
        self.send_error(404)

    def do_POST(self):
        try:
            n = int(self.headers.get('content-length', '0'))
            data = json.loads(self.rfile.read(n) or '{}')
            if self.path == '/chat':
                reply = claude_reply(str(data.get('apiKey', '')).strip(), data.get('history', []))
                self.send_bytes(200, 'application/json', json.dumps({'reply': reply}).encode())
                return
            if self.path == '/speak':
                text = str(data.get('text', '')).strip()
                if not text:
                    raise ValueError('text is required')
                wav = synthesize(text[:2000])
                self.send_bytes(200, 'audio/wav', wav.read_bytes())
                return
            self.send_error(404)
        except Exception as e:
            traceback.print_exc()
            self.send_bytes(500, 'application/json', json.dumps({'error': str(e)}).encode())


if __name__ == '__main__':
    print('Luna backend listening on http://127.0.0.1:8765')
    ThreadingHTTPServer(('127.0.0.1', 8765), Handler).serve_forever()
