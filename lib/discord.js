const fetch = require('node-fetch');

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL = process.env.DISCORD_RESULTS_CH || '1516605432830103602';
// Where inbound build/change requests land so Joseph/Caleb pick them up.
const DELEGATION_CH = process.env.DISCORD_DELEGATION_CH || '1516567301011279925';

async function notify(message, channelId = CHANNEL) {
  if (!TOKEN) {
    console.log('[discord] (no token) would send:', message.slice(0, 80));
    return;
  }
  try {
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: message.slice(0, 2000) }),
    });
    if (!r.ok) console.error('[discord] notify failed:', r.status, await r.text());
    return r.ok;
  } catch (err) {
    console.error('[discord] notify error:', err.message);
    return false;
  }
}

module.exports = { notify, CHANNEL, DELEGATION_CH };
