require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const path        = require('path');

const authRoutes     = require('./routes/auth');
const userRoutes     = require('./routes/users');
const leadRoutes     = require('./routes/leads');
const generateRoutes = require('./routes/generate');
const { startReminderCron } = require('./cron/reminders');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors({
  origin: process.env.BASE_URL || '*',
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.set('trust proxy', 1);
app.use(express.json());

// Rate limiting
app.use('/api/auth/login', rateLimit({ windowMs: 15*60*1000, max: 20 }));
app.use('/api/generate',   rateLimit({ windowMs: 60*1000, max: 5 }));

// ── Static Frontend ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public_html')));

// ── API Routes ────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/users',    userRoutes);
app.use('/api/leads',    leadRoutes);
app.use('/api/generate', generateRoutes);

// ── Debug (temp) ──────────────────────────────────────────────
const fs = require('fs');
app.get('/_debug', (req, res) => {
  const p1 = path.join(__dirname, '../public_html');
  const p2 = path.join(__dirname, 'public_html');
  const cwd = process.cwd();
  res.json({
    __dirname, cwd,
    up_public_html:   { path: p1, exists: fs.existsSync(p1), files: fs.existsSync(p1) ? fs.readdirSync(p1) : [] },
    same_public_html: { path: p2, exists: fs.existsSync(p2), files: fs.existsSync(p2) ? fs.readdirSync(p2) : [] },
    nodejs_root:      { files: fs.readdirSync(__dirname) },
  });
});

// ── SPA Fallback ──────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '../public_html/login.html'), (err) => { if (err) res.status(200).send('OK'); });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`LeadHunter Pro läuft auf Port ${PORT}`);
  console.log(`Umgebung: ${process.env.NODE_ENV || 'development'}`);
  startReminderCron();
});
