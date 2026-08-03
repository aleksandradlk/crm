const router = require('express').Router();
const crypto = require('crypto');
const db     = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const canva  = require('../helpers/canva');

// GET /api/canva/connect — startet OAuth-Flow (Admin öffnet das im Browser)
router.get('/connect', auth, adminOnly, async (req, res) => {
  const { verifier, challenge } = canva.newPkcePair();
  const state = crypto.randomBytes(16).toString('hex');
  await db.query(
    "INSERT INTO app_settings (key_name, value) VALUES ('canva_pkce_verifier', ?) ON DUPLICATE KEY UPDATE value=?",
    [verifier, verifier]
  );
  await db.query(
    "INSERT INTO app_settings (key_name, value) VALUES ('canva_oauth_state', ?) ON DUPLICATE KEY UPDATE value=?",
    [state, state]
  );
  res.json({ url: canva.buildAuthorizeUrl(state, challenge) });
});

// GET /api/canva/callback — Canva leitet hierhin zurück (kein Login-Token, State prüft Legitimität)
router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    const [[stateRow]]    = await db.query("SELECT value FROM app_settings WHERE key_name='canva_oauth_state'");
    const [[verifierRow]] = await db.query("SELECT value FROM app_settings WHERE key_name='canva_pkce_verifier'");
    if (!stateRow || state !== stateRow.value) throw new Error('State stimmt nicht überein');
    const tokens = await canva.exchangeCode(code, verifierRow.value);
    await canva.saveTokens(tokens);
    res.send('<h2>Canva verbunden ✅</h2><p>Du kannst dieses Fenster schließen und zum CRM zurückkehren.</p>');
  } catch (e) {
    res.status(500).send(`<h2>Canva-Verbindung fehlgeschlagen</h2><p>${e.message}</p>`);
  }
});

// GET /api/canva/status — ist Canva verbunden?
router.get('/status', auth, async (req, res) => {
  try {
    const [[row]] = await db.query('SELECT id FROM canva_auth WHERE id=1');
    res.json({ connected: !!row });
  } catch (e) { res.status(500).json({ error: 'Fehler beim Prüfen' }); }
});

// GET /api/canva/brand-templates — Liste zur Auswahl
router.get('/brand-templates', auth, adminOnly, async (req, res) => {
  try {
    const items = await canva.listBrandTemplates();
    res.json(items.map(t => ({ id: t.id, title: t.title, thumbnail: t.thumbnail?.url || null })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/canva/brand-template — gewählte Vorlage für Content-Designs speichern
router.patch('/brand-template', auth, adminOnly, async (req, res) => {
  const { templateId } = req.body;
  if (!templateId) return res.status(400).json({ error: 'templateId fehlt' });
  try {
    await db.query(
      "INSERT INTO app_settings (key_name, value) VALUES ('canva_brand_template_id', ?) ON DUPLICATE KEY UPDATE value=?",
      [templateId, templateId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Fehler beim Speichern' }); }
});

module.exports = router;
