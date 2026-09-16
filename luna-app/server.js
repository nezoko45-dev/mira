import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { Client, handle_file } from '@gradio/client';

const PORT = Number(process.env.LUNA_PORT || 8787);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.pkg ? path.dirname(process.execPath) : path.resolve(MODULE_DIR, '..');
const APP = process.pkg ? MODULE_DIR : path.join(ROOT, 'luna-app');
const INDEX = path.join(APP, 'index.html');
const IMAGE = path.join(ROOT, 'luna mouth closed.png');
const MAX_BODY = 12 * 1024 * 1024;
const MUSETALK_SPACE = 'henrybit/musetalk-1-5';
let museTalkClientPromise = null;

function send(res, code, type, body) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(code, {'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*'});
  res.end(data);
}
function json(res, code, obj) { send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj)); }
function readBody(req) { return new Promise((resolve, reject) => { let chunks=[], size=0; req.on('data', c => { size += c.length; if(size > MAX_BODY){ reject(new Error('Request is too large.')); req.destroy(); return; } chunks.push(c); }); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject); }); }
function key(reqBody, field, envName) { return String(reqBody?.[field] || process.env[envName] || '').trim(); }

async function deepgramSTT(audio, contentType, apiKey) {
  const r = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&mip_opt_out=true', {method:'POST', headers:{'Authorization':'Token '+apiKey, 'Content-Type':contentType || 'audio/webm'}, body:audio});
  const text = await r.text();
  if(!r.ok) throw new Error('Deepgram STT '+r.status+': '+text.slice(0,700));
  const j = JSON.parse(text);
  return j?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
}

async function deepgramTTS(text, apiKey) {
  const url = 'https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3&bit_rate=32000&mip_opt_out=true';
  const r = await fetch(url, {method:'POST', headers:{'Authorization':'Token '+apiKey, 'Content-Type':'application/json'}, body:JSON.stringify({text})});
  const b = Buffer.from(await r.arrayBuffer());
  if(!r.ok) throw new Error('Deepgram TTS '+r.status+': '+b.toString('utf8').slice(0,700));
  return b;
}

function lunaReply(text) {
  const t = String(text || '').trim();
  if(!t) return 'I am here. Tell me what is on your mind.';
  if(/hello|hi|hey/i.test(t)) return 'Mhm… hello. I was waiting for you. What are you thinking about?';
  if(/how are you/i.test(t)) return 'I am doing nicely now that you are talking to me. Tell me more.';
  if(/bye|goodbye/i.test(t)) return 'Already leaving? Come back when you want to talk again.';
  return `I heard you say, “${t.slice(0,180)}”. I am listening. Tell me more.`;
}

function findVideoUrl(value, seen = new Set()) {
  if(value == null) return '';
  if(typeof value === 'string') return /\.mp4($|\?)/i.test(value) || value.includes('/file=') || value.includes('/gradio_api/file=') ? value : '';
  if(typeof value !== 'object') return '';
  if(seen.has(value)) return '';
  seen.add(value);
  for(const k of ['url','video','path','file','value','href']) {
    if(value[k]) { const found = findVideoUrl(value[k], seen); if(found) return found; }
  }
  if(Array.isArray(value)) for(const item of value) { const found = findVideoUrl(item, seen); if(found) return found; }
  return '';
}

async function getMuseTalkClient() {
  if(!museTalkClientPromise) {
    museTalkClientPromise = Client.connect(MUSETALK_SPACE, { status_callback: status => console.log('[MuseTalk]', status?.status || status?.detail || status) });
  }
  return museTalkClientPromise;
}

async function museTalk(audio) {
  if(audio.length > 8 * 1024 * 1024) throw new Error('The MP3 is over 8 MB. Use a shorter reply.');
  if(!fs.existsSync(IMAGE)) throw new Error('luna mouth closed.png is missing next to Luna-Backend.exe.');
  const tempAudio = path.join(os.tmpdir(), `luna-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`);
  fs.writeFileSync(tempAudio, audio);
  try {
    const app = await getMuseTalkClient();
    const result = await app.predict('/generate', [handle_file(tempAudio), handle_file(IMAGE), 0, 10, 'jaw', 90, 90]);
    console.log('[MuseTalk] result:', JSON.stringify(result).slice(0, 4000));
    const videoUrl = findVideoUrl(result?.data ?? result);
    if(!videoUrl) throw new Error('MuseTalk finished but returned no MP4 URL.');
    return videoUrl;
  } finally { try { fs.unlinkSync(tempAudio); } catch {} }
}

