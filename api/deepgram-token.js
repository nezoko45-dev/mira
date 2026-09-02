export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://nezoko45-dev.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return res.status(500).send('DEEPGRAM_API_KEY is not configured.');

  try {
    const response = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: 300 })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    return res.status(200).send(data.access_token);
  } catch (error) {
    console.error(error);
    return res.status(500).send('Could not mint Deepgram token.');
  }
}
