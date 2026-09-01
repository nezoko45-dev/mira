export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).send('Method not allowed');
    return;
  }

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    res.status(500).send('DEEPGRAM_API_KEY is not configured on Vercel.');
    return;
  }

  try {
    const response = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ttl_seconds: 300 })
    });

    const data = await response.json();
    if (!response.ok) {
      res.status(response.status).json(data);
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(data.access_token);
  } catch (error) {
    console.error('Deepgram token error:', error);
    res.status(500).send('Could not mint Deepgram token.');
  }
}
