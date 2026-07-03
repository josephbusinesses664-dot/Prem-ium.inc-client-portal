const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod';

function sign(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: '7d' });
}

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]
    || req.query.token;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

function requireSiteAccess(req, res, next) {
  requireAuth(req, res, () => {
    const slug = req.params.slug;
    if (req.user.role === 'admin') return next();
    if (req.user.siteSlug !== slug) return res.status(403).json({ error: 'Not your site' });
    next();
  });
}

module.exports = { sign, requireAuth, requireAdmin, requireSiteAccess };
