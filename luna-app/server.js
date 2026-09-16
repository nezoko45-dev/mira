import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const PORT = Number(process.env.LUNA_PORT || 8787);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.pkg ? path.dirname(process.execPath) : path.resolve(MODULE_DIR, '..');
const APP = process.pkg ? MODULE_DIR : path.join(ROOT, 'luna-app');
const INDEX = path.join(APP, 'index.html');
const IMAGE = path.join(ROOT, 'luna mouth closed.png');
const MAX_BODY = 16 * 1024 * 1024;

function send(res, code, type, body, extra = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...extra
  });
  res.end(data);
}
function json(res, code, obj) { return send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Request is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function key(body, field, env) { return String(body?.[field] || process.env[env] || '').trim(); }

async function deepgramSTT(audio, contentType, apiKey) {
  const ct = String(contentType || 'audio/webm').split(';')[0].toLowerCase();
  const safeType = ['audio/webm','audio/ogg','audio/wav','audio/wave','audio/x-wav','audio/mpeg','audio/mp4','audio/aac','audio/flac'].includes(ct) ? ct : 'audio/webm';
  const url = 'https://api.deepgram.com/v1/listen?model=nova-3&language=en-US&smart_format=true&punctuate=true';
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': safeType },
    body: audio
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Deepgram STT ${r.status}: ${text.slice(0, 1000)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Deepgram returned invalid JSON.'); }
  return data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
}

async function deepgramTTS(text, apiKey) {
  const r = await fetch('https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3&bit_rate=32000', {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
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

async function handle(req, res) {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '');
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, deepgram: true, javascriptVideo: true, museTalk: false, image: fs.existsSync(IMAGE), index: fs.existsSync(INDEX) });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return fs.existsSync(INDEX) ? send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(INDEX)) : json(res, 404, { error: 'index.html missing.' });
    }
    if (req.method === 'GET' && url.pathname === '/luna.png') {
      return fs.existsSync(IMAGE) ? send(res, 200, 'image/png', fs.readFileSync(IMAGE)) : json(res, 404, { error: 'luna mouth closed.png missing.' });
    }
    if (req.method === 'POST' && url.pathname === '/stt') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const dg = key(body, 'deepgramKey', 'DEEPGRAM_API_KEY');
      if (!dg) throw new Error('Enter and save your Deepgram API key first.');
      const audio = Buffer.from(String(body.audio_base64 || ''), 'base64');
      if (!audio.length) throw new Error('No microphone audio received.');
      return json(res, 200, { transcript: await deepgramSTT(audio, body.content_type, dg) });
    }
    if (req.method === 'POST' && url.pathname === '/speak') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const dg = key(body, 'deepgramKey', 'DEEPGRAM_API_KEY');
      if (!dg) throw new Error('Enter and save your Deepgram API key first.');
      const mp3 = await deepgramTTS(String(body.text || ''), dg);
      return json(res, 200, { audio_base64: mp3.toString('base64') });
    }
    if (req.method === 'POST' && url.pathname === '/reply') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const dg = key(body, 'deepgramKey', 'DEEPGRAM_API_KEY');
      if (!dg) throw new Error('Enter and save your Deepgram API key first.');
      const reply = lunaReply(body.text);
      const mp3 = await deepgramTTS(reply, dg);
      return json(res, 200, { reply, audio_base64: mp3.toString('base64') });
    }
    if (req.method === 'POST' && url.pathname === '/voice-turn') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const dg = key(body, 'deepgramKey', 'DEEPGRAM_API_KEY');
      if (!dg) throw new Error('Enter and save your Deepgram API key first.');
      const audio = Buffer.from(String(body.audio_base64 || ''), 'base64');
      if (!audio.length) throw new Error('No microphone audio received.');
      const transcript = await deepgramSTT(audio, body.content_type, dg);
      if (!transcript.trim()) return json(res, 200, { transcript: '', reply: '', audio_base64: '' });
      const reply = lunaReply(transcript);
      const mp3 = await deepgramTTS(reply, dg);
      return json(res, 200, { transcript, reply, audio_base64: mp3.toString('base64') });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error('[Luna]', e);
    return json(res, 500, { error: e?.message || String(e) });
  }
}

http.createServer(handle).listen(PORT, '127.0.0.1', () => {
  console.log(`Luna is running at http://127.0.0.1:${PORT}`);
  try { if (process.platform === 'win32') exec(`start "" "http://127.0.0.1:${PORT}"`); } catch {}
});
