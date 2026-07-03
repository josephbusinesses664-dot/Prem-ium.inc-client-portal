const router = require('express').Router();
const Groq = require('groq-sdk');
const { requireAuth, requireSiteAccess } = require('../middleware/auth');
const { readData } = require('../lib/github-data');
const { getSiteStats, getAggregateStats } = require('../lib/ga4');

const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

// GET /api/analytics/aggregate — public hook for Prem's personal site
router.get('/aggregate', async (req, res) => {
  const { key } = req.query;
  if (!key || key !== process.env.AGGREGATE_SECRET) {
    return res.status(401).json({ error: 'Invalid key' });
  }
  const dateRange = req.query.period || '30daysAgo';
  try {
    const sites = await readData('sites') || {};
    const data = await getAggregateStats(dateRange);
    if (!data) return res.status(503).json({ error: 'Analytics unavailable — check GOOGLE_CREDENTIALS env var' });
    res.json({ ...data, siteCount: Object.keys(sites).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/:slug — site stats for client
router.get('/:slug', requireAuth, async (req, res) => {
  const { slug } = req.params;
  if (req.user.role !== 'admin' && req.user.siteSlug !== slug) {
    return res.status(403).json({ error: 'Not your site' });
  }

  try {
    const sites = await readData('sites');
    const site = sites?.[slug];
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const dateRange = req.query.period || '30daysAgo';
    // Extract hostname from renderUrl
    const hostname = site.renderUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');

    const data = await getSiteStats(hostname, dateRange);
    if (!data) {
      return res.status(503).json({
        error: 'Analytics unavailable',
        hint: 'Add GOOGLE_CREDENTIALS, GA4_PROPERTY_ID, GA4_MEASUREMENT_ID to Render env vars'
      });
    }

    res.json({ site: { business: site.business, city: site.city }, ...data });
  } catch (err) {
    console.error('[analytics] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/analytics/:slug/chat — Groq chatbot with analytics context
router.post('/:slug/chat', requireAuth, async (req, res) => {
  const { slug } = req.params;
  if (req.user.role !== 'admin' && req.user.siteSlug !== slug) {
    return res.status(403).json({ error: 'Not your site' });
  }

  const { message, analyticsSnapshot } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  if (!groq) {
    return res.json({ reply: 'Analytics assistant is not configured yet. Add GROQ_API_KEY to your Render environment variables.' });
  }

  try {
    const sites = await readData('sites');
    const site = sites?.[slug];
    const businessName = site?.business || slug;

    const systemPrompt = `You are an analytics assistant for ${businessName}, a local business. You help the business owner understand their website analytics in plain, friendly English.

${analyticsSnapshot ? `Current analytics data for their website:\n${JSON.stringify(analyticsSnapshot, null, 2)}` : 'No analytics data provided.'}

Rules:
- Keep answers under 3 sentences
- Use simple everyday language, no jargon
- If you reference a number, tie it to something meaningful (e.g. "47 people visited — that's about 1-2 a day")
- If asked about a metric you don't have data for, say so honestly
- Be encouraging and helpful`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
      max_tokens: 200,
      temperature: 0.7,
    });

    const reply = completion.choices[0]?.message?.content || 'Sorry, I could not generate a response.';
    res.json({ reply });
  } catch (err) {
    console.error('[analytics/chat] error:', err.message);
    res.json({ reply: 'Sorry, the assistant is temporarily unavailable.' });
  }
});

module.exports = router;
