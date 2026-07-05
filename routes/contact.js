const router = require('express').Router();
const { readData, writeData } = require('../lib/github-data');
const discord = require('../lib/discord');

// Public endpoint — the prem-ium.inc website's contact form posts here.
// CORS-open so it can be called cross-origin from the portfolio site.
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const clip = (s, n) => String(s || '').trim().slice(0, n);

// POST /api/contact — a new "build" request from the website (or a general enquiry)
router.post('/', async (req, res) => {
  try {
    // Honeypot: bots fill hidden "company" field → silently accept, do nothing.
    if (req.body.company) return res.json({ ok: true });

    const name = clip(req.body.name, 120);
    const email = clip(req.body.email, 160);
    const message = clip(req.body.message, 2000);
    const kind = req.body.kind === 'change' ? 'change' : 'build';
    const source = clip(req.body.source, 80) || (kind === 'change' ? 'portal' : 'website');
    if (!message && !email) return res.status(400).json({ error: 'Please include a message or contact.' });

    const entry = {
      id: require('crypto').randomUUID(),
      type: kind === 'change' ? 'change-request' : 'build-request',
      source, name, email, message,
      siteSlug: clip(req.body.siteSlug, 60) || null,
      status: 'new',
      createdAt: new Date().toISOString(),
    };
    const list = (await readData('contacts')) || [];
    list.push(entry);
    await writeData('contacts', list, `New ${entry.type} from ${name || email || 'someone'}`);

    // 1) Immediate auto-message so Prem sees exactly what was asked, in the
    //    delegation channel where Joseph/Caleb pick up work.
    const heading = kind === 'change'
      ? `🛠️ **New CHANGE request** (from the portal)`
      : `✨ **New BUILD request** (from prem-ium.inc)`;
    await discord.notify(
      `${heading}\n` +
      `**From:** ${name || '—'}${email ? ` · ${email}` : ''}${entry.siteSlug ? ` · site: \`${entry.siteSlug}\`` : ''}\n` +
      `**They want:**\n> ${message.replace(/\n/g, '\n> ').slice(0, 1500)}\n` +
      `\n@Joseph — please prepare a plan; implement it if it's simple, otherwise delegate to Caleb.\n` +
      `_ref: ${entry.id}_`,
      discord.DELEGATION_CH
    );

    res.json({ ok: true, id: entry.id });
  } catch (err) {
    console.error('[contact] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
