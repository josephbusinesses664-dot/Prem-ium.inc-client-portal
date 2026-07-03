const router = require('express').Router();
const bcrypt = require('bcrypt');
const { sign } = require('../middleware/auth');
const { readData } = require('../lib/github-data');

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

  try {
    const users = await readData('users');
    if (!users) return res.status(500).json({ error: 'User store unavailable' });

    const user = users[username.toLowerCase()];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const token = sign({
      username: username.toLowerCase(),
      siteSlug: user.siteSlug,
      role: user.role,
    });

    res.json({ token, role: user.role, siteSlug: user.siteSlug });
  } catch (err) {
    console.error('[auth] login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

module.exports = router;
