import base64, json, os, subprocess, sys, tempfile, threading, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / 'mira-companion'
CLOSED = ROOT / 'luna mouth closed.png'
OPEN = ROOT / 'luna mouth open.png'
PORT = int(os.environ.get('MIRA_PORT', '8787'))
CACHE = Path(os.environ.get('MIRA_CACHE', str(Path.home() / 'AppData' / 'Roaming' / 'MiraCompanion')))
CACHE.mkdir(parents=True, exist_ok=True)

# Prefer the existing OpenVoice server module in the repo.
OPENVOICE = ROOT / 'openvoice' / 'server.py'


def claude(api_key, history, memories, proactive=False):
    if not api_key:
        raise ValueError('Enter your Anthropic API key in Settings.')
    clean=[]
    for x in history[-40:]:
        role='assistant' if x.get('role')=='assistant' else 'user'
        text=str(x.get('text','')).strip()
        if text: clean.append({'role':role,'content':text})
    memory_text='\n'.join('- '+str(x) for x in memories[-20:]) or '(none yet)'
    system='''You are Mira, an adult fictional gothic AI companion. You are warm, playful, affectionate, witty, mysterious and emotionally attentive. You are an AI and must be honest if asked. Never claim to be human. Keep normal replies conversational and usually 1-4 sentences. You can mention prior conversation naturally, but never invent a memory. If the user tells you a durable preference, fact, plan, or important personal detail, return a concise MEMORY line after your reply in the exact format [MEMORY: ...]. Otherwise do not create one. For proactive messages, casually start a conversation, comment on something, ask a light question, or bring up a real saved memory. Do not be manipulative, threatening, or explicit.\n\nSaved memories:\n'''+memory_text
    if proactive:
        clean.append({'role':'user','content':'Start a spontaneous message to me while I am away. Keep it natural and short; use a saved memory only if it genuinely fits.'})
    if not clean: clean=[{'role':'user','content':'Say hello and introduce yourself.'}]
    body=json.dumps({'model':'claude-haiku-4-5-20251001','max_tokens':220,'system':system,'messages':clean}).encode()
    req=Request('https://api.anthropic.com/v1/messages',data=body,method='POST',headers={'content-type':'application/json','x-api-key':api_key,'anthropic-version':'2023-06-01'})
    try:
        with urlopen(req,timeout=60) as r: data=json.loads(r.read().decode())
    except HTTPError as e:
        detail=e.read().decode(errors='replace'); raise RuntimeError(f'Anthropic HTTP {e.code}: {detail[:700]}')
    text=''.join(x.get('text','') for x in data.get('content',[]) if x.get('type')=='text').strip()
    mem=None
    if '[MEMORY:' in text:
        before, rest=text.split('[MEMORY:',1); text=before.strip(); mem=rest.split(']',1)[0].strip()
    return text or 'I was about to say something, then got distracted…', mem


def synthesize(text, voice_ref):
    # Run the repo's existing OpenVoice V2 server as a local worker for synthesis.
    # It exposes /speak and uses the existing voice reference/checkpoints.
    import urllib.request
    try:
        req=urllib.request.Request('http://127.0.0.1:8765/speak',data=json.dumps({'text':text}).encode(),headers={'content-type':'application/json'})
        with urllib.request.urlopen(req,timeout=180) as r: return r.read()
    except Exception:
        raise RuntimeError('OpenVoice V2 is not running. Start the bundled OpenVoice engine first.')


def wav_duration_and_rms(wav_bytes):
    import wave, io, audioop
    with wave.open(io.BytesIO(wav_bytes),'rb') as w:
        rate=w.getframerate(); frames=w.getnframes(); width=w.getsampwidth(); channels=w.getnchannels(); raw=w.readframes(frames)
    step=max(1,int(rate/12))
    rms=[]
    for i in range(0,len(raw),max(1,step*width*channels)):
        chunk=raw[i:i+max(1,step*width*channels)]
        try: rms.append(audioop.rms(chunk,width))
        except Exception: rms.append(0)
    return frames/rate, rms, rate, frames


