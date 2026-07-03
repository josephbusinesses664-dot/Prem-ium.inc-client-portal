const router = require('express').Router();
const bcrypt = require('bcrypt');
const https = require('https');
const { requireAdmin } = require('../middleware/auth');
const { readData, writeData, injectGaTag } = require('../lib/github-data');

const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_ORG = process.env.GITHUB_ORG || 'josephbusinesses664-dot';

function ghApi(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path,
      method, headers: {
        Authorization: `token ${GH_TOKEN}`,
        'User-Agent': 'prem-ium-portal',
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

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

// POST /api/admin/create-repo — create a new GitHub repo for a client site
router.post('/create-repo', async (req, res) => {
  const { repo, description } = req.body;
  if (!repo) return res.status(400).json({ error: 'repo name required' });
  if (!GH_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN not set' });
  try {
    const result = await ghApi('POST', `/user/repos`, {
      name: repo,
      description: description || `${repo} preview site`,
      private: false,
      auto_init: true
    });
    if (result.status === 201) {
      res.json({ ok: true, url: result.body.html_url });
    } else {
      res.status(result.status).json({ error: result.body.message || 'GitHub API error' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/inject-ga/:slug — inject GA4 tag into one site
router.post('/inject-ga/:slug', async (req, res) => {
  try {
    const sites = await readData('sites') || {};
    const site = sites[req.params.slug];
    if (!site) return res.status(404).json({ error: 'Site not found' });
    const measurementId = site.measurementId || process.env.GA4_MEASUREMENT_ID;
    const result = await injectGaTag(site.githubRepo, measurementId);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/inject-ga-all — inject GA4 tag into all sites
router.post('/inject-ga-all', async (req, res) => {
  try {
    const sites = await readData('sites') || {};
    const slugs = Object.keys(sites);
    const results = { done: 0, skipped: 0, failed: 0, details: [] };

    for (const slug of slugs) {
      const site = sites[slug];
      try {
        const measurementId = site.measurementId || process.env.GA4_MEASUREMENT_ID;
        const r = await injectGaTag(site.githubRepo, measurementId);
        if (r.skipped) { results.skipped++; results.details.push({ slug, skipped: true, reason: r.reason }); }
        else { results.done++; results.details.push({ slug, done: true, commitUrl: r.commitUrl }); }
        // Small delay to avoid GitHub rate limits
        await new Promise(resolve => setTimeout(resolve, 600));
      } catch (err) {
        results.failed++;
        results.details.push({ slug, failed: true, error: err.message });
      }
    }

    res.json({ ok: true, ...results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
