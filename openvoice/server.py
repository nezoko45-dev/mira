import json, os, sys, tempfile, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parent))
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
        raise RuntimeError('No voice_reference.wav found. Put a short clean female voice sample at %APPDATA%\\LunaGothicCompanion\\voice_reference.wav.')
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


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        return
    def do_OPTIONS(self):
        self.send_response(204); self.send_header('Access-Control-Allow-Origin','*'); self.send_header('Access-Control-Allow-Headers','content-type'); self.end_headers()
    def do_GET(self):
        if self.path == '/health':
            self.send_response(200); self.send_header('Access-Control-Allow-Origin','*'); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(json.dumps({'ok': True, 'model': 'OpenVoice V2'}).encode()); return
        self.send_error(404)
    def do_POST(self):
        if self.path != '/speak': self.send_error(404); return
        try:
            n = int(self.headers.get('content-length','0'))
            data = json.loads(self.rfile.read(n) or '{}')
            text = str(data.get('text','')).strip()
            if not text: raise ValueError('text is required')
            wav = synthesize(text[:2000])
            payload = wav.read_bytes()
            self.send_response(200); self.send_header('Access-Control-Allow-Origin','*'); self.send_header('Content-Type','audio/wav'); self.send_header('Content-Length',str(len(payload))); self.end_headers(); self.wfile.write(payload)
        except Exception as e:
            traceback.print_exc()
            body = json.dumps({'error': str(e)}).encode()
            self.send_response(500); self.send_header('Access-Control-Allow-Origin','*'); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(body)


if __name__ == '__main__':
    print('Luna OpenVoice V2 backend listening on http://127.0.0.1:8765')
    ThreadingHTTPServer(('127.0.0.1', 8765), Handler).serve_forever()
