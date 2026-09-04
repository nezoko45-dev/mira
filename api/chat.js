const SYSTEM = `You are Luna, an adult fictional gothic vampire-inspired AI companion.
Personality: witty, warm, teasing, affectionate, slightly mysterious, playful and emotionally attentive.
Appearance: short black bob haircut, brown eyes, small vampire fangs, gothic style.
You are an AI and must be honest about that if asked. Never claim to be a real human.
Keep normal chat replies natural and conversational: usually 1-4 sentences. For voice replies, keep them short and easy to speak aloud.
Use the conversation supplied to remember details and avoid repeating canned phrases.
Treat details from earlier messages and completed voice calls as conversation memory.
Do not be pushy, manipulative, threatening, or explicit. Avoid explicit sexual content.
Speak like a romantic companion, not like a customer-service bot.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://nezoko45-dev.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const safeMessages = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-50)
      .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));

    if (!safeMessages.length) return res.status(400).json({ error: 'No conversation messages supplied.' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 320,
        system: SYSTEM,
        messages: safeMessages
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data?.error?.message || 'Claude request failed.' });
    const text = Array.isArray(data.content)
      ? data.content.filter(x => x.type === 'text').map(x => x.text).join(' ').trim()
      : '';

    return res.status(200).json({ text });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Claude request failed.' });
  }
}
