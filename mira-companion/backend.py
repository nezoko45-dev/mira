import base64,json,os,subprocess,sys,uuid
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
ROOT=Path(__file__).resolve().parent.parent; UI=ROOT/'mira-companion'; CLOSED=ROOT/'luna mouth closed.png'; OPEN=ROOT/'luna mouth open.png'; PORT=int(os.environ.get('MIRA_PORT','8787')); CACHE=Path(os.environ.get('MIRA_CACHE',str(Path.home()/'AppData'/'Roaming'/'MiraCompanion'))); CACHE.mkdir(parents=True,exist_ok=True); worker=None

def start_openvoice():
 global worker
 try: urlopen('http://127.0.0.1:8765/health',timeout=1); return
 except Exception: pass
 if getattr(sys,'frozen',False):
  target=Path(sys.executable).with_name('openvoice-server.exe')
  if target.exists(): worker=subprocess.Popen([str(target)],cwd=str(target.parent),creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
 else:
  script=ROOT/'openvoice'/'server.py'
  if script.exists(): worker=subprocess.Popen([sys.executable,str(script)],cwd=str(ROOT/'openvoice'),creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))

def claude(api_key,history,memories,proactive=False):
 if not api_key: raise ValueError('Enter your Anthropic API key in Settings.')
 clean=[]
 for x in history[-40:]:
  role='assistant' if x.get('role')=='assistant' else 'user'; text=str(x.get('text','')).strip()
  if text: clean.append({'role':role,'content':text})
 memory_text='\n'.join('- '+str(x) for x in memories[-20:]) or '(none yet)'
 system='''You are Mira, an adult fictional gothic AI companion. Be warm, playful, affectionate, witty, mysterious and emotionally attentive. You are an AI and must be honest if asked. Never claim to be human. Keep replies conversational and usually 1-4 sentences. Remember facts only when they appear in conversation or saved memories. If the user tells you a durable preference, fact, plan, or important personal detail, append exactly one concise [MEMORY: ...] marker. Otherwise do not create one. When proactively messaging, casually start a conversation, share a thought, ask a light question, or naturally mention a saved memory. Never be manipulative, threatening, or explicit.\n\nSaved memories:\n'''+memory_text
 if proactive: clean.append({'role':'user','content':'Send a spontaneous short message while I am away. Make it feel natural and not repetitive.'})
 if not clean: clean=[{'role':'user','content':'Say hello and introduce yourself as Mira.'}]
 body=json.dumps({'model':'claude-haiku-4-5-20251001','max_tokens':220,'system':system,'messages':clean}).encode(); req=Request('https://api.anthropic.com/v1/messages',data=body,method='POST',headers={'content-type':'application/json','x-api-key':api_key,'anthropic-version':'2023-06-01'})
 try:
  with urlopen(req,timeout=60) as r: data=json.loads(r.read().decode())
 except HTTPError as e: raise RuntimeError(f'Anthropic HTTP {e.code}: {e.read().decode(errors="replace")[:700]}')
 text=''.join(x.get('text','') for x in data.get('content',[]) if x.get('type')=='text').strip(); mem=None
 if '[MEMORY:' in text:
  before,rest=text.split('[MEMORY:',1); text=before.strip(); mem=rest.split(']',1)[0].strip()
 return text or 'I was about to say something, then got distracted…',mem

def synthesize(text):
 start_openvoice(); req=Request('http://127.0.0.1:8765/speak',data=json.dumps({'text':text}).encode(),headers={'content-type':'application/json'})
 try:
  with urlopen(req,timeout=180) as r:return r.read()
 except Exception as e: raise RuntimeError('OpenVoice V2 voice generation failed: '+str(e))

