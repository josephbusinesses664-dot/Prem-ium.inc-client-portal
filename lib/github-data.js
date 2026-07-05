/**
 * GitHub-as-database: users.json, sites.json, requests.json
 * stored in the portal repo itself under data/.
 * All reads/writes go through the GitHub Contents API so data
 * survives Render restarts (ephemeral disk).
 */

const fetch = require('node-fetch');
const bcrypt = require('bcrypt');

const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_ORG   = process.env.GITHUB_ORG   || 'josephbusinesses664-dot';
const PORTAL_REPO = process.env.PORTAL_REPO || 'openclaw-client-portal';

const API = 'https://api.github.com';

function headers() {
  return {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

async function getFile(repo, filePath) {
  const url = `${API}/repos/${GH_ORG}/${repo}/contents/${filePath}`;
  const r = await fetch(url, { headers: headers() });
  if (r.status === 404) return { content: null, sha: null };
  if (!r.ok) throw new Error(`GitHub GET ${filePath}: ${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content, 'base64').toString('utf8');
  return { content, sha: data.sha };
}

async function putFile(repo, filePath, content, sha, message) {
  const url = `${API}/repos/${GH_ORG}/${repo}/contents/${filePath}`;
  const body = {
    message,
    content: Buffer.from(content).toString('base64'),
  };
  if (sha) body.sha = sha;
  const r = await fetch(url, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`GitHub PUT ${filePath}: ${r.status} ${err}`);
  }
  return await r.json();
}

// ── Portal data file helpers ───────────────────────────────────────────────────

async function readData(name) {
  const { content } = await getFile(PORTAL_REPO, `data/${name}.json`);
  return content ? JSON.parse(content) : null;
}

async function writeData(name, data, message) {
  const { sha } = await getFile(PORTAL_REPO, `data/${name}.json`);
  const content = JSON.stringify(data, null, 2);
  return await putFile(PORTAL_REPO, `data/${name}.json`, content, sha, message || `Update ${name}.json`);
}

// ── GA tag injection ──────────────────────────────────────────────────────────

async function injectGaTag(repoName, measurementId) {
  const mid = measurementId || process.env.GA4_MEASUREMENT_ID;
  if (!mid) throw new Error('No GA4_MEASUREMENT_ID configured');

  const { content: html, sha } = await getFile(repoName, 'index.html');
  if (!html) throw new Error('index.html not found in repo');

  if (html.includes('googletagmanager.com')) {
    return { skipped: true, reason: 'already has GA tag' };
  }

  const snippet = `\n<!-- OpenClaw Analytics -->\n<script async src="https://www.googletagmanager.com/gtag/js?id=${mid}"></script>\n<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${mid}');</script>\n`;

  // Inject immediately after <head>
  const patched = html.replace(/(<head[^>]*>)/i, `$1${snippet}`);
  if (patched === html) {
    // Fallback: inject at very top if no <head> found
    return { skipped: true, reason: 'could not find <head> tag' };
  }

  const result = await putFile(repoName, 'index.html', patched, sha, `Analytics: inject GA4 tag (OpenClaw) [${mid}]`);
  return { skipped: false, commitUrl: `https://github.com/${GH_ORG}/${repoName}/commit/${result?.commit?.sha || ''}` };
}

// ── Client site HTML helpers ───────────────────────────────────────────────────

async function getSiteHTML(repoName, page = 'index.html') {
  const { content, sha } = await getFile(repoName, page);
  return { html: content, sha };
}

async function putSiteHTML(repoName, html, sha, commitMsg, page = 'index.html') {
  return await putFile(repoName, page, html, sha, commitMsg);
}

// List editable pages (.html files at the repo root)
async function listSitePages(repoName) {
  const url = `${API}/repos/${GH_ORG}/${repoName}/contents/`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) return ['index.html'];
  const items = await r.json();
  const pages = (Array.isArray(items) ? items : [])
    .filter(f => f.type === 'file' && /\.html?$/i.test(f.name))
    .map(f => f.name);
  // index.html first, then the rest alphabetically
  pages.sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
  return pages.length ? pages : ['index.html'];
}

// Recent commits that touched a given file (for version history)
async function listFileCommits(repoName, page = 'index.html', limit = 15) {
  const url = `${API}/repos/${GH_ORG}/${repoName}/commits?path=${encodeURIComponent(page)}&per_page=${limit}`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) return [];
  const commits = await r.json();
  return (Array.isArray(commits) ? commits : []).map(c => ({
    sha: c.sha,
    message: (c.commit?.message || '').split('\n')[0].slice(0, 100),
    date: c.commit?.author?.date || '',
    author: c.commit?.author?.name || '',
  }));
}

// Fetch a file's content at a specific commit (for restore preview)
async function getFileAtRef(repoName, page, ref) {
  const url = `${API}/repos/${GH_ORG}/${repoName}/contents/${page}?ref=${encodeURIComponent(ref)}`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) throw new Error(`GitHub GET ${page}@${ref}: ${r.status}`);
  const data = await r.json();
  return Buffer.from(data.content, 'base64').toString('utf8');
}

