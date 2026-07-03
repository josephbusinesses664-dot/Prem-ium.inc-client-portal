require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcrypt');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/editor', express.static(path.join(__dirname, 'editor')));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/sites', require('./routes/sites'));
app.use('/api/requests', require('./routes/requests'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/analytics', require('./routes/analytics'));

// Preview proxy — must come after API routes
app.get('/preview/:slug', require('./routes/sites').proxyHandler);

// SPA fallback for client-side pages
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/analytics', (req, res) => res.sendFile(path.join(__dirname, 'public', 'analytics.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`OpenClaw Portal running on port ${PORT}`);
  await require('./lib/github-data').bootstrap();
});
