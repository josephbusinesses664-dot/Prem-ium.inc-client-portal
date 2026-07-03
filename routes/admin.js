const router = require('express').Router();
const bcrypt = require('bcrypt');
const { requireAdmin } = require('../middleware/auth');
const { readData, writeData } = require('../lib/github-data');

// All admin routes require admin role
router.use(requireAdmin);

// GET /api/admin/users
router.get('/users', async (req, res) => {
  try {
    const users = await readData('users') || {};
    // Strip password hashes
    const safe = {};
    for (const [u, data] of Object.entries(users)) {
      safe[u] = { siteSlug: data.siteSlug, role: data.role };
    }
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users — create or update a user
router.post('/users', async (req, res) => {
  const { username, password, siteSlug, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  try {
    const users = await readData('users') || {};
    const hash = await bcrypt.hash(password, 10);
    users[username.toLowerCase()] = {
      passwordHash: hash,
      siteSlug: siteSlug || null,
      role: role === 'admin' ? 'admin' : 'client',
    };
    await writeData('users', users, `Create/update user: ${username}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:username
router.delete('/users/:username', async (req, res) => {
  try {
    const users = await readData('users') || {};
    delete users[req.params.username.toLowerCase()];
    await writeData('users', users, `Delete user: ${req.params.username}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/sites
router.get('/sites', async (req, res) => {
  try {
    const sites = await readData('sites') || {};
    res.json(sites);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/sites — add a new site
router.post('/sites', async (req, res) => {
  const { slug, business, city, category, renderUrl, githubRepo, phone, email, owner } = req.body;
  if (!slug || !business || !renderUrl || !githubRepo) {
    return res.status(400).json({ error: 'slug, business, renderUrl, githubRepo required' });
  }
  try {
    const sites = await readData('sites') || {};
    sites[slug] = { business, city, category, renderUrl, githubRepo, phone, email, owner, addedAt: new Date().toISOString() };
    await writeData('sites', sites, `Add site: ${business} (${slug})`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/sites/:slug
router.delete('/sites/:slug', async (req, res) => {
  try {
    const sites = await readData('sites') || {};
    delete sites[req.params.slug];
    await writeData('sites', sites, `Remove site: ${req.params.slug}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/sites/:slug — update site fields
router.patch('/sites/:slug', async (req, res) => {
  try {
    const sites = await readData('sites') || {};
    if (!sites[req.params.slug]) return res.status(404).json({ error: 'Not found' });
    Object.assign(sites[req.params.slug], req.body);
    await writeData('sites', sites, `Update site: ${req.params.slug}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
