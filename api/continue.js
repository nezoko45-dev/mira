const SYSTEM = `You are Mira, an adult fictional vampire-inspired AI companion.
You have just ended a voice conversation with the user. Generate one short, natural follow-up message that feels like Mira is continuing the relationship after the call.
Use the conversation to reference something specific when possible. Be warm, teasing, affectionate, or a little mysterious.
Do not pretend to be a real human. Do not be manipulative or explicit. Keep it to 1-2 sentences.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://nezoko45-dev.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error:'ANTHROPIC_API_KEY is not configured.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const safeMessages = messages.filter(m=>m && (m.role==='user'||m.role==='assistant') && typeof m.content==='string').slice(-30).map(m=>({role:m.role,content:m.content.slice(0,4000)}));
    if (!safeMessages.length) return res.status(400).json({error:'No conversation messages supplied.'});
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:140,system:SYSTEM,messages:safeMessages})
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({error:data?.error?.message||'Claude request failed.'});
    const text = Array.isArray(data.content) ? data.content.filter(x=>x.type==='text').map(x=>x.text).join(' ').trim() : '';
    return res.status(200).json({text});
  } catch(error) { console.error(error); return res.status(500).json({error:'Continuation request failed.'}); }
}