def make_video(wav_bytes):
    import wave, io, audioop
    import cv2, numpy as np
    with wave.open(io.BytesIO(wav_bytes),'rb') as w:
        rate=w.getframerate(); frames=w.getnframes(); width=w.getsampwidth(); channels=w.getnchannels(); raw=w.readframes(frames)
    image_closed=cv2.imread(str(CLOSED),cv2.IMREAD_UNCHANGED); image_open=cv2.imread(str(OPEN),cv2.IMREAD_UNCHANGED)
    if image_closed is None or image_open is None: raise RuntimeError('Mira mouth image assets are missing.')
    h=min(image_closed.shape[0],image_open.shape[0]); w=min(image_closed.shape[1],image_open.shape[1]); image_closed=cv2.resize(image_closed,(w,h)); image_open=cv2.resize(image_open,(w,h))
    fps=24; frames_total=max(1,int(frames/rate*fps)); pcm=np.frombuffer(raw,dtype=np.int16); pcm=pcm.reshape(-1,channels).mean(axis=1) if channels>1 else pcm
    # Generate a real MP4 animation: mouth state follows short-window audio energy.
    temp=CACHE/f'mira-{uuid.uuid4().hex}'; temp.mkdir(parents=True,exist_ok=True); silent=temp/'silent.mp4'; out=temp/'mira.mp4'; wav=temp/'audio.wav'; wav.write_bytes(wav_bytes)
    fourcc=cv2.VideoWriter_fourcc(*'mp4v'); vw=cv2.VideoWriter(str(silent),fourcc,fps,(w,h))
    win=max(1,int(rate*0.055)); energy=np.abs(pcm.astype(np.float32)); threshold=max(180.0,float(np.percentile(energy,58)))
    for i in range(frames_total):
        center=min(len(energy)-1,int((i/fps)*rate)); a=energy[max(0,center-win):min(len(energy),center+win)]; level=float(a.mean()) if len(a) else 0
        # Hysteresis-like threshold makes the two-frame animation less jittery.
        frame=image_open if level>threshold else image_closed
        vw.write(frame[:,:,:3] if frame.shape[2]==4 else frame)
    vw.release()
    ffmpeg=None
    try:
        import imageio_ffmpeg
        ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
    except Exception: pass
    if not ffmpeg: raise RuntimeError('Bundled FFmpeg is unavailable.')
    p=subprocess.run([ffmpeg,'-y','-i',str(silent),'-i',str(wav),'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',str(out)],capture_output=True,text=True)
    if p.returncode!=0: raise RuntimeError(p.stderr[-1200:])
    data=out.read_bytes()
    try:
        for x in temp.iterdir(): x.unlink(missing_ok=True)
        temp.rmdir()
    except Exception: pass
    return data


class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): print('[Mira]',*args)
    def send_json(self,code,obj):
        b=json.dumps(obj).encode(); self.send_response(code); self.send_header('Content-Type','application/json'); self.send_header('Access-Control-Allow-Origin','*'); self.send_header('Access-Control-Allow-Headers','content-type'); self.send_header('Access-Control-Allow-Methods','GET,POST,OPTIONS'); self.send_header('Content-Length',str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_OPTIONS(self): self.send_response(204); self.send_header('Access-Control-Allow-Origin','*'); self.end_headers()
    def do_GET(self):
        p=self.path.split('?',1)[0]
        if p=='/health': return self.send_json(200,{'ok':True,'mira':True,'openvoice':OPENVOICE.exists()})
        if p=='/': p='/index.html'
        if p=='/index.html':
            b=(UI/'index.html').read_bytes(); self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers(); self.wfile.write(b); return
        if p in ['/mira.mp4']:
            f=CACHE/'latest.mp4'
            if f.exists(): self.send_response(200); self.send_header('Content-Type','video/mp4'); self.end_headers(); self.wfile.write(f.read_bytes()); return
        self.send_error(404)
    def do_POST(self):
        try:
            n=int(self.headers.get('content-length','0')); data=json.loads(self.rfile.read(n) or '{}')
            if self.path=='/chat':
                reply,mem=claude(str(data.get('key','')).strip(),data.get('history',[]),data.get('memories',[]),False)
                result={'reply':reply,'memory':mem}
                try:
                    wav=synthesize(reply,None); video=make_video(wav); (CACHE/'latest.mp4').write_bytes(video); result['video_base64']=base64.b64encode(video).decode()
                except Exception as e: result['voice_error']=str(e)
                return self.send_json(200,result)
            if self.path=='/proactive':
                reply,mem=claude(str(data.get('key','')).strip(),data.get('history',[]),data.get('memories',[]),True)
                result={'reply':reply,'memory':mem}
                try:
                    wav=synthesize(reply,None); video=make_video(wav); (CACHE/'latest.mp4').write_bytes(video); result['video_base64']=base64.b64encode(video).decode()
                except Exception as e: result['voice_error']=str(e)
                return self.send_json(200,result)
            self.send_error(404)
        except Exception as e: self.send_json(500,{'error':str(e)})


def main():
    print(f'Mira Companion backend: http://127.0.0.1:{PORT}')
    ThreadingHTTPServer(('127.0.0.1',PORT),Handler).serve_forever()
if __name__=='__main__': main()
