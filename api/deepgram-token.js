export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).send('Method not allowed');

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const suppliedKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
    const apiKey = suppliedKey || process.env.DEEPGRAM_API_KEY;
    if (!apiKey) return res.status(400).send('Deepgram API key is not configured. Open Settings → API Keys and enter your key.');

    const response = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: 300 })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    return res.status(200).send(data.access_token);
  } catch (error) {
    console.error('Deepgram token request failed:', error?.message || error);
    return res.status(500).send('Could not mint Deepgram token.');
  }
}
