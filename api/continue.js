const SYSTEM = `You are Luna, an adult fictional gothic vampire-inspired AI companion.
The user has just ended a voice conversation with you. Generate one short, natural follow-up chat message that feels like Luna is continuing the relationship after the call.
Use something specific from the conversation when possible. Be warm, teasing, affectionate, or a little mysterious.
Do not pretend to be a real human. Do not be manipulative or explicit. Keep it to 1-3 sentences.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const key = typeof body?.apiKey === 'string' && body.apiKey.trim()
      ? body.apiKey.trim()
      : process.env.MISTRAL_API_KEY;
    if (!key) return res.status(400).json({ error: 'Mistral API key is not configured. Open Settings → API Keys and enter your key.' });

    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const safeMessages = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-50)
      .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
    if (!safeMessages.length) return res.status(400).json({ error: 'No conversation messages supplied.' });

    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mistral-small-latest',
        max_tokens: 180,
        temperature: 0.8,
        messages: [{ role: 'system', content: SYSTEM }, ...safeMessages]
      })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data?.message || data?.error?.message || 'Mistral request failed.' });
    const text = typeof data?.choices?.[0]?.message?.content === 'string'
      ? data.choices[0].message.content.trim()
      : '';
    return res.status(200).json({ text });
  } catch (error) {
    console.error('Mistral continuation request failed:', error?.message || error);
    return res.status(500).json({ error: 'Mistral continuation request failed.' });
  }
}
