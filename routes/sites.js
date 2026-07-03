const router = require('express').Router();
const cheerio = require('cheerio');
const fetch = require('node-fetch');
const { requireAuth, requireSiteAccess } = require('../middleware/auth');
const { readData, getSiteHTML, putSiteHTML, putSiteImage } = require('../lib/github-data');
const discord = require('../lib/discord');

const GH_ORG = process.env.GITHUB_ORG || 'josephbusinesses664-dot';

// GET /api/sites — public list of all sites
router.get('/', async (req, res) => {
  try {
    const sites = await readData('sites');
    if (!sites) return res.json({});
    // Strip internal fields for public view
    const pub = {};
    for (const [slug, s] of Object.entries(sites)) {
      pub[slug] = {
        business: s.business,
        city: s.city,
        category: s.category,
        renderUrl: s.renderUrl,
      };
    }
    res.json(pub);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sites/:slug — single site detail (auth required for sensitive fields)
router.get('/:slug', requireAuth, async (req, res) => {
  try {
    const sites = await readData('sites');
    const site = sites?.[req.params.slug];
    if (!site) return res.status(404).json({ error: 'Site not found' });
    // Non-admin only sees their own site
    if (req.user.role !== 'admin' && req.user.siteSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Not your site' });
    }
    res.json(site);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sites/:slug/edit — save a text/image edit
router.post('/:slug/edit', requireSiteAccess, async (req, res) => {
  const { slug } = req.params;
  const { ocId, newValue, isImage } = req.body;
  if (!ocId || newValue === undefined) return res.status(400).json({ error: 'Missing ocId or newValue' });

  try {
    const sites = await readData('sites');
    const site = sites?.[slug];
    if (!site) return res.status(404).json({ error: 'Site not found' });

    // Fetch and patch HTML from GitHub
    const { html, sha } = await getSiteHTML(site.githubRepo);
    if (!html) return res.status(500).json({ error: 'Could not fetch site HTML' });

    const $ = cheerio.load(html, { decodeEntities: false });
    injectOcIds($); // re-derive same IDs as proxy

    const el = $(`[data-oc-id="${ocId}"]`);
    if (!el.length) return res.status(404).json({ error: 'Element not found' });

    const tag = el.prop('tagName').toLowerCase();
    let oldValue;

    if (isImage || tag === 'img') {
      oldValue = el.attr('src') || '';
      // newValue is either a data: URI or a path to an already-uploaded image
      if (newValue.startsWith('data:')) {
        // Upload image to GitHub, get path
        const match = newValue.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return res.status(400).json({ error: 'Invalid image data' });
        const ext = match[1].split('/')[1] || 'jpg';
        const filename = `client-${Date.now()}.${ext}`;
        const result = await putSiteImage(site.githubRepo, filename, match[2], null);
        const imgPath = `images/${filename}`;
        el.attr('src', imgPath);
      } else {
        el.attr('src', newValue);
      }
    } else {
      oldValue = el.text();
      el.text(newValue);
    }

    // Remove injected oc-ids before saving back (keep HTML clean)
    $('[data-oc-id]').removeAttr('data-oc-id');

    const commitMsg = `Client edit [${req.user.username}]: ${site.business} — ${ocId}: "${String(oldValue).slice(0,40)}" → "${String(newValue).slice(0,40)}"`;
    const result = await putSiteHTML(site.githubRepo, $.html(), sha, commitMsg);

    const commitUrl = `https://github.com/${GH_ORG}/${site.githubRepo}/commit/${result?.commit?.sha || ''}`;

    await discord.notify(
      `🖊️ **${site.business}** — site edited by \`${req.user.username}\`\n` +
      `Element \`${ocId}\` (${tag}): "${String(oldValue).slice(0,60)}" → "${String(newValue).slice(0,60)}"\n` +
      `📝 ${commitUrl}`
    );

    res.json({ ok: true, commitUrl });
  } catch (err) {
    console.error('[sites] edit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Proxy handler — injects overlay into site HTML ─────────────────────────────

async function proxyHandler(req, res) {
  const { slug } = req.params;
  const token = req.query.token;

  // Token required to access edit mode
  if (!token) return res.redirect(`/login?next=/preview/${slug}`);

  try {
    const { requireAuth: _ra } = require('../middleware/auth');
    const jwt = require('jsonwebtoken');
    const SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod';
    let user;
    try {
      user = jwt.verify(token, SECRET);
    } catch {
      return res.redirect(`/login?next=/preview/${slug}`);
    }
    if (user.role !== 'admin' && user.siteSlug !== slug) {
      return res.status(403).send('Not your site');
    }

    const sites = await readData('sites');
    const site = sites?.[slug];
    if (!site) return res.status(404).send('Site not found');

    // Fetch HTML from GitHub raw (consistent source for both proxy and edit)
    const { html } = await getSiteHTML(site.githubRepo);
    if (!html) return res.status(500).send('Could not fetch site HTML');

    const $ = cheerio.load(html, { decodeEntities: false });

    // Rewrite relative URLs → absolute on the Render domain
    const base = site.renderUrl.replace(/\/$/, '');
    $('[src]').each((_, el) => {
      const v = $(el).attr('src');
      if (v && !v.startsWith('http') && !v.startsWith('//') && !v.startsWith('data:')) {
        $(el).attr('src', `${base}/${v.replace(/^\//, '')}`);
      }
    });
    $('[href]').each((_, el) => {
      const v = $(el).attr('href');
      if (v && !v.startsWith('http') && !v.startsWith('//') && !v.startsWith('#') && !v.startsWith('mailto:') && !v.startsWith('tel:')) {
        $(el).attr('href', `${base}/${v.replace(/^\//, '')}`);
      }
    });
    $('[srcset]').each((_, el) => {
      const v = $(el).attr('srcset');
      if (v) {
        const fixed = v.replace(/([^,\s]+)(\s+\d+[wx])/g, (m, url, desc) => {
          if (!url.startsWith('http') && !url.startsWith('//')) {
            return `${base}/${url.replace(/^\//, '')}${desc}`;
          }
          return m;
        });
        $(el).attr('srcset', fixed);
      }
    });

    // Inject data-oc-id on all editable elements
    injectOcIds($);

    // Inject meta tags and editor overlay before </body>
    $('head').append(`
      <meta name="oc-slug" content="${slug}">
      <meta name="oc-token" content="${token}">
      <meta name="oc-business" content="${escapeHtml(site.business)}">
    `);
    $('body').append('<script src="/editor/overlay.js"></script>');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.send($.html());
  } catch (err) {
    console.error('[proxy] error:', err.message);
    res.status(500).send('Error loading site preview');
  }
}

// Inject sequential data-oc-id on all editable elements (every direct-text-bearing element + all images)
function injectOcIds($) {
  const SKIP = new Set(['script','style','head','meta','link','noscript','template','svg','path','br','hr','input','textarea','select','button']);
  let idx = 1;
  $('body *').each((_, el) => {
    const tag = el.tagName?.toLowerCase();
    if (!tag || SKIP.has(tag)) return;
    const $el = $(el);
    if (tag === 'img') {
      if (!$el.attr('data-oc-id')) { $el.attr('data-oc-id', `oc-${String(idx).padStart(4, '0')}`); idx++; }
      return;
    }
    const hasDirectText = $el.contents().filter((_, n) => n.type === 'text' && n.data.trim().length > 0).length > 0;
    if (hasDirectText && !$el.attr('data-oc-id')) {
      $el.attr('data-oc-id', `oc-${String(idx).padStart(4, '0')}`); idx++;
    }
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = router;
module.exports.proxyHandler = proxyHandler;