async function putSiteImage(repoName, filename, base64Content, existingSha) {
  const url = `${API}/repos/${GH_ORG}/${repoName}/contents/images/${filename}`;
  const body = {
    message: `Client image upload: ${filename}`,
    content: base64Content,
  };
  if (existingSha) body.sha = existingSha;
  const r = await fetch(url, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Image upload failed: ${r.status}`);
  return await r.json();
}

// ── Site auto-sync ────────────────────────────────────────────────────────────
// Discovers preview-* repos in the org and registers any that are missing
// from sites.json, so newly created client sites appear without manual entry.

const SYNC_EXCLUDE = new Set([
  PORTAL_REPO, 'prem-ium-inc',
  // Duplicate builds of businesses already in sites.json — never re-register
  'preview-1y0nxm', 'preview-50awvv', 'preview-6l8jbs', 'preview-o34fu8',
  'preview-oiox1m', 'preview-w5ygk0', 'preview-yv5zh1',
]);

async function listOrgRepos() {
  const repos = [];
  for (let page = 1; page <= 5; page++) {
    const r = await fetch(`${API}/users/${GH_ORG}/repos?per_page=100&page=${page}`, { headers: headers() });
    if (!r.ok) throw new Error(`GitHub repo list: ${r.status}`);
    const batch = await r.json();
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

async function syncSitesFromGitHub() {
  if (!GH_TOKEN) return { added: [], skipped: 'no token' };

  const [repos, sites] = await Promise.all([listOrgRepos(), readData('sites')]);
  if (!sites) return { added: [], skipped: 'sites.json missing' };

  const known = new Set(Object.values(sites).map(s => s.githubRepo));
  const knownBusinesses = new Set(Object.values(sites).map(s => (s.business || '').toLowerCase().trim()));
  const added = [];

  for (const repo of repos) {
    if (!repo.name.startsWith('preview-')) continue;
    if (SYNC_EXCLUDE.has(repo.name) || known.has(repo.name)) continue;

    const slug = repo.name.replace(/^preview-/, '');
    if (!slug || sites[slug]) continue;

    const business = (repo.description || '')
      .replace(/ preview site$/i, '')
      .replace(/ - Auto-generated preview website$/i, '')
      .trim();

    // No description means no business name — skip rather than register under a random slug
    if (!business) continue;

    // A repo for a business we already list is a duplicate build — don't re-register it
    if (knownBusinesses.has(business.toLowerCase())) continue;
    knownBusinesses.add(business.toLowerCase());

    sites[slug] = {
      business,
      city: '',
      category: 'Business',
      renderUrl: `https://${repo.name}.onrender.com`,
      githubRepo: repo.name,
      phone: '',
      email: '',
      owner: '',
      addedAt: new Date().toISOString().slice(0, 10),
      autoSynced: true,
    };
    added.push(repo.name);
  }

  if (added.length) {
    await writeData('sites', sites, `Auto-sync: register ${added.length} new site(s) — ${added.join(', ')}`);
    console.log(`[sync] Registered ${added.length} new site(s): ${added.join(', ')}`);
  }
  return { added };
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function bootstrap() {
  if (!GH_TOKEN) {
    console.warn('[github-data] GITHUB_TOKEN not set — running in local mode');
    return;
  }

  // Ensure users.json exists with admin account
  let users = await readData('users');
  if (!users) {
    console.log('[github-data] Seeding users.json');
    const adminUsername = process.env.ADMIN_USERNAME || 'prem';
    const adminHash = process.env.ADMIN_PASSWORD_HASH || await bcrypt.hash(process.env.ADMIN_PASSWORD || 'changeme', 10);
    users = { [adminUsername]: { passwordHash: adminHash, siteSlug: null, role: 'admin' } };
    await writeData('users', users, 'Bootstrap: seed admin user');
  }

  // Ensure sites.json exists
  let sites = await readData('sites');
  if (!sites) {
    console.log('[github-data] Seeding sites.json from SITES_SEED env or built-in list');
    sites = builtInSites();
    await writeData('sites', sites, 'Bootstrap: seed sites from processed.json');
  }

  // Ensure requests.json exists
  let requests = await readData('requests');
  if (!requests) {
    console.log('[github-data] Seeding requests.json');
    await writeData('requests', [], 'Bootstrap: empty requests list');
  }

  console.log('[github-data] Bootstrap complete');

  // Register any preview repos created while the portal was down,
  // then keep watching for new ones.
  try {
    await syncSitesFromGitHub();
  } catch (err) {
    console.error('[sync] Initial sync failed:', err.message);
  }
  setInterval(() => {
    syncSitesFromGitHub().catch(err => console.error('[sync] Periodic sync failed:', err.message));
  }, 30 * 60 * 1000);
}

