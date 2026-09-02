export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return res.status(500).send('DEEPGRAM_API_KEY is not configured on Vercel.');
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const text = String(body?.text || '').trim().slice(0,2000);
    if (!text) return res.status(400).send('No text supplied.');
    const response = await fetch('https://api.deepgram.com/v1/speak?model=aura-2-asteria-en&encoding=mp3', {
      method:'POST', headers:{Authorization:`Token ${key}`,'Content-Type':'application/json'}, body:JSON.stringify({text})
    });
    if (!response.ok) return res.status(response.status).send(await response.text());
    const audio = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type','audio/mpeg'); res.setHeader('Cache-Control','no-store');
    return res.status(200).send(audio);
  } catch(error) { console.error(error); return res.status(500).send('TTS request failed.'); }
}
