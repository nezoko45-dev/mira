import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const PREFERRED_PORT = Number(process.env.LUNA_PORT || 8787);
const WAV2LIP_API = process.env.WAV2LIP_API || 'http://127.0.0.1:9872';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.pkg ? path.dirname(process.execPath) : path.resolve(MODULE_DIR, '..');
const APP = process.pkg ? MODULE_DIR : path.join(ROOT, 'luna-app');
const INDEX = path.join(APP, 'index.html');
const IMAGE = path.join(ROOT, 'luna mouth closed.png');
const LOG = path.join(ROOT, 'Luna-Backend.log');
const MAX_BODY = 32 * 1024 * 1024;
let PORT = PREFERRED_PORT;

function log(...args){const line=`[${new Date().toISOString()}] ${args.map(x=>x instanceof Error?(x.stack||x.message):String(x)).join(' ')}\n`;try{fs.appendFileSync(LOG,line)}catch{}try{console.log(line.trim())}catch{}}
process.on('uncaughtException',e=>log('UNCAUGHT EXCEPTION',e));
process.on('unhandledRejection',e=>log('UNHANDLED REJECTION',e));
function send(res,code,type,body,extra={}){const data=Buffer.isBuffer(body)?body:Buffer.from(body);res.writeHead(code,{'Content-Type':type,'Content-Length':data.length,'Cache-Control':'no-store','Access-Control-Allow-Origin':'*',...extra});res.end(data)}
function json(res,code,obj){return send(res,code,'application/json; charset=utf-8',JSON.stringify(obj))}
function readBody(req){return new Promise((resolve,reject)=>{const chunks=[];let size=0;req.on('data',c=>{size+=c.length;if(size>MAX_BODY){reject(new Error('Request is too large.'));req.destroy();return}chunks.push(c)});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject)})}
function key(body,field,env){return String(body?.[field]||process.env[env]||'').trim()}
async function deepgramTTS(text,apiKey){const r=await fetch('https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3&bit_rate=32000',{method:'POST',headers:{Authorization:`Token ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({text})});const b=Buffer.from(await r.arrayBuffer());if(!r.ok)throw new Error(`Deepgram TTS ${r.status}: ${b.toString('utf8').slice(0,1000)}`);return b}
async function deepgramSTT(audio,contentType,apiKey){const ct=String(contentType||'audio/webm').split(';')[0].toLowerCase();const safe=['audio/webm','audio/ogg','audio/wav','audio/wave','audio/x-wav','audio/mpeg','audio/mp4','audio/aac','audio/flac'].includes(ct)?ct:'audio/webm';const r=await fetch(`https://api.deepgram.com/v1/listen?model=nova-3&language=en-US&smart_format=true&punctuate=true`,{method:'POST',headers:{Authorization:`Token ${apiKey}`,'Content-Type':safe},body:audio});const text=await r.text();if(!r.ok)throw new Error(`Deepgram STT ${r.status}: ${text.slice(0,1000)}`);const data=JSON.parse(text);return data?.results?.channels?.[0]?.alternatives?.[0]?.transcript||''}
function lunaReply(text){const t=String(text||'').trim();if(!t)return'I am here. Tell me what is on your mind.';if(/hello|hi|hey/i.test(t))return'Mhm… hello. I was waiting for you. What are you thinking about?';if(/how are you/i.test(t))return'I am doing nicely now that you are talking to me. Tell me more.';if(/bye|goodbye/i.test(t))return'Already leaving? Come back when you want to talk again.';return`I heard you say, “${t.slice(0,180)}”. I am listening. Tell me more.`}

async function wav2lipMP4(audioBuffer){
  if(!fs.existsSync(IMAGE))throw new Error('luna mouth closed.png is missing beside Luna-Backend.exe.');
  const fd=new FormData();
  fd.append('face',new Blob([fs.readFileSync(IMAGE)],{type:'image/png'}),'luna mouth closed.png');
  fd.append('audio',new Blob([audioBuffer],{type:'audio/mpeg'}),'luna.mp3');
  const r=await fetch(`${WAV2LIP_API}/lipsync`,{method:'POST',body:fd,signal:AbortSignal.timeout(180000)});
  const contentType=String(r.headers.get('content-type')||'').toLowerCase();
  const data=Buffer.from(await r.arrayBuffer());
  if(!r.ok)throw new Error(`Wav2Lip ${r.status}: ${data.toString('utf8').slice(0,1200)}`);
  if(contentType.includes('video/mp4')||contentType.includes('application/octet-stream'))return data;
  let j;try{j=JSON.parse(data.toString('utf8'))}catch{throw new Error('Wav2Lip returned neither an MP4 nor JSON containing one.');}
  if(j.video_base64)return Buffer.from(j.video_base64,'base64');
  if(j.video_url){const vr=await fetch(new URL(j.video_url,WAV2LIP_API).toString(),{signal:AbortSignal.timeout(180000)});if(!vr.ok)throw new Error(`Wav2Lip video download ${vr.status}.`);return Buffer.from(await vr.arrayBuffer())}
  throw new Error('Wav2Lip returned no video. Expected video_base64 or video_url.');
}
async function wav2lipOnline(){try{const r=await fetch(`${WAV2LIP_API}/health`,{signal:AbortSignal.timeout(1500)});return r.ok}catch{return false}}
async function makeReply(body){const dg=key(body,'deepgramKey','DEEPGRAM_API_KEY');if(!dg)throw new Error('Enter and save your Deepgram API key first.');const reply=lunaReply(body.text);const mp3=await deepgramTTS(reply,dg);const video=await wav2lipMP4(mp3);return{reply,audio_base64:mp3.toString('base64'),video_base64:video.toString('base64')}}

async function handle(req,res){try{const url=new URL(req.url,`http://127.0.0.1:${PORT}`);if(req.method==='OPTIONS')return send(res,204,'text/plain','');if(req.method==='GET'&&url.pathname==='/health')return json(res,200,{ok:true,server:'Luna Backend',port:PORT,deepgram:true,wav2lip:await wav2lipOnline(),wav2lipUrl:WAV2LIP_API,image:fs.existsSync(IMAGE),index:fs.existsSync(INDEX),mp4Player:true,log:LOG});if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/index.html'))return fs.existsSync(INDEX)?send(res,200,'text/html; charset=utf-8',fs.readFileSync(INDEX)):json(res,404,{error:'index.html missing.'});if(req.method==='GET'&&url.pathname==='/luna.png')return fs.existsSync(IMAGE)?send(res,200,'image/png',fs.readFileSync(IMAGE)):json(res,404,{error:'luna mouth closed.png missing.'});if(req.method==='POST'&&url.pathname==='/stt'){const body=JSON.parse((await readBody(req)).toString('utf8'));const dg=key(body,'deepgramKey','DEEPGRAM_API_KEY');if(!dg)throw new Error('Enter and save your Deepgram API key first.');const audio=Buffer.from(String(body.audio_base64||''),'base64');if(!audio.length)throw new Error('No microphone audio received.');return json(res,200,{transcript:await deepgramSTT(audio,body.content_type,dg)})}if(req.method==='POST'&&url.pathname==='/reply')return json(res,200,await makeReply(JSON.parse((await readBody(req)).toString('utf8'))));if(req.method==='POST'&&url.pathname==='/voice-turn'){const body=JSON.parse((await readBody(req)).toString('utf8'));const dg=key(body,'deepgramKey','DEEPGRAM_API_KEY');if(!dg)throw new Error('Enter and save your Deepgram API key first.');const audio=Buffer.from(String(body.audio_base64||''),'base64');if(!audio.length)throw new Error('No microphone audio received.');const transcript=await deepgramSTT(audio,body.content_type,dg);if(!transcript.trim())return json(res,200,{transcript:'',reply:'',audio_base64:'',video_base64:''});return json(res,200,{transcript,...await makeReply({...body,text:transcript})})}return json(res,404,{error:'Not found'})}catch(e){log('REQUEST ERROR',e);return json(res,500,{error:e?.message||String(e)})}}
function startServer(port){PORT=port;const server=http.createServer(handle);server.on('error',err=>{if(err.code==='EADDRINUSE'&&port<PREFERRED_PORT+10){log(`Port ${port} is already in use; trying ${port+1}.`);try{server.close()}catch{}setTimeout(()=>startServer(port+1),100);return}log('SERVER ERROR',err)});server.listen(port,'127.0.0.1',()=>{const url=`http://127.0.0.1:${PORT}`;log(`Luna is running at ${url}`);log(`Wav2Lip API expected at ${WAV2LIP_API}`);log(`Log file: ${LOG}`);try{if(process.platform==='win32')exec(`start "" "${url}"`)}catch(e){log('Browser launch error',e)}})}
log('Starting Luna Backend');startServer(PREFERRED_PORT);
