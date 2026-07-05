/**
 * Working-draft layer for the studio (Wix-style "edit → Publish").
 * All studio edits mutate a per-site draft (stored in the portal repo under
 * data/drafts.json). The live site only changes when the client hits Publish.
 * A capped history enables Undo.
 */
const { readData, writeData, getSiteHTML } = require('./github-data');

const MAX_HISTORY = 25;

async function getWorking(slug, site) {
  const drafts = (await readData('drafts')) || {};
  if (drafts[slug] && typeof drafts[slug].html === 'string') return drafts[slug].html;
  const { html } = await getSiteHTML(site.githubRepo);
  return html;
}

async function saveWorking(slug, newHtml, prevHtml) {
  const drafts = (await readData('drafts')) || {};
  const cur = drafts[slug] || { history: [] };
  const history = cur.history || [];
  if (prevHtml != null) {
    history.push(prevHtml);
    while (history.length > MAX_HISTORY) history.shift();
  }
  drafts[slug] = { html: newHtml, history, updatedAt: new Date().toISOString() };
  await writeData('drafts', drafts, `Draft update for ${slug}`);
}

async function draftState(slug) {
  const drafts = (await readData('drafts')) || {};
  const d = drafts[slug];
  return { hasDraft: !!(d && typeof d.html === 'string'), canUndo: !!(d && d.history && d.history.length) };
}

async function undo(slug) {
  const drafts = (await readData('drafts')) || {};
  const d = drafts[slug];
  if (!d || !d.history || !d.history.length) return false;
  d.html = d.history.pop();
  d.updatedAt = new Date().toISOString();
  drafts[slug] = d;
  await writeData('drafts', drafts, `Undo for ${slug}`);
  return true;
}

async function discard(slug) {
  const drafts = (await readData('drafts')) || {};
  if (!drafts[slug]) return;
  delete drafts[slug];
  await writeData('drafts', drafts, `Discard draft for ${slug}`);
}

module.exports = { getWorking, saveWorking, draftState, undo, discard };
