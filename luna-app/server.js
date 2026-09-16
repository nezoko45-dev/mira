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
const VIDEO_DIR = path.join(os.tmpdir(), 'luna-musetalk-videos');
const MAX_BODY = 12 * 1024 * 1024;
const MUSETALK_SPACE = 'henrybit/musetalk-1-5';
let museTalkClientPromise = null;

fs.mkdirSync(VIDEO_DIR, { recursive: true });

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
function json(res, code, obj) { send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj)); }
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
function key(b, f, e) { return String(b?.[f] || process.env[e] || '').trim(); }

async function deepgramSTT(audio, contentType, apiKey) {
  const r = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&mip_opt_out=true', {
    method: 'POST', headers: { Authorization: 'Token ' + apiKey, 'Content-Type': contentType || 'audio/webm' }, body: audio
  });
  const text = await r.text();
  if (!r.ok) throw new Error('Deepgram STT ' + r.status + ': ' + text.slice(0, 700));
  return JSON.parse(text)?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
}

async function deepgramTTS(text, apiKey) {
  const r = await fetch('https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3&bit_rate=32000&mip_opt_out=true', {
    method: 'POST', headers: { Authorization: 'Token ' + apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ text })
  });
  const b = Buffer.from(await r.arrayBuffer());
  if (!r.ok) throw new Error('Deepgram TTS ' + r.status + ': ' + b.toString('utf8').slice(0, 700));
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

function findVideoUrl(v, seen = new Set()) {
  if (v == null) return '';
  if (typeof v === 'string') {
    return /\.mp4($|\?)/i.test(v) || v.includes('/file=') || v.includes('/gradio_api/file=') ? v : '';
  }
  if (typeof v !== 'object' || seen.has(v)) return '';
  seen.add(v);
  for (const k of ['url', 'video', 'path', 'file', 'value', 'href']) {
    if (v[k]) { const f = findVideoUrl(v[k], seen); if (f) return f; }
  }
  if (Array.isArray(v)) for (const x of v) { const f = findVideoUrl(x, seen); if (f) return f; }
  return '';
}

async function getMuseTalkClient() {
  if (!museTalkClientPromise) {
    museTalkClientPromise = Client.connect(MUSETALK_SPACE, {
      status_callback: s => console.log('[MuseTalk]', s?.status || s?.detail || s)
    });
  }
  return museTalkClientPromise;
}