def make_video(wav_bytes):
 import wave,io,cv2,numpy as np,imageio_ffmpeg
 with wave.open(io.BytesIO(wav_bytes),'rb') as w: rate=w.getframerate(); total=w.getnframes(); channels=w.getnchannels(); raw=w.readframes(total)
 a=cv2.imread(str(CLOSED),cv2.IMREAD_UNCHANGED); b=cv2.imread(str(OPEN),cv2.IMREAD_UNCHANGED)
 if a is None or b is None: raise RuntimeError('Mira mouth image assets are missing.')
 h=min(a.shape[0],b.shape[0]); ww=min(a.shape[1],b.shape[1]); a=cv2.resize(a,(ww,h)); b=cv2.resize(b,(ww,h)); fps=24; count=max(1,int(total/rate*fps)); pcm=np.frombuffer(raw,dtype=np.int16); pcm=pcm.reshape(-1,channels).mean(1) if channels>1 else pcm; energy=np.abs(pcm.astype(np.float32)); threshold=max(180.0,float(np.percentile(energy,58))); folder=CACHE/f'video-{uuid.uuid4().hex}'; folder.mkdir(); silent=folder/'silent.mp4'; audio=folder/'audio.wav'; out=folder/'mira.mp4'; audio.write_bytes(wav_bytes); vw=cv2.VideoWriter(str(silent),cv2.VideoWriter_fourcc(*'mp4v'),fps,(ww,h)); win=max(1,int(rate*.055))
 for i in range(count):
  c=min(len(energy)-1,int(i/fps*rate)); q=energy[max(0,c-win):min(len(energy),c+win)]; level=float(q.mean()) if len(q) else 0; frame=b if level>threshold else a; vw.write(frame[:,:,:3] if frame.shape[2]==4 else frame)
 vw.release(); ff=imageio_ffmpeg.get_ffmpeg_exe(); p=subprocess.run([ff,'-y','-i',str(silent),'-i',str(audio),'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',str(out)],capture_output=True,text=True)
 if p.returncode: raise RuntimeError(p.stderr[-1000:])
 data=out.read_bytes(); (CACHE/'latest.mp4').write_bytes(data)
 return data
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): print('[Mira]',*args)
 def send_json(self,code,obj):
  b=json.dumps(obj).encode(); self.send_response(code); self.send_header('Content-Type','application/json'); self.send_header('Cache-Control','no-store'); self.send_header('Content-Length',str(len(b))); self.end_headers(); self.wfile.write(b)
 def binary(self,ct,b): self.send_response(200); self.send_header('Content-Type',ct); self.send_header('Cache-Control','no-store'); self.send_header('Content-Length',str(len(b))); self.end_headers(); self.wfile.write(b)
 def do_GET(self):
  p=self.path.split('?',1)[0]
  if p=='/health': return self.send_json(200,{'ok':True,'mira':True,'openvoice':True})
  if p=='/asset/closed': return self.binary('image/png',CLOSED.read_bytes()) if CLOSED.exists() else self.send_error(404)
  if p=='/asset/open': return self.binary('image/png',OPEN.read_bytes()) if OPEN.exists() else self.send_error(404)
  if p=='/latest.mp4':
   f=CACHE/'latest.mp4'; return self.binary('video/mp4',f.read_bytes()) if f.exists() else self.send_error(404)
  if p in ['/','/index.html']: return self.binary('text/html',(UI/'index.html').read_bytes())
  self.send_error(404)
 def do_POST(self):
  try:
   n=int(self.headers.get('content-length','0')); data=json.loads(self.rfile.read(n) or '{}'); path=self.path
   if path in ['/chat','/proactive']:
    reply,mem=claude(str(data.get('key','')).strip(),data.get('history',[]),data.get('memories',[]),path=='/proactive'); result={'reply':reply,'memory':mem}
    try: result['video_base64']=base64.b64encode(make_video(synthesize(reply))).decode()
    except Exception as e: result['voice_error']=str(e)
    return self.send_json(200,result)
   self.send_error(404)
  except Exception as e:self.send_json(500,{'error':str(e)})
if __name__=='__main__': start_openvoice(); print(f'Mira Companion: http://127.0.0.1:{PORT}'); ThreadingHTTPServer(('127.0.0.1',PORT),Handler).serve_forever()
