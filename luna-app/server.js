import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { Client, handle_file } from '@gradio/client';

const PORT = Number(process.env.LUNA_PORT || 8787);
const FLP_URL = process.env.FASTER_LIVEPORTRAIT_URL || 'http://127.0.0.1:9870';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.pkg ? path.dirname(process.execPath) : path.resolve(MODULE_DIR, '..');
const APP = process.pkg ? MODULE_DIR : path.join(ROOT, 'luna-app');
const INDEX = path.join(APP, 'index.html');
const IMAGE = path.join(ROOT, 'luna mouth closed.png');
const MAX_BODY = 32 * 1024 * 1024;

function send(res, code, type, body, extra = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...extra });
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
  const safeType = ['audio/webm','audio/ogg','audio/wav','audio/wave','audio/x-wav','audio/mpeg','audio/mp4','audio/aac','audio/flac'].includes(ct) ? ct : 'audio/webm';
  const r = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&language=en-US&smart_format=true&punctuate=true', { method: 'POST', headers: { Authorization: `Token ${apiKey}`, 'Content-Type': safeType }, body: audio });
  const text = await r.text();
  if (!r.ok) throw new Error(`Deepgram STT ${r.status}: ${text.slice(0, 1000)}`);
  const data = JSON.parse(text);
  return data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
}
async function deepgramTTS(text, apiKey) {
  const r = await fetch('https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3&bit_rate=32000', { method: 'POST', headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  const b = Buffer.from(await r.arrayBuffer());
  if (!r.ok) throw new Error(`Deepgram TTS ${r.status}: ${b.toString('utf8').slice(0, 1000)}`);
  return b;
}
function lunaReply(text) {
  const t = String(text || '').trim();
  if (!t) return 'I am here. Tell me what is on your mind.';
  if (/hello|hi|hey/i.test(t)) return 'Mhm… hello. I was waiting for you. What are you thinking about?';
  if (/how are you/i.test(t)) return 'I am doing nicely now that you are talking to me. Tell me more.';
  if (/bye|goodbye/i.test(t)) return 'Already leaving? Come back when you want to talk again.';
  return `I heard you say, “${t.slice(0, 180)}”. I am listening. Tell me more.`;
}

let flpClientPromise = null;
async function getFLP() {
  if (!flpClientPromise) flpClientPromise = Client.connect(FLP_URL);
  try { return await flpClientPromise; } catch (e) { flpClientPromise = null; throw e; }
}
function endpointFromApi(info) {
  const named = info?.named_endpoints || info?.namedEndpoints || {};
  for (const [name, spec] of Object.entries(named)) {
    const params = JSON.stringify(spec?.parameters || spec?.inputs || []).toLowerCase();
    if (params.includes('driving_audio') || params.includes('audio')) return name;
  }
  for (const name of Object.keys(named)) if (/animate|execute_video/i.test(name)) return name;
  return '/gpu_wrapped_execute_video';
}
function findVideo(value) {
  if (!value) return null;
  if (typeof value === 'string' && /\.(mp4|webm|mov)(\?|$)/i.test(value)) return value;
  if (typeof value === 'object') {
    for (const k of ['url','path','video','value']) { const hit = findVideo(value[k]); if (hit) return hit; }
    for (const v of Object.values(value)) { const hit = findVideo(v); if (hit) return hit; }
  }
  if (Array.isArray(value)) for (const v of value) { const hit = findVideo(v); if (hit) return hit; }
  return null;
}
async function animateWithFasterLivePortrait(audioBuffer, audioType) {
  const client = await getFLP();
  const info = await client.view_api();
  const endpoint = endpointFromApi(info);
  const imageRef = handle_file(IMAGE);
  const audioRef = handle_file(new Blob([audioBuffer], { type: audioType || 'audio/mpeg' }));
  const inputs = [
    imageRef, null, null, null, null, audioRef, '',
    false, true, true, 1.0, true, false, false, false, 'all',
    2.3, 0.0, -0.125, 2.2, 0.0, -0.1, 1e-7, 'Image', 'Audio', 4.0, 'af_heart'
  ];
  const result = await client.predict(endpoint, inputs);
  const video = findVideo(result?.data ?? result);
  if (!video) throw new Error(`FasterLivePortrait returned no video. Endpoint: ${endpoint}`);
  const vr = await fetch(video.startsWith('http') ? video : new URL(video, FLP_URL).href);
  if (!vr.ok) throw new Error(`Could not read FasterLivePortrait output (${vr.status}).`);
  return Buffer.from(await vr.arrayBuffer());
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '');
    if (req.method === 'GET' && url.pathname === '/health') {
      let livePortrait = false;
      try { const r = await fetch(`${FLP_URL}/`); livePortrait = r.ok; } catch {}
      return json(res, 200, { ok: true, deepgram: true, fasterLivePortrait: livePortrait, javascriptMp4: false, museTalk: false, image: fs.existsSync(IMAGE), index: fs.existsSync(INDEX), fasterLivePortraitUrl: FLP_URL });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return fs.existsSync(INDEX) ? send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(INDEX)) : json(res, 404, { error: 'index.html missing.' });
    if (req.method === 'GET' && url.pathname === '/luna.png') return fs.existsSync(IMAGE) ? send(res, 200, 'image/png', fs.readFileSync(IMAGE)) : json(res, 404, { error: 'luna mouth closed.png missing.' });
    if (req.method === 'POST' && url.pathname === '/stt') {
      const body = JSON.parse((await readBody(req)).toString('utf8')); const dg = key(body, 'deepgramKey', 'DEEPGRAM_API_KEY'); if (!dg) throw new Error('Enter and save your Deepgram API key first.');
      const audio = Buffer.from(String(body.audio_base64 || ''), 'base64'); if (!audio.length) throw new Error('No microphone audio received.');
      return json(res, 200, { transcript: await deepgramSTT(audio, body.content_type, dg) });
    }
    if (req.method === 'POST' && url.pathname === '/reply') {
      const body = JSON.parse((await readBody(req)).toString('utf8')); const dg = key(body, 'deepgramKey', 'DEEPGRAM_API_KEY'); if (!dg) throw new Error('Enter and save your Deepgram API key first.');
      const reply = lunaReply(body.text); const mp3 = await deepgramTTS(reply, dg); return json(res, 200, { reply, audio_base64: mp3.toString('base64') });
    }
    if (req.method === 'POST' && url.pathname === '/voice-turn') {
      const body = JSON.parse((await readBody(req)).toString('utf8')); const dg = key(body, 'deepgramKey', 'DEEPGRAM_API_KEY'); if (!dg) throw new Error('Enter and save your Deepgram API key first.');
      const audio = Buffer.from(String(body.audio_base64 || ''), 'base64'); if (!audio.length) throw new Error('No microphone audio received.');
      const transcript = await deepgramSTT(audio, body.content_type, dg); if (!transcript.trim()) return json(res, 200, { transcript: '', reply: '', audio_base64: '' });
      const reply = lunaReply(transcript); const mp3 = await deepgramTTS(reply, dg);
      let video_base64 = '';
      try { video_base64 = (await animateWithFasterLivePortrait(mp3, 'audio/mpeg')).toString('base64'); }
      catch (e) { console.error('[FasterLivePortrait]', e); throw new Error(`FasterLivePortrait is not ready: ${e.message}`); }
      return json(res, 200, { transcript, reply, audio_base64: mp3.toString('base64'), video_base64 });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (e) { console.error('[Luna]', e); return json(res, 500, { error: e?.message || String(e) }); }
}

http.createServer(handle).listen(PORT, '127.0.0.1', () => {
  console.log(`Luna is running at http://127.0.0.1:${PORT}`);
  console.log(`FasterLivePortrait expected at ${FLP_URL}`);
  try { if (process.platform === 'win32') exec(`start "" "http://127.0.0.1:${PORT}"`); } catch {}
});