// Built-in site list seeded from processed.json (26 deployed sites)
function builtInSites() {
  return {
    "donrff-wph6": {
      business: "Redline Barbershop",
      city: "Fresno, CA",
      category: "Barbershop",
      renderUrl: "https://preview-donrff-wph6.onrender.com",
      githubRepo: "preview-donrff-wph6",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "jsq05s-wph6": {
      business: "Darzi Alteration & Seamstress",
      city: "Modesto, CA",
      category: "Alterations",
      renderUrl: "https://preview-jsq05s-wph6.onrender.com",
      githubRepo: "preview-jsq05s-wph6",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "0fsmj5-2f30": {
      business: "Go2 Upholstery",
      city: "Lodi, CA",
      category: "Upholstery",
      renderUrl: "https://preview-0fsmj5-2f30.onrender.com",
      githubRepo: "preview-0fsmj5-2f30",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "ehxw2s-jnx2": {
      business: "Hoffman Alterations and Embroidery",
      city: "Modesto, CA",
      category: "Alterations",
      renderUrl: "https://preview-ehxw2s-jnx2.onrender.com",
      githubRepo: "preview-ehxw2s-jnx2",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "n85tjg-lkjr": {
      business: "TLC Grooming",
      city: "Visalia, CA",
      category: "Pet Grooming",
      renderUrl: "https://preview-n85tjg-lkjr.onrender.com",
      githubRepo: "preview-n85tjg-lkjr",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "cilr7a-wxd2": {
      business: "Fowler's Auto Upholstery Shop",
      city: "Stockton, CA",
      category: "Auto Upholstery",
      renderUrl: "https://preview-cilr7a-wxd2.onrender.com",
      githubRepo: "preview-cilr7a-wxd2",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "y9hcyn-nhof": {
      business: "M & B Lock And Door Repair",
      city: "Bakersfield, CA",
      category: "Locksmith",
      renderUrl: "https://preview-y9hcyn-nhof.onrender.com",
      githubRepo: "preview-y9hcyn-nhof",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "zw0omc-gn0d": {
      business: "Poochie's Pet Club Pet Grooming",
      city: "Visalia, CA",
      category: "Pet Grooming",
      renderUrl: "https://preview-zw0omc-gn0d.onrender.com",
      githubRepo: "preview-zw0omc-gn0d",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "9bn8a1-6y5z": {
      business: "Tapiceria Rivera",
      city: "Stockton, CA",
      category: "Upholstery",
      renderUrl: "https://preview-9bn8a1-6y5z.onrender.com",
      githubRepo: "preview-9bn8a1-6y5z",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "52gos3": {
      business: "CBS Plumbing & Heating, Inc.",
      city: "Santa Rosa, CA",
      category: "Plumbing",
      renderUrl: "https://preview-52gos3.onrender.com",
      githubRepo: "preview-52gos3",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "vbbr9o": {
      business: "Coleman Plumbing",
      city: "Redwood Valley, CA",
      category: "Plumbing",
      renderUrl: "https://preview-vbbr9o.onrender.com",
      githubRepo: "preview-vbbr9o",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "t39zoh": {
      business: "Constantini's Heating & Air Conditioning",
      city: "Santa Rosa, CA",
      category: "HVAC",
      renderUrl: "https://preview-t39zoh.onrender.com",
      githubRepo: "preview-t39zoh",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "ld0y59": {
      business: "North Bay Plumbing",
      city: "Fairfield, CA",
      category: "Plumbing",
      renderUrl: "https://preview-ld0y59.onrender.com",
      githubRepo: "preview-ld0y59",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "1ywa4m": {
      business: "Gilian's Watch & Jewelry Service",
      city: "Sacramento, CA",
      category: "Jewelry",
      renderUrl: "https://preview-1ywa4m.onrender.com",
      githubRepo: "preview-1ywa4m",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "m3kp7x": {
      business: "Central Plumbing & Sewers",
      city: "Alameda, CA",
      category: "Plumbing",
      renderUrl: "https://preview-m3kp7x.onrender.com",
      githubRepo: "preview-m3kp7x",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "r1q447": {
      business: "Mission Alterations",
      city: "Fresno, CA",
      category: "Alterations",
      renderUrl: "https://preview-r1q447.onrender.com",
      githubRepo: "preview-r1q447",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "kng0mz": {
      business: "Celina's Alterations",
      city: "Merced, CA",
      category: "Alterations",
      renderUrl: "https://preview-kng0mz.onrender.com",
      githubRepo: "preview-kng0mz",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "fgogv2": {
      business: "Castlewood Upholstery Studio",
      city: "Chico, CA",
      category: "Upholstery",
      renderUrl: "https://preview-fgogv2.onrender.com",
      githubRepo: "preview-fgogv2",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "fgpmte": {
      business: "Cal Plumbing & Fire Suppression Inc.",
      city: "Blue Lake, CA",
      category: "Plumbing",
      renderUrl: "https://preview-fgpmte.onrender.com",
      githubRepo: "preview-fgpmte",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "h760o7": {
      business: "Rafaela's Alterations",
      city: "Porterville, CA",
      category: "Alterations",
      renderUrl: "https://preview-h760o7.onrender.com",
      githubRepo: "preview-h760o7",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "vk1b2p": {
      business: "Ocean Alterations & Tailor Service",
      city: "Surfside Beach, TX",
      category: "Alterations",
      renderUrl: "https://preview-vk1b2p.onrender.com",
      githubRepo: "preview-vk1b2p",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "is1f0b": {
      business: "Saldana's Exhaust and Muffler",
      city: "Hanford, CA",
      category: "Auto Repair",
      renderUrl: "https://preview-is1f0b.onrender.com",
      githubRepo: "preview-is1f0b",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "le73rr": {
      business: "Quintana Auto Detailing",
      city: "Visalia, CA",
      category: "Auto Detailing",
      renderUrl: "https://preview-le73rr.onrender.com",
      githubRepo: "preview-le73rr",
      phone: "",
      email: "Qdetailer@comcast.net",
      owner: "",
      addedAt: "2025-01-01"
    },
    "uee4d4": {
      business: "Bob's Shoe Repair",
      city: "Turlock, CA",
      category: "Shoe Repair",
      renderUrl: "https://preview-uee4d4.onrender.com",
      githubRepo: "preview-uee4d4",
      phone: "",
      email: "",
      owner: "",
      addedAt: "2025-01-01"
    },
    "8dxvb0": {
      business: "Seva Science",
      city: "San Diego, CA",
      category: "Health Equity",
      renderUrl: "https://preview-8dxvb0.onrender.com",
      githubRepo: "preview-8dxvb0",
      phone: "",
      email: "",
      owner: "Sai Kathem & Akshita Chhabra",
      addedAt: "2025-01-01"
    }
  };
}

module.exports = { readData, writeData, getSiteHTML, putSiteHTML, putSiteImage, listSitePages, listFileCommits, getFileAtRef, injectGaTag, getFile, putFile, bootstrap, syncSitesFromGitHub };
