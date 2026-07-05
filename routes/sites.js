const router = require('express').Router();
const cheerio = require('cheerio');
const fetch = require('node-fetch');
const { requireAuth, requireSiteAccess } = require('../middleware/auth');
const { readData, writeData, getSiteHTML, putSiteHTML, putSiteImage, listSitePages, listFileCommits, getFileAtRef } = require('../lib/github-data');
const drafts = require('../lib/drafts');
const discord = require('../lib/discord');

const GH_ORG = process.env.GITHUB_ORG || 'josephbusinesses664-dot';

// GET /api/sites — public list of all sites
router.get('/', async (req, res) => {
  try {
    const sites = await readData('sites');
    if (!sites) return res.json({});
    const pub = {};
    for (const [slug, s] of Object.entries(sites)) {
      pub[slug] = { business: s.business, city: s.city, category: s.category, renderUrl: s.renderUrl };
    }
    res.json(pub);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sites/:slug — single site detail (auth required)
router.get('/:slug', requireAuth, async (req, res) => {
  try {
    const sites = await readData('sites');
    const site = sites?.[req.params.slug];
    if (!site) return res.status(404).json({ error: 'Site not found' });
    if (req.user.role !== 'admin' && req.user.siteSlug !== req.params.slug) {
      return res.status(403).json({ error: 'Not your site' });
    }
    res.json(site);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Draft mutation helper ───────────────────────────────────────────────────────
// Every studio edit runs through here: load the working draft, mutate it with
// cheerio, and save it back to the draft (NOT the live site). Live only changes
// on Publish. mutate($, site) may be async, and may return { error, status } or
// extra fields to merge into the JSON response.
// Restrict page to a bare .html filename in the repo root (no path traversal).
function safePage(p) {
  const v = String(p || 'index.html');
  return /^[\w.-]+\.html?$/i.test(v) && !v.includes('..') ? v : 'index.html';
}

async function opDraft(req, res, mutate) {
  try {
    const { slug } = req.params;
    const page = safePage(req.body.page);
    const sites = await readData('sites');
    const site = sites?.[slug];
    if (!site) return res.status(404).json({ error: 'Site not found' });
    const html = await drafts.getWorking(slug, site, page);
    if (!html) return res.status(500).json({ error: 'Could not load site HTML' });

    const $ = cheerio.load(html, { decodeEntities: false });
    injectOcIds($);
    injectOcSecs($);
    const extra = await mutate($, site);
    if (extra && extra.error) return res.status(extra.status || 400).json({ error: extra.error });
    $('[data-oc-id]').removeAttr('data-oc-id');
    $('[data-oc-sec]').removeAttr('data-oc-sec');
    await drafts.saveWorking(slug, $.html(), html, page);
    res.json({ ok: true, draft: true, ...(extra || {}) });
  } catch (err) {
    console.error('[sites] op error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// Find the nearest repeated "item" ancestor for an element (menu card, list row).
function climbToItem($, el) {
  let item = el;
  for (const p of [el.get(0), ...el.parents().toArray()]) {
    const $p = $(p);
    const tag = p.tagName?.toLowerCase();
    if (!tag || tag === 'body' || tag === 'section' || tag === 'main') break;
    if (tag === 'li' || $p.siblings(tag).length >= 1) { item = $p; break; }
    item = $p;
  }
  return item;
}

function normalizeHref(v) {
  const s = String(v || '').trim();
  if (!s) return '#';
  if (/^(https?:|mailto:|tel:|#|\/)/i.test(s)) return s;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return 'mailto:' + s;
  if (/^[+()\d][\d\s()+-]{5,}$/.test(s)) return 'tel:' + s.replace(/\s+/g, '');
  return 'https://' + s;
}

// Sanitize rich-text HTML to a safe inline subset (strips scripts/handlers/etc.)
const RICH_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'br', 'a', 'span', 'p', 'div']);
const RICH_STYLE = new Set(['color', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-align']);
function sanitizeRich(dirty) {
  const $ = cheerio.load(`<div id="__ocr">${dirty || ''}</div>`, { decodeEntities: false });
  $('#__ocr *').each((_, el) => {
    const $el = $(el);
    const tag = el.tagName?.toLowerCase();
    if (!RICH_TAGS.has(tag)) { $el.replaceWith($el.contents()); return; }
    Object.keys(el.attribs || {}).forEach(a => {
      if (tag === 'a' && a === 'href') {
        const h = $el.attr('href') || '';
        if (!/^(https?:|mailto:|tel:|#|\/)/i.test(h)) $el.removeAttr('href');
      } else if (a === 'style') {
        const safe = [];
        ($el.attr('style') || '').split(';').forEach(decl => {
          const i = decl.indexOf(':'); if (i < 0) return;
          const k = decl.slice(0, i).trim().toLowerCase(), v = decl.slice(i + 1).trim();
          if (RICH_STYLE.has(k) && v && !/url\(|expression|javascript:/i.test(v)) safe.push(`${k}:${v}`);
        });
        if (safe.length) $el.attr('style', safe.join(';')); else $el.removeAttr('style');
      } else {
        $el.removeAttr(a);
      }
    });
    if (tag === 'a') $el.attr('target', '_blank');
  });
  return $('#__ocr').html();
}

// ── Element edit (text / image / map / rich HTML / link destination) ────────────
router.post('/:slug/edit', requireSiteAccess, (req, res) => opDraft(req, res, async ($, site) => {
  const { ocId, newValue, isImage, isMap, isHtml, align, linkHref } = req.body;
  if (!ocId) return { error: 'Missing ocId' };
  const el = $(`[data-oc-id="${ocId}"]`);
  if (!el.length) return { error: 'Element not found', status: 404 };
  const tag = el.prop('tagName').toLowerCase();

  // Link destination (independent of text)
  if (linkHref !== undefined) {
    const a = el.is('a') ? el : el.find('a').first();
    if (!a.length) return { error: 'That element has no link to point' };
    a.attr('href', normalizeHref(linkHref));
  }

  if (newValue !== undefined && newValue !== null) {
    if (isMap || (tag === 'iframe' && /google\.com\/maps|maps\.google/.test(el.attr('src') || ''))) {
      const q = encodeURIComponent(String(newValue).trim()).replace(/%20/g, '+');
      el.attr('src', `https://www.google.com/maps?q=${q}&output=embed`);
    } else if (isImage || tag === 'img') {
      if (String(newValue).startsWith('data:')) {
        const m = String(newValue).match(/^data:([^;]+);base64,(.+)$/);
        if (!m) return { error: 'Invalid image data' };
        const ext = m[1].split('/')[1] || 'jpg';
        const fn = `client-${Date.now()}.${ext}`;
        await putSiteImage(site.githubRepo, fn, m[2], null);
        el.attr('src', `images/${fn}`);
      } else {
        el.attr('src', newValue);
      }
    } else if (isHtml) {
      el.html(sanitizeRich(newValue));
      if (align) el.css('text-align', align);
    } else {
      el.text(newValue);
      if (align) el.css('text-align', align);
    }
  } else if (align) {
    el.css('text-align', align);
  }
}));

// ── Duplicate / remove an item within a section ─────────────────────────────────
router.post('/:slug/duplicate', requireSiteAccess, (req, res) => opDraft(req, res, ($) => {
  const { ocId } = req.body;
  if (!ocId) return { error: 'Missing ocId' };
  const el = $(`[data-oc-id="${ocId}"]`);
  if (!el.length) return { error: 'Element not found', status: 404 };
  const item = climbToItem($, el);
  const clone = $(item.get(0)).clone();
  clone.removeAttr('data-oc-id');
  clone.find('[data-oc-id]').removeAttr('data-oc-id');
  if (clone.is('img')) clone.attr('src', '');
  clone.find('img').attr('src', '');
  item.after('\n').after(clone);
}));

router.post('/:slug/remove', requireSiteAccess, (req, res) => opDraft(req, res, ($) => {
  const { ocId } = req.body;
  if (!ocId) return { error: 'Missing ocId' };
  const el = $(`[data-oc-id="${ocId}"]`);
  if (!el.length) return { error: 'Element not found', status: 404 };
  climbToItem($, el).remove();
}));

// ── Section operations ──────────────────────────────────────────────────────────
function sectionRoute(applyFn) {
  return (req, res) => opDraft(req, res, ($, site) => {
    const { sectionId } = req.body;
    if (!sectionId) return { error: 'Missing sectionId' };
    const el = $(`[data-oc-sec="${sectionId}"]`);
    if (!el.length) return { error: 'Section not found', status: 404 };
    return applyFn($, el, site);
  });
}

router.post('/:slug/section/move', requireSiteAccess, (req, res) => opDraft(req, res, ($) => {
  const { sectionId, dir } = req.body;
  if (!sectionId) return { error: 'Missing sectionId' };
  const el = $(`[data-oc-sec="${sectionId}"]`);
  if (!el.length) return { error: 'Section not found', status: 404 };
  const sib = dir === 'up' ? el.prev('[data-oc-sec]') : el.next('[data-oc-sec]');
  if (!sib.length) return { error: `Already at the ${dir === 'up' ? 'top' : 'bottom'}` };
  if (dir === 'up') el.insertBefore(sib); else el.insertAfter(sib);
}));

router.post('/:slug/section/duplicate', requireSiteAccess, sectionRoute(($, el) => {
  const clone = $(el.get(0)).clone();
  clone.removeAttr('data-oc-sec');
  el.after('\n').after(clone);
}));

router.post('/:slug/section/remove', requireSiteAccess, sectionRoute(($, el) => {
  if ($('[data-oc-sec]').length <= 1) return { error: 'Cannot delete the only section' };
  el.remove();
}));

// Reorder sections to match a given order of section ids
router.post('/:slug/section/reorder', requireSiteAccess, (req, res) => opDraft(req, res, ($) => {
  const order = req.body.order;
  if (!Array.isArray(order) || !order.length) return { error: 'Missing order' };
  if (!$(`[data-oc-sec="${order[0]}"]`).length) return { error: 'Section not found', status: 404 };
  // Re-query fresh each step — a moved cheerio ref goes stale and drops nodes.
  for (let i = 1; i < order.length; i++) {
    const node = $(`[data-oc-sec="${order[i]}"]`);
    const prevNode = $(`[data-oc-sec="${order[i - 1]}"]`);
    if (node.length && prevNode.length) node.insertAfter(prevNode);
  }
}));

// Set a section's background (color and/or uploaded image)
router.post('/:slug/section/style', requireSiteAccess, (req, res) => opDraft(req, res, async ($, site) => {
  const { sectionId, bg, bgImage } = req.body;
  if (!sectionId) return { error: 'Missing sectionId' };
  const el = $(`[data-oc-sec="${sectionId}"]`);
  if (!el.length) return { error: 'Section not found', status: 404 };
  if (bg) el.css('background', bg);
  if (bgImage && String(bgImage).startsWith('data:')) {
    const m = String(bgImage).match(/^data:([^;]+);base64,(.+)$/);
    if (m) {
      const ext = m[1].split('/')[1] || 'jpg';
      const fn = `bg-${Date.now()}.${ext}`;
      await putSiteImage(site.githubRepo, fn, m[2], null);
      el.css('background-image', `url('images/${fn}')`);
      el.css('background-size', 'cover');
      el.css('background-position', 'center');
    }
  }
}));

// ── Section template library ("+ Add section") ─────────────────────────────────
const PLACEHOLDER_IMG = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='400'%20height='300'%3E%3Crect%20width='400'%20height='300'%20fill='%23e8e3da'/%3E%3Ctext%20x='200'%20y='158'%20font-family='sans-serif'%20font-size='17'%20fill='%239a8f80'%20text-anchor='middle'%3EYour%20photo%3C/text%3E%3C/svg%3E";
const _h = 'font-family:var(--oc-heading-font,Georgia),serif';
const _card = 'background:#fff;border:1px solid var(--oc-border,#ececec);border-radius:14px;padding:24px';

const SECTION_TEMPLATES = {
  hero: `<section style="padding:84px 24px;text-align:center;background:var(--oc-surface,#faf9f6)"><div style="max-width:760px;margin:0 auto"><h1 style="${_h};font-size:clamp(32px,6vw,54px);margin:0 0 16px;color:var(--oc-text,#222)">Your headline here</h1><p style="font-size:18px;line-height:1.6;color:var(--oc-text,#555);margin:0 0 28px">A short, compelling sentence about your business goes right here.</p><a href="#" style="display:inline-block;background:var(--oc-accent,#b0563d);color:var(--oc-accent-ink,#fff);padding:14px 30px;border-radius:10px;text-decoration:none;font-weight:600">Get started</a></div></section>`,
  about: `<section style="padding:72px 24px;background:#fff"><div style="max-width:720px;margin:0 auto"><p style="text-transform:uppercase;letter-spacing:.08em;font-size:13px;font-weight:700;color:var(--oc-accent,#b0563d);margin:0 0 12px">Our story</p><h2 style="${_h};font-size:30px;margin:0 0 16px;color:var(--oc-text,#222)">A little about us</h2><p style="font-size:16px;line-height:1.7;color:var(--oc-text,#444)">Tell your customers who you are, what you do, and why you do it. Two or three warm, honest sentences work best here.</p></div></section>`,
  features: `<section style="padding:72px 24px;background:var(--oc-surface,#faf9f6)"><div style="max-width:1000px;margin:0 auto"><h2 style="${_h};font-size:28px;text-align:center;margin:0 0 40px;color:var(--oc-text,#222)">What we offer</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:22px"><div style="${_card}"><h3 style="${_h};margin:0 0 8px;color:var(--oc-text,#222)">Feature one</h3><p style="color:var(--oc-text,#555);line-height:1.6;margin:0">Describe this feature in a sentence or two.</p></div><div style="${_card}"><h3 style="${_h};margin:0 0 8px;color:var(--oc-text,#222)">Feature two</h3><p style="color:var(--oc-text,#555);line-height:1.6;margin:0">Describe this feature in a sentence or two.</p></div><div style="${_card}"><h3 style="${_h};margin:0 0 8px;color:var(--oc-text,#222)">Feature three</h3><p style="color:var(--oc-text,#555);line-height:1.6;margin:0">Describe this feature in a sentence or two.</p></div></div></div></section>`,
  menu: `<section style="padding:72px 24px;background:#fff"><div style="max-width:720px;margin:0 auto"><h2 style="${_h};font-size:28px;text-align:center;margin:0 0 32px;color:var(--oc-text,#222)">Menu</h2><div style="display:flex;flex-direction:column;gap:16px"><div style="display:flex;justify-content:space-between;gap:16px;border-bottom:1px solid var(--oc-border,#ececec);padding-bottom:14px"><div><h3 style="${_h};margin:0 0 4px;font-size:18px;color:var(--oc-text,#222)">Item name</h3><p style="margin:0;color:var(--oc-text,#666)">Short description of the dish or service.</p></div><span style="font-weight:700;color:var(--oc-accent,#b0563d)">$0</span></div><div style="display:flex;justify-content:space-between;gap:16px;border-bottom:1px solid var(--oc-border,#ececec);padding-bottom:14px"><div><h3 style="${_h};margin:0 0 4px;font-size:18px;color:var(--oc-text,#222)">Item name</h3><p style="margin:0;color:var(--oc-text,#666)">Short description of the dish or service.</p></div><span style="font-weight:700;color:var(--oc-accent,#b0563d)">$0</span></div></div></div></section>`,
  gallery: `<section style="padding:72px 24px;background:var(--oc-surface,#faf9f6)"><div style="max-width:1000px;margin:0 auto"><h2 style="${_h};font-size:28px;text-align:center;margin:0 0 32px;color:var(--oc-text,#222)">Gallery</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px"><img src="${PLACEHOLDER_IMG}" alt="Gallery photo" style="width:100%;height:210px;object-fit:cover;border-radius:12px"><img src="${PLACEHOLDER_IMG}" alt="Gallery photo" style="width:100%;height:210px;object-fit:cover;border-radius:12px"><img src="${PLACEHOLDER_IMG}" alt="Gallery photo" style="width:100%;height:210px;object-fit:cover;border-radius:12px"></div></div></section>`,
  testimonial: `<section style="padding:72px 24px;background:#fff;text-align:center"><div style="max-width:680px;margin:0 auto"><p style="${_h};font-size:24px;line-height:1.5;color:var(--oc-text,#222);margin:0 0 18px">“A glowing customer quote goes right here — it builds trust fast.”</p><p style="font-weight:600;color:var(--oc-accent,#b0563d);margin:0">— Happy Customer</p></div></section>`,
  contact: `<section style="padding:72px 24px;background:var(--oc-surface,#faf9f6)"><div style="max-width:760px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:32px"><div><h3 style="${_h};font-size:20px;margin:0 0 10px;color:var(--oc-text,#222)">Visit us</h3><p style="color:var(--oc-text,#555);line-height:1.7;margin:0">123 Main Street<br>Your City, ST 00000</p></div><div><h3 style="${_h};font-size:20px;margin:0 0 10px;color:var(--oc-text,#222)">Hours</h3><p style="color:var(--oc-text,#555);line-height:1.7;margin:0">Mon–Fri: 9am – 6pm<br>Sat–Sun: 10am – 4pm</p></div></div></section>`,
  cta: `<section style="padding:64px 24px;text-align:center;background:var(--oc-accent,#b0563d)"><div style="max-width:640px;margin:0 auto"><h2 style="${_h};font-size:30px;color:var(--oc-accent-ink,#fff);margin:0 0 14px">Ready to get started?</h2><a href="#" style="display:inline-block;background:var(--oc-accent-ink,#fff);color:var(--oc-accent,#b0563d);padding:13px 28px;border-radius:10px;text-decoration:none;font-weight:700">Contact us</a></div></section>`,
  map: `<section style="padding:72px 24px;background:var(--oc-surface,#faf9f6)"><div style="max-width:900px;margin:0 auto"><h2 style="${_h};font-size:28px;text-align:center;margin:0 0 10px;color:var(--oc-text,#222)">Find us</h2><p style="text-align:center;color:var(--oc-text,#555);margin:0 0 20px">123 Main Street, Your City, ST 00000</p><div style="border-radius:14px;overflow:hidden;border:1px solid var(--oc-border,#e6e6e6)"><iframe src="https://www.google.com/maps?q=Times+Square,+New+York&output=embed" width="100%" height="380" style="border:0;display:block" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe></div></div></section>`,
};

// Small elements to add inside an existing section
const ELEMENT_TEMPLATES = {
  heading: `<h2 style="${_h};font-size:26px;color:var(--oc-text,#222);margin:24px auto 12px;max-width:900px">New heading</h2>`,
  paragraph: `<p style="font-size:16px;line-height:1.7;color:var(--oc-text,#555);margin:12px auto;max-width:760px">New paragraph — click to edit this text and say whatever you like.</p>`,
  button: `<div style="text-align:center;margin:20px auto"><a href="#" style="display:inline-block;background:var(--oc-accent,#b0563d);color:var(--oc-accent-ink,#fff);padding:12px 26px;border-radius:10px;text-decoration:none;font-weight:600">New button</a></div>`,
  image: `<div style="text-align:center;margin:20px auto;max-width:760px"><img src="${PLACEHOLDER_IMG}" alt="New image" style="max-width:100%;border-radius:12px"></div>`,
};

router.post('/:slug/section/add', requireSiteAccess, (req, res) => opDraft(req, res, ($) => {
  const { template, afterSectionId } = req.body;
  const tpl = SECTION_TEMPLATES[template];
  if (!tpl) return { error: 'Unknown section template' };
  const anchor = afterSectionId ? $(`[data-oc-sec="${afterSectionId}"]`) : null;
  if (anchor && anchor.length) anchor.after('\n' + tpl);
  else {
    const body = $('body');
    const main = body.children('main');
    (main.length === 1 ? main : body).append('\n' + tpl);
  }
}));

router.post('/:slug/element/add', requireSiteAccess, (req, res) => opDraft(req, res, ($) => {
  const { sectionId, kind } = req.body;
  const snippet = ELEMENT_TEMPLATES[kind];
  if (!snippet) return { error: 'Unknown element' };
  const sec = sectionId ? $(`[data-oc-sec="${sectionId}"]`) : null;
  if (sec && sec.length) {
    const inner = sec.children().first();
    (inner.length ? inner : sec).append('\n' + snippet);
  } else {
    return { error: 'Pick a section first' };
  }
}));

// ── Design / theme ──────────────────────────────────────────────────────────────
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

router.get('/:slug/theme', requireSiteAccess, async (req, res) => {
  try {
    const all = (await readData('customizations')) || {};
    res.json((all[req.params.slug] && all[req.params.slug].theme) || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST theme — ?dry=1 returns the block for live preview; otherwise write to draft
router.post('/:slug/theme', requireSiteAccess, async (req, res) => {
  const { slug } = req.params;
  const t = req.body || {};
  try {
    const block = buildThemeBlock(t);
    if (req.query.dry === '1') return res.json({ ok: true, dryRun: true, block });

    const page = safePage(req.body.page);
    const sites = await readData('sites');
    const site = sites?.[slug];
    if (!site) return res.status(404).json({ error: 'Site not found' });
    const html = await drafts.getWorking(slug, site, page);
    const patched = html.includes(T_START)
      ? html.replace(new RegExp(`${T_START}[\\s\\S]*?${T_END}`), block)
      : html.replace(/<\/head>/i, `${block}\n</head>`);
    await drafts.saveWorking(slug, patched, html, page);

    const all = (await readData('customizations')) || {};
    all[slug] = { ...(all[slug] || {}), theme: t };
    await writeData('customizations', all, `Theme config for ${slug}`);
    res.json({ ok: true, draft: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SEO (auto-generated defaults, editable) ─────────────────────────────────────
router.get('/:slug/seo', requireSiteAccess, async (req, res) => {
  try {
    const { slug } = req.params;
    const page = safePage(req.query.page);
    const sites = await readData('sites');
    const site = sites?.[slug];
    if (!site) return res.status(404).json({ error: 'Site not found' });
    const html = await drafts.getWorking(slug, site, page);
    const $ = cheerio.load(html, { decodeEntities: false });
    let title = $('head title').first().text().trim();
    let desc = ($('meta[name="description"]').attr('content') || '').trim();
    if (!title) title = [site.business, site.category, site.city].filter(Boolean).join(' — ') || site.business || '';
    if (!desc) desc = `${site.business || 'We'}${site.category ? ' — ' + site.category : ''}${site.city ? ' in ' + site.city : ''}. Visit us or get in touch.`;
    res.json({ title, description: desc });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:slug/seo', requireSiteAccess, (req, res) => opDraft(req, res, ($) => {
  const { title, description } = req.body;
  if (title !== undefined) {
    let t = $('head title').first();
    if (!t.length) { $('head').prepend('<title></title>'); t = $('head title').first(); }
    t.text(String(title).slice(0, 120));
    const og = $('meta[property="og:title"]'); if (og.length) og.attr('content', String(title).slice(0, 120));
  }
  if (description !== undefined) {
    let m = $('meta[name="description"]');
    if (!m.length) { $('head').append('<meta name="description" content="">'); m = $('meta[name="description"]'); }
    m.attr('content', String(description).slice(0, 300));
    const od = $('meta[property="og:description"]'); if (od.length) od.attr('content', String(description).slice(0, 300));
  }
}));

// ── Pages ───────────────────────────────────────────────────────────────────────
router.get('/:slug/pages', requireSiteAccess, async (req, res) => {
  try {
    const sites = await readData('sites');
    const site = sites?.[req.params.slug];
    if (!site) return res.status(404).json({ error: 'Site not found' });
    res.json({ pages: await listSitePages(site.githubRepo) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Version history + restore ───────────────────────────────────────────────────
router.get('/:slug/history', requireSiteAccess, async (req, res) => {
  try {
    const sites = await readData('sites');
    const site = sites?.[req.params.slug];
    if (!site) return res.status(404).json({ error: 'Site not found' });
    res.json({ commits: await listFileCommits(site.githubRepo, safePage(req.query.page)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Load a past published version into the working draft (client reviews, then publishes)
router.post('/:slug/restore', requireSiteAccess, async (req, res) => {
  try {
    const { slug } = req.params;
    const { sha } = req.body;
    const page = safePage(req.body.page);
    if (!sha) return res.status(400).json({ error: 'Missing version id' });
    const sites = await readData('sites');
    const site = sites?.[slug];
    if (!site) return res.status(404).json({ error: 'Site not found' });
    const old = await getFileAtRef(site.githubRepo, page, sha);
    const prev = await drafts.getWorking(slug, site, page);
    await drafts.saveWorking(slug, old, prev, page);
    res.json({ ok: true, draft: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Draft workflow: publish / undo / discard / state ────────────────────────────
router.get('/:slug/draft-state', requireSiteAccess, async (req, res) => {
  try { res.json(await drafts.draftState(req.params.slug, safePage(req.query.page))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:slug/undo', requireSiteAccess, async (req, res) => {
  try { const undone = await drafts.undo(req.params.slug, safePage(req.body.page)); res.json({ ok: true, undone }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:slug/discard', requireSiteAccess, async (req, res) => {
  try { await drafts.discard(req.params.slug, safePage(req.body.page)); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:slug/publish', requireSiteAccess, async (req, res) => {
  try {
    const { slug } = req.params;
    const page = safePage(req.body.page);
    const sites = await readData('sites');
    const site = sites?.[slug];
    if (!site) return res.status(404).json({ error: 'Site not found' });
    const st = await drafts.draftState(slug, page);
    if (!st.hasDraft) return res.json({ ok: true, nothing: true });
    const html = await drafts.getWorking(slug, site, page);
    const { sha } = await getSiteHTML(site.githubRepo, page);
    const result = await putSiteHTML(site.githubRepo, html, sha, `Published edits [${req.user.username}]: ${site.business} (${page})`, page);
    await drafts.discard(slug, page);
    const commitUrl = `https://github.com/${GH_ORG}/${site.githubRepo}/commit/${result?.commit?.sha || ''}`;
    await discord.notify(`🚀 **${site.business}** — \`${req.user.username}\` published changes to ${page}\n📝 ${commitUrl}`);
    res.json({ ok: true, commitUrl });
  } catch (err) {
    console.error('[sites] publish error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Proxy handler — serves the working draft (or live) into the studio canvas ────
async function proxyHandler(req, res) {
  const { slug } = req.params;
  const token = req.query.token;
  if (!token) return res.redirect(`/login?next=/preview/${slug}`);

  try {
    const jwt = require('jsonwebtoken');
    const SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod';
    let user;
    try { user = jwt.verify(token, SECRET); }
    catch { return res.redirect(`/login?next=/preview/${slug}`); }
    if (user.role !== 'admin' && user.siteSlug !== slug) return res.status(403).send('Not your site');

    const sites = await readData('sites');
    const site = sites?.[slug];
    if (!site) return res.status(404).send('Site not found');

    const page = safePage(req.query.page);
    const html = req.query.draft
      ? await drafts.getWorking(slug, site, page)
      : (await getSiteHTML(site.githubRepo, page)).html;
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
        $(el).attr('srcset', v.replace(/([^,\s]+)(\s+\d+[wx])/g, (m, url, desc) =>
          (!url.startsWith('http') && !url.startsWith('//')) ? `${base}/${url.replace(/^\//, '')}${desc}` : m));
      }
    });

    injectOcIds($);
    if (req.query.canvas) injectOcSecs($);

    if (!req.query.raw) {
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

// Inject sequential data-oc-id on editable elements (text-bearing els, imgs, map iframes)
function injectOcIds($) {
  const SKIP = new Set(['script', 'style', 'head', 'meta', 'link', 'noscript', 'template', 'svg', 'path', 'br', 'hr', 'input', 'textarea', 'select', 'button']);
  let idx = 1;
  $('body *').each((_, el) => {
    const tag = el.tagName?.toLowerCase();
    if (!tag || SKIP.has(tag)) return;
    const $el = $(el);
    if (tag === 'img') {
      if (!$el.attr('data-oc-id')) { $el.attr('data-oc-id', `oc-${String(idx).padStart(4, '0')}`); idx++; }
      return;
    }
    if (tag === 'iframe') {
      if (/google\.com\/maps|maps\.google/.test($el.attr('src') || '') && !$el.attr('data-oc-id')) {
        $el.attr('data-oc-id', `oc-${String(idx).padStart(4, '0')}`); idx++;
      }
      return;
    }
    const hasDirectText = $el.contents().filter((_, n) => n.type === 'text' && n.data.trim().length > 0).length > 0;
    if (hasDirectText && !$el.attr('data-oc-id')) { $el.attr('data-oc-id', `oc-${String(idx).padStart(4, '0')}`); idx++; }
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