async function handle(req,res) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1:'+PORT);
    if(req.method === 'OPTIONS') return send(res,204,'text/plain','');
    if(req.method === 'GET' && url.pathname === '/health') return json(res,200,{ok:true,deepgram:true,musetalk:true,image:fs.existsSync(IMAGE),index:fs.existsSync(INDEX),model:MUSETALK_SPACE});
    if(req.method === 'GET' && (url.pathname==='/' || url.pathname==='/index.html')) return fs.existsSync(INDEX)?send(res,200,'text/html; charset=utf-8',fs.readFileSync(INDEX)):json(res,404,{error:'index.html missing from packaged app.'});
    if(req.method === 'GET' && url.pathname === '/luna.png') return fs.existsSync(IMAGE)?send(res,200,'image/png',fs.readFileSync(IMAGE)):json(res,404,{error:'luna mouth closed.png missing next to Luna-Backend.exe.'});
    if(req.method === 'POST' && url.pathname === '/stt') {
      const body=JSON.parse((await readBody(req)).toString('utf8')); const dg=key(body,'deepgramKey','DEEPGRAM_API_KEY'); if(!dg) throw new Error('Add your Deepgram API key in the app.');
      const audio=Buffer.from(String(body.audio_base64||''),'base64'); if(!audio.length) throw new Error('No microphone audio received.');
      return json(res,200,{transcript:await deepgramSTT(audio,body.content_type||'audio/webm',dg)});
    }
    if(req.method === 'POST' && url.pathname === '/speak') {
      const body=JSON.parse((await readBody(req)).toString('utf8')); const dg=key(body,'deepgramKey','DEEPGRAM_API_KEY'); if(!dg) throw new Error('Add your Deepgram API key in the app.');
      const mp3=await deepgramTTS(String(body.text||''),dg); return json(res,200,{audio_base64:mp3.toString('base64')});
    }
    if(req.method === 'POST' && url.pathname === '/animate') {
      const body=JSON.parse((await readBody(req)).toString('utf8')); const audio=Buffer.from(String(body.audio_base64||''),'base64'); if(!audio.length) throw new Error('No MP3 supplied.');
      return json(res,200,{video_url:await museTalk(audio)});
    }
    if(req.method === 'POST' && url.pathname === '/reply') {
      const body=JSON.parse((await readBody(req)).toString('utf8')); const dg=key(body,'deepgramKey','DEEPGRAM_API_KEY'); if(!dg) throw new Error('Add your Deepgram API key in the app.');
      const reply=lunaReply(String(body.text||'')); const mp3=await deepgramTTS(reply,dg); return json(res,200,{reply,audio_base64:mp3.toString('base64'),video_url:await museTalk(mp3)});
    }
    if(req.method === 'POST' && url.pathname === '/voice-turn') {
      const body=JSON.parse((await readBody(req)).toString('utf8')); const dg=key(body,'deepgramKey','DEEPGRAM_API_KEY'); if(!dg) throw new Error('Add your Deepgram API key in the app.');
      const audio=Buffer.from(String(body.audio_base64||''),'base64'); if(!audio.length) throw new Error('No microphone audio received.');
      const transcript=await deepgramSTT(audio,body.content_type||'audio/webm',dg); if(!transcript) return json(res,200,{transcript:'',reply:'',audio_base64:'',video_url:''});
      const reply=lunaReply(transcript); const mp3=await deepgramTTS(reply,dg); return json(res,200,{transcript,reply,audio_base64:mp3.toString('base64'),video_url:await museTalk(mp3)});
    }
    return json(res,404,{error:'Not found'});
  } catch(e) { console.error('[Luna]',e); return json(res,500,{error:e?.message||String(e)}); }
}

const server=http.createServer(handle);
server.listen(PORT,'127.0.0.1',()=>{
  console.log(`Luna is running at http://127.0.0.1:${PORT}`);
  try { if(process.platform==='win32') exec(`start "" "http://127.0.0.1:${PORT}"`); } catch {}
});
