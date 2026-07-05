/**
 * Working-draft layer for the studio (Wix-style "edit → Publish").
 * All studio edits mutate a per-site, per-page draft (stored in the portal repo
 * under data/drafts.json). The live site only changes when the client hits
 * Publish. A capped history enables Undo.
 *
 * Drafts are keyed by `${slug}::${page}` so multi-page sites draft each page
 * independently.
 */
const { readData, writeData, getSiteHTML } = require('./github-data');

const MAX_HISTORY = 25;
const key = (slug, page = 'index.html') => `${slug}::${page}`;

async function getWorking(slug, site, page = 'index.html') {
  const d = (await readData('drafts')) || {};
  const rec = d[key(slug, page)];
  if (rec && typeof rec.html === 'string') return rec.html;
  const { html } = await getSiteHTML(site.githubRepo, page);
  return html;
}

async function saveWorking(slug, newHtml, prevHtml, page = 'index.html') {
  const d = (await readData('drafts')) || {};
  const k = key(slug, page);
  const cur = d[k] || { history: [] };
  const history = cur.history || [];
  if (prevHtml != null) {
    history.push(prevHtml);
    while (history.length > MAX_HISTORY) history.shift();
  }
  d[k] = { html: newHtml, history, updatedAt: new Date().toISOString() };
  await writeData('drafts', d, `Draft update for ${k}`);
}

async function draftState(slug, page = 'index.html') {
  const d = (await readData('drafts')) || {};
  const rec = d[key(slug, page)];
  return { hasDraft: !!(rec && typeof rec.html === 'string'), canUndo: !!(rec && rec.history && rec.history.length) };
}

async function undo(slug, page = 'index.html') {
  const d = (await readData('drafts')) || {};
  const rec = d[key(slug, page)];
  if (!rec || !rec.history || !rec.history.length) return false;
  rec.html = rec.history.pop();
  rec.updatedAt = new Date().toISOString();
  d[key(slug, page)] = rec;
  await writeData('drafts', d, `Undo for ${key(slug, page)}`);
  return true;
}

async function discard(slug, page = 'index.html') {
  const d = (await readData('drafts')) || {};
  const k = key(slug, page);
  if (!d[k]) return;
  delete d[k];
  await writeData('drafts', d, `Discard draft for ${k}`);
}

module.exports = { getWorking, saveWorking, draftState, undo, discard };