async function museTalk(audio) {
  if (audio.length > 8 * 1024 * 1024) throw new Error('The MP3 is over 8 MB. Use a shorter reply.');
  if (!fs.existsSync(IMAGE)) throw new Error('luna mouth closed.png is missing next to Luna-Backend.exe.');
  const temp = path.join(os.tmpdir(), `luna-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`);
  fs.writeFileSync(temp, audio);
  try {
    const app = await getMuseTalkClient();
    console.log('[MuseTalk] generating MP4...');
    const result = await app.predict('/generate', [handle_file(temp), handle_file(IMAGE), 0, 10, 'jaw', 90, 90]);
    console.log('[MuseTalk] result:', JSON.stringify(result).slice(0, 3000));
    const remoteUrl = findVideoUrl(result?.data ?? result);
    if (!remoteUrl) throw new Error('MuseTalk finished but returned no MP4 URL.');

    // Never expose the Gradio object/FileData to Chrome. Download the actual MP4
    // and serve it from this local Node server so Chrome receives plain video/mp4.
    console.log('[MuseTalk] downloading generated MP4 for local Chrome playback...');
    const vr = await fetch(remoteUrl);
    if (!vr.ok) throw new Error(`Could not download MuseTalk MP4 (${vr.status}).`);
    const video = Buffer.from(await vr.arrayBuffer());
    if (video.length < 1000) throw new Error('MuseTalk returned an empty MP4.');
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filename = `${id}.mp4`;
    fs.writeFileSync(path.join(VIDEO_DIR, filename), video);
    console.log(`[MuseTalk] local MP4 ready: ${video.length} bytes`);
    return `/video/${filename}`;
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function serveVideo(req, res, filename) {
  if (!/^[a-zA-Z0-9-]+\.mp4$/.test(filename)) return json(res, 400, { error: 'Invalid video.' });
  const file = path.join(VIDEO_DIR, filename);
  if (!fs.existsSync(file)) return json(res, 404, { error: 'Video expired or not found.' });
  const stat = fs.statSync(file);
  const range = req.headers.range;
  if (!range) return send(res, 200, 'video/mp4', fs.readFileSync(file), { 'Accept-Ranges': 'bytes' });

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return send(res, 416, 'text/plain', 'Invalid range');
  const start = match[1] ? Number(match[1]) : 0;
  const requestedEnd = match[2] ? Number(match[2]) : stat.size - 1;
  const end = Math.min(requestedEnd, stat.size - 1);
  if (start >= stat.size || start > end) {
    return send(res, 416, 'text/plain', 'Range not satisfiable', { 'Content-Range': `bytes */${stat.size}` });
  }
  const length = end - start + 1;
  res.writeHead(206, {
    'Content-Type': 'video/mp4',
    'Content-Length': length,
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  fs.createReadStream(file, { start, end }).pipe(res);
}

// Keep temporary videos for 30 minutes, then remove them.
setInterval(() => {
  try {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const name of fs.readdirSync(VIDEO_DIR)) {
      const file = path.join(VIDEO_DIR, name);
      try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch {}
    }
  } catch {}
}, 5 * 60 * 1000).unref();

async function handle(req, res) {
  try {
    const u = new URL(req.url, 'http://127.0.0.1:' + PORT);
    if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '');
    if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true, image: fs.existsSync(IMAGE), index: fs.existsSync(INDEX), model: MUSETALK_SPACE, localVideoProxy: true });
    if (req.method === 'GET' && u.pathname.startsWith('/video/')) return serveVideo(req, res, u.pathname.slice('/video/'.length));
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) return fs.existsSync(INDEX) ? send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(INDEX)) : json(res, 404, { error: 'index.html missing from packaged app.' });
    if (req.method === 'GET' && u.pathname === '/luna.png') return fs.existsSync(IMAGE) ? send(res, 200, 'image/png', fs.readFileSync(IMAGE)) : json(res, 404, { error: 'luna mouth closed.png missing next to Luna-Backend.exe.' });
    if (req.method === 'POST' && u.pathname === '/stt') {
      const b = JSON.parse((await readBody(req)).toString()); const dg = key(b, 'deepgramKey', 'DEEPGRAM_API_KEY');
      if (!dg) throw new Error('Add your Deepgram API key in the app.'); const a = Buffer.from(String(b.audio_base64 || ''), 'base64');
      if (!a.length) throw new Error('No microphone audio received.'); return json(res, 200, { transcript: await deepgramSTT(a, b.content_type || 'audio/webm', dg) });
    }
    if (req.method === 'POST' && u.pathname === '/speak') {
      const b = JSON.parse((await readBody(req)).toString()); const dg = key(b, 'deepgramKey', 'DEEPGRAM_API_KEY');
      if (!dg) throw new Error('Add your Deepgram API key in the app.'); const mp3 = await deepgramTTS(String(b.text || ''), dg);
      return json(res, 200, { audio_base64: mp3.toString('base64') });
    }
    if (req.method === 'POST' && u.pathname === '/animate') {
      const b = JSON.parse((await readBody(req)).toString()); const a = Buffer.from(String(b.audio_base64 || ''), 'base64');
      if (!a.length) throw new Error('No MP3 supplied.'); return json(res, 200, { video_url: await museTalk(a) });
    }
    if (req.method === 'POST' && u.pathname === '/reply') {
      const b = JSON.parse((await readBody(req)).toString()); const dg = key(b, 'deepgramKey', 'DEEPGRAM_API_KEY');
      if (!dg) throw new Error('Add your Deepgram API key in the app.'); const reply = lunaReply(String(b.text || '')); const mp3 = await deepgramTTS(reply, dg);
      return json(res, 200, { reply, audio_base64: mp3.toString('base64'), video_url: await museTalk(mp3) });
    }
    if (req.method === 'POST' && u.pathname === '/voice-turn') {
      const b = JSON.parse((await readBody(req)).toString()); const dg = key(b, 'deepgramKey', 'DEEPGRAM_API_KEY');
      if (!dg) throw new Error('Add your Deepgram API key in the app.'); const a = Buffer.from(String(b.audio_base64 || ''), 'base64');
      if (!a.length) throw new Error('No microphone audio received.'); const transcript = await deepgramSTT(a, b.content_type || 'audio/webm', dg);
      if (!transcript) return json(res, 200, { transcript: '', reply: '', audio_base64: '', video_url: '' });
      const reply = lunaReply(transcript); const mp3 = await deepgramTTS(reply, dg);
      return json(res, 200, { transcript, reply, audio_base64: mp3.toString('base64'), video_url: await museTalk(mp3) });
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
