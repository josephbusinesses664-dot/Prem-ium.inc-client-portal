const router = require('express').Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { readData, writeData } = require('../lib/github-data');
const discord = require('../lib/discord');

function uuid() { return require('crypto').randomUUID(); }

// POST /api/requests — submit a change request
router.post('/', requireAuth, async (req, res) => {
  const { description, siteSlug } = req.body;
  if (!description) return res.status(400).json({ error: 'Description required' });

  const slug = req.user.role === 'admin' ? (siteSlug || 'admin') : req.user.siteSlug;
  if (!slug) return res.status(400).json({ error: 'No site assigned' });

  try {
    const sites = await readData('sites');
    const site = sites?.[slug];
    const businessName = site?.business || slug;

    const requests = await readData('requests') || [];
    const entry = {
      id: uuid(),
      siteSlug: slug,
      user: req.user.username,
      businessName,
      description,
      status: 'pending',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      note: null,
    };
    requests.push(entry);
    await writeData('requests', requests, `New change request from ${req.user.username} for ${businessName}`);

    // Route into the delegation channel so Joseph/Caleb can pick it up.
    await discord.notify(
      `🛠️ **New CHANGE request** (from the portal)\n` +
      `**From:** \`${req.user.username}\` · site: \`${businessName}\`\n` +
      `**They want:**\n> ${description.replace(/\n/g, '\n> ').slice(0, 1500)}\n` +
      `\n@Joseph — please prepare a plan; implement it if it's simple, otherwise delegate to Caleb.\n` +
      `_ID: ${entry.id}_`,
      discord.DELEGATION_CH
    );

    res.json({ ok: true, id: entry.id });
  } catch (err) {
    console.error('[requests] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/requests — list requests for current user (admin sees all)
router.get('/', requireAuth, async (req, res) => {
  try {
    const requests = await readData('requests') || [];
    const filtered = req.user.role === 'admin'
      ? requests
      : requests.filter(r => r.siteSlug === req.user.siteSlug);
    res.json(filtered.reverse()); // newest first
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/requests/:id — admin updates status
router.patch('/:id', requireAdmin, async (req, res) => {
  const { status, note } = req.body;
  try {
    const requests = await readData('requests') || [];
    const entry = requests.find(r => r.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    if (status) entry.status = status;
    if (note !== undefined) entry.note = note;
    if (status === 'done') entry.resolvedAt = new Date().toISOString();
    await writeData('requests', requests, `Update request ${req.params.id}: ${status}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
