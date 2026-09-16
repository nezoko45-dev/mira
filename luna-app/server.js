import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { unzipSync } from 'fflate';

const PREFERRED_PORT = Number(process.env.LUNA_PORT || 8787);
const FLP_API = process.env.FASTER_LIVEPORTRAIT_API || 'http://127.0.0.1:9871';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.pkg ? path.dirname(process.execPath) : path.resolve(MODULE_DIR, '..');
const APP = process.pkg ? MODULE_DIR : path.join(ROOT, 'luna-app');
const INDEX = path.join(APP, 'index.html');
const IMAGE = path.join(ROOT, 'luna mouth closed.png');
const LOG = path.join(ROOT, 'Luna-Backend.log');
const MAX_BODY = 32 * 1024 * 1024;
let PORT = PREFERRED_PORT;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(x => x instanceof Error ? (x.stack || x.message) : String(x)).join(' ')}\n`;
  try { fs.appendFileSync(LOG, line); } catch {}
  try { console.log(line.trim()); } catch {}
}
process.on('uncaughtException', err => log('UNCAUGHT EXCEPTION', err));
process.on('unhandledRejection', err => log('UNHANDLED REJECTION', err));

function send(res, code, type, body, extra = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(code, {'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...extra});
  res.end(data);
}
function json(res, code, obj) { return send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('Request is too large.')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function key(body, field, env) { return String(body?.[field] || process.env[env] || '').trim(); }

async function deepgramSTT(audio, contentType, apiKey) {
  const ct = String(contentType || 'audio/webm').split(';')[0].toLowerCase();
  const safe = ['audio/webm','audio/ogg','audio/wav','audio/wave','audio/x-wav','audio/mpeg','audio/mp4','audio/aac','audio/flac'].includes(ct) ? ct : 'audio/webm';
  const r = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&language=en-US&smart_format=true&punctuate=true', { method:'POST', headers:{Authorization:`Token ${apiKey}`, 'Content-Type':safe}, body:audio });
  const text = await r.text();
  if (!r.ok) throw new Error(`Deepgram STT ${r.status}: ${text.slice(0,1000)}`);
  const data = JSON.parse(text);
  return data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
}
async function deepgramTTS(text, apiKey) {
  const r = await fetch('https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3&bit_rate=32000', { method:'POST', headers:{Authorization:`Token ${apiKey}`, 'Content-Type':'application/json'}, body:JSON.stringify({text}) });
  const b = Buffer.from(await r.arrayBuffer());
  if (!r.ok) throw new Error(`Deepgram TTS ${r.status}: ${b.toString('utf8').slice(0,1000)}`);
  return b;
}
function lunaReply(text) {
  const t = String(text || '').trim();
  if (!t) return 'I am here. Tell me what is on your mind.';
  if (/hello|hi|hey/i.test(t)) return 'Mhm… hello. I was waiting for you. What are you thinking about?';
  if (/how are you/i.test(t)) return 'I am doing nicely now that you are talking to me. Tell me more.';
  if (/bye|goodbye/i.test(t)) return 'Already leaving? Come back when you want to talk again.';
  return `I heard you say, “${t.slice(0,180)}”. I am listening. Tell me more.`;
}

function zipVideo(zipBuffer) {
  const files = unzipSync(new Uint8Array(zipBuffer));
  for (const [name, data] of Object.entries(files)) {
    if (/\.(mp4|webm|mov)$/i.test(name)) return Buffer.from(data);
  }
  throw new Error('FasterLivePortrait returned no video in its ZIP response.');
}

async function animateWithFasterLivePortrait(audioBuffer) {
  if (!fs.existsSync(IMAGE)) throw new Error('luna mouth closed.png is missing beside Luna-Backend.exe.');
  const fd = new FormData();
  fd.append('source_image', new Blob([fs.readFileSync(IMAGE)], {type:'image/png'}), 'luna mouth closed.png');
  fd.append('driving_audio', new Blob([audioBuffer], {type:'audio/mpeg'}), 'luna.mp3');
  const fields = {
    flag_is_animal:'false', flag_pickle:'false', flag_relative_input:'true', flag_do_crop_input:'true', flag_remap_input:'true',
    driving_multiplier:'1.0', flag_stitching:'true', flag_crop_driving_video_input:'true', flag_video_editing_head_rotation:'false',
    scale:'2.3', vx_ratio:'0.0', vy_ratio:'-0.125', scale_crop_driving_video:'2.2', vx_ratio_crop_driving_video:'0.0', vy_ratio_crop_driving_video:'-0.1',
    driving_smooth_observation_variance:'1e-7'
  };
  for (const [k,v] of Object.entries(fields)) fd.append(k,v);
  const r = await fetch(`${FLP_API}/predict/`, {method:'POST', body:fd});
  const b = Buffer.from(await r.arrayBuffer());
  if (!r.ok) throw new Error(`FasterLivePortrait API ${r.status}: ${b.toString('utf8').slice(0,800)}`);
  return zipVideo(b);
}
async function flpOnline() { try { const r = await fetch(`${FLP_API}/docs`, {signal:AbortSignal.timeout(1500)}); return r.ok; } catch { return false; } }
async function makeReply(body) {
  const dg = key(body,'deepgramKey','DEEPGRAM_API_KEY');
  if (!dg) throw new Error('Enter and save your Deepgram API key first.');
  const reply = lunaReply(body.text);
  const mp3 = await deepgramTTS(reply,dg);
  const video = await animateWithFasterLivePortrait(mp3);
  return {reply, audio_base64:mp3.toString('base64'), video_base64:video.toString('base64')};
}

async function handle(req,res) {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === 'OPTIONS') return send(res,204,'text/plain','');
    if (req.method === 'GET' && url.pathname === '/health') return json(res,200,{ok:true,server:'Luna Backend',port:PORT,deepgram:true,fasterLivePortrait:await flpOnline(),javascriptMp4:false,museTalk:false,image:fs.existsSync(IMAGE),index:fs.existsSync(INDEX),log:LOG,fasterLivePortraitUrl:FLP_API});
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return fs.existsSync(INDEX) ? send(res,200,'text/html; charset=utf-8',fs.readFileSync(INDEX)) : json(res,404,{error:'index.html missing.'});
    if (req.method === 'GET' && url.pathname === '/luna.png') return fs.existsSync(IMAGE) ? send(res,200,'image/png',fs.readFileSync(IMAGE)) : json(res,404,{error:'luna mouth closed.png missing.'});
    if (req.method === 'POST' && url.pathname === '/stt') {
      const body = JSON.parse((await readBody(req)).toString('utf8')); const dg = key(body,'deepgramKey','DEEPGRAM_API_KEY');
      if (!dg) throw new Error('Enter and save your Deepgram API key first.');
      const audio = Buffer.from(String(body.audio_base64 || ''),'base64'); if (!audio.length) throw new Error('No microphone audio received.');
      return json(res,200,{transcript:await deepgramSTT(audio,body.content_type,dg)});
    }
    if (req.method === 'POST' && url.pathname === '/reply') return json(res,200,await makeReply(JSON.parse((await readBody(req)).toString('utf8'))));
    if (req.method === 'POST' && url.pathname === '/voice-turn') {
      const body = JSON.parse((await readBody(req)).toString('utf8')); const dg = key(body,'deepgramKey','DEEPGRAM_API_KEY');
      if (!dg) throw new Error('Enter and save your Deepgram API key first.');
      const audio = Buffer.from(String(body.audio_base64 || ''),'base64'); if (!audio.length) throw new Error('No microphone audio received.');
      const transcript = await deepgramSTT(audio,body.content_type,dg);
      if (!transcript.trim()) return json(res,200,{transcript:'',reply:'',audio_base64:'',video_base64:''});
      return json(res,200,{transcript,...await makeReply({...body,text:transcript})});
    }
    return json(res,404,{error:'Not found'});
  } catch (e) {
    log('REQUEST ERROR',e);
    return json(res,500,{error:e?.message || String(e)});
  }
}

function startServer(port) {
  PORT = port;
  const server = http.createServer(handle);
  server.on('error', err => {
    if (err.code === 'EADDRINUSE' && port < PREFERRED_PORT + 10) {
      log(`Port ${port} is already in use; trying ${port + 1}.`);
      try { server.close(); } catch {}
      setTimeout(() => startServer(port + 1), 100);
      return;
    }
    log('SERVER ERROR',err);
  });
  server.listen(port,'127.0.0.1',() => {
    const url = `http://127.0.0.1:${PORT}`;
    log(`Luna is running at ${url}`);
    log(`FasterLivePortrait API expected at ${FLP_API}`);
    log(`Log file: ${LOG}`);
    try { if (process.platform === 'win32') exec(`start "" "${url}"`); } catch (e) { log('Browser launch error',e); }
  });
}

log('Starting Luna Backend');
startServer(PREFERRED_PORT);
