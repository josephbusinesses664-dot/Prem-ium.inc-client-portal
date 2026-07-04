const router = require('express').Router();
const cheerio = require('cheerio');
const fetch = require('node-fetch');
const { requireAuth, requireSiteAccess } = require('../middleware/auth');
const { readData, writeData, getSiteHTML, putSiteHTML, putSiteImage } = require('../lib/github-data');
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

// POST /:slug/duplicate — clone an item (menu card, list row, etc.) keeping its
// styling, insert the copy right after, so clients can extend a section.
router.post('/:slug/duplicate', requireSiteAccess, async (req, res) => {
  const { slug } = req.params;
  const { ocId } = req.body;
  if (!ocId) return res.status(400).json({ error: 'Missing ocId' });

  try {
    const sites = await readData('sites');
    const site = sites?.[slug];
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const { html, sha } = await getSiteHTML(site.githubRepo);
    if (!html) return res.status(500).json({ error: 'Could not fetch site HTML' });

    const $ = cheerio.load(html, { decodeEntities: false });
    injectOcIds($);

    const el = $(`[data-oc-id="${ocId}"]`);
    if (!el.length) return res.status(404).json({ error: 'Element not found' });

    // Walk up to the nearest "item" — a repeated block (li, or a child whose
    // parent has siblings of the same tag). Falls back to the element itself.
    let item = el;
    const climb = el.parents().toArray();
    for (const p of [el.get(0), ...climb]) {
      const $p = $(p);
      const tag = p.tagName?.toLowerCase();
      if (!tag || tag === 'body' || tag === 'section' || tag === 'main') break;
      const sameSibs = $p.siblings(tag).length;
      if (tag === 'li' || sameSibs >= 1) { item = $p; break; }
      item = $p;
    }

    const clone = $(item.get(0)).clone();
    clone.removeAttr('data-oc-id');
    clone.find('[data-oc-id]').removeAttr('data-oc-id');
    // Blank out cloned images so the copy is obviously new/empty
    if (clone.is('img')) clone.attr('src', '');
    clone.find('img').attr('src', '');
    item.after('\n').after(clone);

    $('[data-oc-id]').removeAttr('data-oc-id');
    const commitMsg = `Client add [${req.user.username}]: ${site.business} — duplicated a ${item.get(0).tagName?.toLowerCase()} section item`;
    const result = await putSiteHTML(site.githubRepo, $.html(), sha, commitMsg);
    const commitUrl = `https://github.com/${GH_ORG}/${site.githubRepo}/commit/${result?.commit?.sha || ''}`;

    await discord.notify(`➕ **${site.business}** — \`${req.user.username}\` added a new item to a section\n📝 ${commitUrl}`);
    res.json({ ok: true, commitUrl });
  } catch (err) {
    console.error('[sites] duplicate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /:slug/remove — delete an item the client no longer wants
router.post('/:slug/remove', requireSiteAccess, async (req, res) => {
  const { slug } = req.params;
  const { ocId } = req.body;
  if (!ocId) return res.status(400).json({ error: 'Missing ocId' });

  try {
    const sites = await readData('sites');
    const site = sites?.[slug];
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const { html, sha } = await getSiteHTML(site.githubRepo);
    if (!html) return res.status(500).json({ error: 'Could not fetch site HTML' });

    const $ = cheerio.load(html, { decodeEntities: false });
    injectOcIds($);

    const el = $(`[data-oc-id="${ocId}"]`);
    if (!el.length) return res.status(404).json({ error: 'Element not found' });

    let item = el;
    const climb = el.parents().toArray();
    for (const p of [el.get(0), ...climb]) {
      const $p = $(p);
      const tag = p.tagName?.toLowerCase();
      if (!tag || tag === 'body' || tag === 'section' || tag === 'main') break;
      const sameSibs = $p.siblings(tag).length;
      if (tag === 'li' || sameSibs >= 1) { item = $p; break; }
      item = $p;
    }
    item.remove();

    $('[data-oc-id]').removeAttr('data-oc-id');
    const commitMsg = `Client remove [${req.user.username}]: ${site.business} — deleted a section item`;
    const result = await putSiteHTML(site.githubRepo, $.html(), sha, commitMsg);
    const commitUrl = `https://github.com/${GH_ORG}/${site.githubRepo}/commit/${result?.commit?.sha || ''}`;

    await discord.notify(`➖ **${site.business}** — \`${req.user.username}\` removed a section item\n📝 ${commitUrl}`);
    res.json({ ok: true, commitUrl });
  } catch (err) {
    console.error('[sites] remove error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Section-level operations (studio Sections tab) ─────────────────────────────
// Sections = top-level content blocks (header/section/footer, direct children of
// body or a single wrapping <main>). Same cheerio+commit pattern as edit/duplicate.

const DRY = () => process.env.CUSTOMIZE_DRY_RUN === '1';

async function sectionOp(req, res, verb, apply) {
  const { slug } = req.params;
  const { sectionId } = req.body;
  if (!sectionId) return res.status(400).json({ error: 'Missing sectionId' });
  try {
    const sites = await readData('sites');
    const site = sites?.[slug];
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const { html, sha } = await getSiteHTML(site.githubRepo);
    if (!html) return res.status(500).json({ error: 'Could not fetch site HTML' });

    const $ = cheerio.load(html, { decodeEntities: false });
    injectOcSecs($);
    const el = $(`[data-oc-sec="${sectionId}"]`);
    if (!el.length) return res.status(404).json({ error: 'Section not found' });

    const problem = apply($, el);
    if (problem) return res.status(400).json({ error: problem });

    $('[data-oc-sec]').removeAttr('data-oc-sec');
    $('[data-oc-id]').removeAttr('data-oc-id');

    if (DRY()) return res.json({ ok: true, dryRun: true });

    const msg = `Client ${verb} [${req.user.username}]: ${site.business}`;
    const result = await putSiteHTML(site.githubRepo, $.html(), sha, msg);
    const commitUrl = `https://github.com/${GH_ORG}/${site.githubRepo}/commit/${result?.commit?.sha || ''}`;
    await discord.notify(`✎ **${site.business}** — \`${req.user.username}\` ${verb}\n📝 ${commitUrl}`);
    res.json({ ok: true, commitUrl });
  } catch (err) {
    console.error(`[sites] section ${verb} error:`, err.message);
    res.status(500).json({ error: err.message });
  }
}

router.post('/:slug/section/move', requireSiteAccess, (req, res) =>
  sectionOp(req, res, 'moved a section', ($, el) => {
    const dir = req.body.dir;
    const sib = dir === 'up' ? el.prev('[data-oc-sec]') : el.next('[data-oc-sec]');
    if (!sib.length) return `Already at the ${dir === 'up' ? 'top' : 'bottom'}`;
    if (dir === 'up') el.insertBefore(sib); else el.insertAfter(sib);
  }));

router.post('/:slug/section/duplicate', requireSiteAccess, (req, res) =>
  sectionOp(req, res, 'duplicated a section', ($, el) => {
    const clone = $(el.get(0)).clone();
    clone.removeAttr('data-oc-sec');
    el.after('\n').after(clone);
  }));

router.post('/:slug/section/remove', requireSiteAccess, (req, res) =>
  sectionOp(req, res, 'removed a section', ($, el) => {
    if ($('[data-oc-sec]').length <= 1) return 'Cannot delete the only section';
    el.remove();
  }));

// ── Design / theme (studio Design tab) ─────────────────────────────────────────
// Injects one managed <style id="oc-theme"> block (between markers) into <head>.
// Fonts apply reliably everywhere; colors set --oc-* vars (full effect on sites
// that use them) plus a best-effort accent layer for links/buttons on legacy sites.

const T_START = '<!-- OC-THEME:START -->';
const T_END = '<!-- OC-THEME:END -->';

const FONT_SPECS = {
  'Fraunces': 'Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700',
  'Playfair Display': 'Playfair+Display:wght@500;600;700;800',
  'Cormorant Garamond': 'Cormorant+Garamond:wght@500;600;700',
  'DM Serif Display': 'DM+Serif+Display',
  'Space Grotesk': 'Space+Grotesk:wght@400;500;600;700',
  'Syne': 'Syne:wght@500;600;700;800',
  'Poppins': 'Poppins:wght@400;500;600;700',
  'Inter': 'Inter:wght@400;500;600;700',
  'Work Sans': 'Work+Sans:wght@400;500;600;700',
  'DM Sans': 'DM+Sans:wght@400;500;600;700',
  'Nunito Sans': 'Nunito+Sans:wght@400;600;700',
  'Lato': 'Lato:wght@400;700',
  'system-ui': null,
};
const FONTS = Object.keys(FONT_SPECS);
const hex = (v, d) => (/^#[0-9a-fA-F]{3,8}$/.test(String(v)) ? v : d);
const qf = f => (f === 'system-ui' ? 'system-ui' : `'${f}'`);

function themeFontLink(fonts) {
  const specs = [...new Set(fonts)].map(f => FONT_SPECS[f]).filter(Boolean);
  return specs.length ? `<link href="https://fonts.googleapis.com/css2?family=${specs.join('&family=')}&display=swap" rel="stylesheet">` : '';
}

function buildThemeBlock(t) {
  const c = t.colors || {};
  const bg = hex(c.bg, '#ffffff'), surface = hex(c.surface, bg), text = hex(c.text, '#222222');
  const accent = hex(c.accent, '#b0563d'), ink = hex(c.accentInk, '#ffffff'), border = hex(c.border, '#e6e6e6');
  const hf = FONTS.includes(t.headingFont) ? t.headingFont : 'Fraunces';
  const bf = FONTS.includes(t.bodyFont) ? t.bodyFont : 'Inter';
  const accentLayer = t.accentOn === false ? '' :
    `a:not([class]){color:${accent};}\n` +
    `.btn,[class*="btn"],button:not([class*="close"]):not([class*="nav"]){background-color:${accent};border-color:${accent};color:${ink};}`;
  const baseLayer = t.baseOn ? `body{background:${bg};color:${text};}` : '';
  return `${T_START}\n${themeFontLink([hf, bf])}\n<style id="oc-theme">\n` +
    `:root{--oc-bg:${bg};--oc-surface:${surface};--oc-text:${text};--oc-accent:${accent};--oc-accent-ink:${ink};--oc-border:${border};--oc-heading-font:${qf(hf)};--oc-body-font:${qf(bf)};}\n` +
    `body{font-family:${qf(bf)},system-ui,sans-serif !important;}\n` +
    `h1,h2,h3,h4,h5,h6,.title,[class*="title"],[class*="heading"]{font-family:${qf(hf)},Georgia,serif !important;}\n` +
    `${baseLayer}\n${accentLayer}\n</style>\n${T_END}`;
}

// GET saved theme
router.get('/:slug/theme', requireSiteAccess, async (req, res) => {
  try {
    const all = (await readData('customizations')) || {};
    res.json((all[req.params.slug] && all[req.params.slug].theme) || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST theme — ?dry=1 returns the block for live preview; otherwise inject + persist
router.post('/:slug/theme', requireSiteAccess, async (req, res) => {
  const { slug } = req.params;
  const t = req.body || {};
  try {
    const block = buildThemeBlock(t);
    if (req.query.dry === '1' || DRY()) return res.json({ ok: true, dryRun: true, block });

    const sites = await readData('sites');
    const site = sites?.[slug];
    if (!site) return res.status(404).json({ error: 'Site not found' });
    const { html, sha } = await getSiteHTML(site.githubRepo);
    if (!html) return res.status(500).json({ error: 'Could not fetch site HTML' });

    let patched;
    if (html.includes(T_START)) patched = html.replace(new RegExp(`${T_START}[\\s\\S]*?${T_END}`), block);
    else patched = html.replace(/<\/head>/i, `${block}\n</head>`);
    await putSiteHTML(site.githubRepo, patched, sha, `Design: theme update for ${site.business}`);

    const all = (await readData('customizations')) || {};
    all[slug] = { ...(all[slug] || {}), theme: t };
    await writeData('customizations', all, `Theme config for ${slug}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

    // canvas=1 → also mark top-level sections (studio Sections tab)
    if (req.query.canvas) injectOcSecs($);

    // raw=1 → clean proxied HTML (used by the customize studio live preview)
    if (!req.query.raw) {
      // Inject meta tags and editor overlay before </body>
      $('head').append(`
        <meta name="oc-slug" content="${slug}">
        <meta name="oc-token" content="${token}">
        <meta name="oc-business" content="${escapeHtml(site.business)}">
      `);
      $('body').append('<script src="/editor/overlay.js"></script>');
    }

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

// Mark top-level content blocks so the studio can reorder/duplicate/delete them.
function injectOcSecs($) {
  const body = $('body');
  const main = body.children('main');
  const container = main.length === 1 ? main : body;
  let idx = 1;
  container.children('header, section, footer').each((_, el) => {
    const $el = $(el);
    if (!$el.attr('data-oc-sec')) { $el.attr('data-oc-sec', `sec-${String(idx).padStart(3, '0')}`); idx++; }
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = router;
module.exports.proxyHandler = proxyHandler;
