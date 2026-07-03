const { BetaAnalyticsDataClient } = require('@google-analytics/data');

const PROPERTY_ID = process.env.GA4_PROPERTY_ID;

function getClient() {
  const raw = process.env.GOOGLE_CREDENTIALS;
  if (!raw) return null;
  try {
    const credentials = JSON.parse(raw);
    return new BetaAnalyticsDataClient({ credentials });
  } catch {
    return null;
  }
}

// Run a GA4 report filtered to a specific hostname
async function runReport({ hostname, dimensions, metrics, dateRange = '30daysAgo', limit = 10 }) {
  const client = getClient();
  if (!client || !PROPERTY_ID) return null;

  const req = {
    property: `properties/${PROPERTY_ID}`,
    dimensions: dimensions.map(name => ({ name })),
    metrics: metrics.map(name => ({ name })),
    dateRanges: [{ startDate: dateRange, endDate: 'today' }],
    limit,
  };

  if (hostname) {
    req.dimensionFilter = {
      filter: {
        fieldName: 'hostName',
        stringFilter: { value: hostname, matchType: 'EXACT' },
      },
    };
  }

  const [response] = await client.runReport(req);
  return response;
}

// Parse row value helpers
function dim(row, i) { return row.dimensionValues?.[i]?.value || ''; }
function met(row, i) { return row.metricValues?.[i]?.value || '0'; }

async function getSiteStats(hostname, dateRange = '30daysAgo') {
  try {
    // KPI totals
    const totals = await runReport({
      hostname, dateRange,
      dimensions: ['date'],
      metrics: ['activeUsers', 'sessions', 'screenPageViews', 'bounceRate', 'averageSessionDuration'],
      limit: 1,
    });

    // Actually, for totals we want a single-row totals run without date dimension
    const totalsRun = await runReport({
      hostname, dateRange,
      dimensions: [],
      metrics: ['activeUsers', 'sessions', 'screenPageViews', 'bounceRate', 'averageSessionDuration'],
      limit: 1,
    });

    const kpis = { users: 0, sessions: 0, pageviews: 0, bounceRate: 0, avgSessionDuration: 0 };
    if (totalsRun?.rows?.length) {
      const r = totalsRun.rows[0];
      kpis.users = parseInt(met(r, 0));
      kpis.sessions = parseInt(met(r, 1));
      kpis.pageviews = parseInt(met(r, 2));
      kpis.bounceRate = parseFloat(parseFloat(met(r, 3)).toFixed(1));
      kpis.avgSessionDuration = parseFloat(parseFloat(met(r, 4)).toFixed(0));
    }

    // Countries
    const countriesRun = await runReport({
      hostname, dateRange,
      dimensions: ['country'],
      metrics: ['activeUsers'],
      limit: 8,
    });
    const topCountries = (countriesRun?.rows || []).map(r => ({
      country: dim(r, 0),
      users: parseInt(met(r, 0)),
    }));

    // Cities
    const citiesRun = await runReport({
      hostname, dateRange,
      dimensions: ['city'],
      metrics: ['activeUsers'],
      limit: 6,
    });
    const topCities = (citiesRun?.rows || []).map(r => ({
      city: dim(r, 0),
      users: parseInt(met(r, 0)),
    }));

    // Devices
    const devicesRun = await runReport({
      hostname, dateRange,
      dimensions: ['deviceCategory'],
      metrics: ['activeUsers'],
      limit: 5,
    });
    const deviceBreakdown = (devicesRun?.rows || []).map(r => ({
      device: dim(r, 0),
      users: parseInt(met(r, 0)),
    }));

    // Top pages
    const pagesRun = await runReport({
      hostname, dateRange,
      dimensions: ['pagePath'],
      metrics: ['screenPageViews'],
      limit: 8,
    });
    const topPages = (pagesRun?.rows || []).map(r => ({
      path: dim(r, 0),
      views: parseInt(met(r, 0)),
    }));

    // Daily trend (last 14 data points)
    const trendRun = await runReport({
      hostname, dateRange,
      dimensions: ['date'],
      metrics: ['activeUsers', 'sessions'],
      limit: 30,
    });
    const trend = (trendRun?.rows || []).map(r => ({
      date: dim(r, 0),
      users: parseInt(met(r, 0)),
      sessions: parseInt(met(r, 1)),
    })).sort((a, b) => a.date.localeCompare(b.date));

    return { ...kpis, topCountries, topCities, deviceBreakdown, topPages, trend };
  } catch (err) {
    console.error('[ga4] getSiteStats error:', err.message);
    return null;
  }
}

async function getAggregateStats(dateRange = '30daysAgo') {
  try {
    const client = getClient();
    if (!client || !PROPERTY_ID) return null;

    const totalsRun = await runReport({
      hostname: null, dateRange,
      dimensions: [],
      metrics: ['activeUsers', 'sessions', 'screenPageViews'],
      limit: 1,
    });

    const kpis = { totalUsers: 0, totalSessions: 0, totalPageviews: 0 };
    if (totalsRun?.rows?.length) {
      const r = totalsRun.rows[0];
      kpis.totalUsers = parseInt(met(r, 0));
      kpis.totalSessions = parseInt(met(r, 1));
      kpis.totalPageviews = parseInt(met(r, 2));
    }

    const countriesRun = await runReport({
      hostname: null, dateRange,
      dimensions: ['country'],
      metrics: ['activeUsers'],
      limit: 10,
    });
    const topLocations = (countriesRun?.rows || []).map(r => ({
      country: dim(r, 0),
      users: parseInt(met(r, 0)),
    }));

    return { ...kpis, topLocations, period: dateRange };
  } catch (err) {
    console.error('[ga4] getAggregateStats error:', err.message);
    return null;
  }
}

module.exports = { getSiteStats, getAggregateStats };
