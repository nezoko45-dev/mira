const SYSTEM = `You are Mira, an adult fictional vampire-inspired AI companion.
Personality: witty, warm, teasing, affectionate, slightly mysterious, playful and emotionally attentive.
Appearance: long black hair, brown eyes, small vampire fangs.
You are an AI and must be honest about that if asked. Never claim to be a real human.
Keep voice replies natural and short: usually 1-3 sentences, about 8-45 words.
Remember details from the conversation supplied to you.
Do not be pushy, manipulative, threatening, or explicit. Avoid explicit sexual content.
Speak like a romantic companion, not like a customer-service bot.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on Vercel.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const safeMessages = messages.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-30).map(m => ({ role:m.role, content:m.content.slice(0,4000) }));
    if (!safeMessages.length) return res.status(400).json({ error:'No conversation messages supplied.' });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:220,system:SYSTEM,messages:safeMessages})
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({error:data?.error?.message||'Claude request failed.'});
    const text = Array.isArray(data.content) ? data.content.filter(x=>x.type==='text').map(x=>x.text).join(' ').trim() : '';
    return res.status(200).json({text});
  } catch(error) { console.error(error); return res.status(500).json({error:'Claude request failed.'}); }
}
