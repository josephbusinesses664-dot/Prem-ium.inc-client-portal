const fetch = require('node-fetch');

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL = process.env.DISCORD_RESULTS_CH || '1516605432830103602';

async function notify(message) {
  if (!TOKEN) {
    console.log('[discord] (no token) would send:', message.slice(0, 80));
    return;
  }
  try {
    const r = await fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: message.slice(0, 2000) }),
    });
    if (!r.ok) console.error('[discord] notify failed:', r.status, await r.text());
  } catch (err) {
    console.error('[discord] notify error:', err.message);
  }
}

module.exports = { notify };
