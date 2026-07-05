require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcrypt');

const app = express();
app.use(express.json({ limit: '10mb' }));
// HTML always revalidates so UI updates show up on plain reload
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.use('/editor', express.static(path.join(__dirname, 'editor')));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/sites', require('./routes/sites'));
app.use('/api/requests', require('./routes/requests'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/contact', require('./routes/contact'));
app.use('/api/customize', require('./routes/customize'));

// Preview proxy — must come after API routes
app.get('/preview/:slug', require('./routes/sites').proxyHandler);

// SPA fallback for client-side pages
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/analytics', (req, res) => res.sendFile(path.join(__dirname, 'public', 'analytics.html')));
app.get('/customize', (req, res) => res.sendFile(path.join(__dirname, 'public', 'customize.html')));
app.get('/studio', (req, res) => res.sendFile(path.join(__dirname, 'public', 'studio.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`OpenClaw Portal running on port ${PORT}`);
  await require('./lib/github-data').bootstrap();
});
