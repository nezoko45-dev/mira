const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = Number(process.env.LUNA_PORT || 8787);
const ROOT = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'luna-app');
const IMAGE = path.join(ROOT, 'luna mouth closed.png');
const MAX_BODY = 12 * 1024 * 1024;
const WAV2LIP_VERSION = '22b1ecf6252b8adcaeadde30bb672b199c125b7d3c98607db70b66eea21d75ae';
const IMAGE_URL = 'https://raw.githubusercontent.com/nezoko45-dev/mira/main/luna%20mouth%20closed.png';

function send(res, code, type, body) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(code, {'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': 'http://127.0.0.1:' + PORT});
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

function outputUrl(output) {
  if(typeof output === 'string') return output;
  if(output && typeof output === 'object') {
    if(typeof output.url === 'string') return output.url;
    if(typeof output.href === 'string') return output.href;
  }
  return '';
}

async function wav2lip(audio, token) {
  if(audio.length > 1024 * 1024) throw new Error('The MP3 is over 1 MB. Shorten the reply and try again.');
  const audioData = 'data:audio/mpeg;base64,' + audio.toString('base64');
  const create = await fetch('https://api.replicate.com/v1/predictions', {
    method:'POST',
    headers:{'Authorization':'Bearer '+token, 'Content-Type':'application/json', 'Prefer':'wait=60'},
    body:JSON.stringify({
      version:WAV2LIP_VERSION,
      input:{face:IMAGE_URL,audio:audioData,pads:'0 10 0 0',smooth:true,fps:25,out_height:480}
    })
  });
  const createText = await create.text();
  if(!create.ok) throw new Error('Wav2Lip '+create.status+': '+createText.slice(0,900));
  let prediction;
  try { prediction=JSON.parse(createText); } catch { throw new Error('Wav2Lip returned invalid JSON.'); }

  for(let attempt=0; attempt<36; attempt++) {
    const status = prediction?.status;
    if(status === 'succeeded') {
      const out = outputUrl(prediction.output);
      if(out) return out;
      throw new Error('Wav2Lip finished but returned no MP4 URL.');
    }
    if(status === 'failed' || status === 'canceled') {
      throw new Error('Wav2Lip '+status+': '+String(prediction?.error || 'unknown error').slice(0,900));
    }
    const pollUrl = prediction?.urls?.get;
    if(!pollUrl) throw new Error('Wav2Lip did not provide a prediction status URL.');
    await new Promise(r=>setTimeout(r,5000));
    const poll = await fetch(pollUrl, {headers:{'Authorization':'Bearer '+token}});
    const pollText = await poll.text();
    if(!poll.ok) throw new Error('Wav2Lip status '+poll.status+': '+pollText.slice(0,900));
    try { prediction=JSON.parse(pollText); } catch { throw new Error('Wav2Lip status returned invalid JSON.'); }
  }
  throw new Error('Wav2Lip is still processing after 3 minutes. Try a shorter sentence.');
}

async function handle(req,res) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1:'+PORT);
    if(req.method === 'OPTIONS') return send(res,204,'text/plain','');
    if(req.method === 'GET' && url.pathname === '/health') return json(res,200,{ok:true,deepgram:true,wav2lip:true,image:fs.existsSync(IMAGE),version:WAV2LIP_VERSION});
    if(req.method === 'GET' && (url.pathname==='/' || url.pathname==='/index.html')) { const f=path.join(APP,'index.html'); return fs.existsSync(f)?send(res,200,'text/html; charset=utf-8',fs.readFileSync(f)):json(res,404,{error:'index.html missing'}); }
    if(req.method === 'GET' && url.pathname === '/luna.png') return fs.existsSync(IMAGE)?send(res,200,'image/png',fs.readFileSync(IMAGE)):json(res,404,{error:'luna mouth closed.png missing'});
    if(req.method === 'POST' && url.pathname === '/stt') {
      const body=JSON.parse((await readBody(req)).toString('utf8'));
      const dg=key(body,'deepgramKey','DEEPGRAM_API_KEY'); if(!dg) throw new Error('Add your Deepgram API key in the app.');
      const audio=Buffer.from(String(body.audio_base64||''),'base64'); if(!audio.length) throw new Error('No microphone audio received.');
      const transcript=await deepgramSTT(audio,body.content_type||'audio/webm',dg); return json(res,200,{transcript});
    }
    if(req.method === 'POST' && url.pathname === '/speak') {
      const body=JSON.parse((await readBody(req)).toString('utf8')); const dg=key(body,'deepgramKey','DEEPGRAM_API_KEY'); if(!dg) throw new Error('Add your Deepgram API key in the app.');
      const mp3=await deepgramTTS(String(body.text||''),dg); return json(res,200,{audio_base64:mp3.toString('base64')});
    }
    if(req.method === 'POST' && url.pathname === '/animate') {
      const body=JSON.parse((await readBody(req)).toString('utf8')); const token=key(body,'replicateToken','REPLICATE_API_TOKEN'); if(!token) throw new Error('Add your Replicate token in the app.');
      const audio=Buffer.from(String(body.audio_base64||''),'base64'); if(!audio.length) throw new Error('No MP3 supplied.');
      const video_url=await wav2lip(audio,token); return json(res,200,{video_url});
    }
    if(req.method === 'POST' && url.pathname === '/voice-turn') {
      const body=JSON.parse((await readBody(req)).toString('utf8'));
      const dg=key(body,'deepgramKey','DEEPGRAM_API_KEY'); const rep=key(body,'replicateToken','REPLICATE_API_TOKEN'); if(!dg||!rep) throw new Error('Add both Deepgram and Replicate credentials in the app.');
      const audio=Buffer.from(String(body.audio_base64||''),'base64'); if(!audio.length) throw new Error('No microphone audio received.');
      const transcript=await deepgramSTT(audio,body.content_type||'audio/webm',dg); if(!transcript) return json(res,200,{transcript:'',reply:'',audio_base64:'',video_url:''});
      const reply=lunaReply(transcript); const mp3=await deepgramTTS(reply,dg); const video_url=await wav2lip(mp3,rep);
      return json(res,200,{transcript,reply,audio_base64:mp3.toString('base64'),video_url});
    }
    return json(res,404,{error:'Not found'});
  } catch(e) { console.error('[Luna]',e); return json(res,500,{error:e?.message||String(e)}); }
}

const server=http.createServer(handle);
server.listen(PORT,'127.0.0.1',()=>{
  console.log(`Luna is running at http://127.0.0.1:${PORT}`);
  try { if(process.platform==='win32') exec(`start "" "http://127.0.0.1:${PORT}"`); } catch {}
});
