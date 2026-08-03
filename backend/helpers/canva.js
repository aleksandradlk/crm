const crypto = require('crypto');
const db     = require('../db');

const AUTH_URL  = 'https://www.canva.com/api/oauth/authorize';
const TOKEN_URL = 'https://api.canva.com/rest/v1/oauth/token';
const API_BASE  = 'https://api.canva.com/rest/v1';

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function newPkcePair() {
  const verifier  = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function buildAuthorizeUrl(state, codeChallenge) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.CANVA_CLIENT_ID,
    redirect_uri: process.env.CANVA_REDIRECT_URI,
    scope: 'design:content:read design:content:write brandtemplate:content:read brandtemplate:meta:read',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCode(code, verifier) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${process.env.CANVA_CLIENT_ID}:${process.env.CANVA_CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: process.env.CANVA_REDIRECT_URI,
    }),
  });
  if (!res.ok) throw new Error(`Canva token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function refreshTokens(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${process.env.CANVA_CLIENT_ID}:${process.env.CANVA_CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`Canva token refresh failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function saveTokens(tokens) {
  const expiresAt = new Date(Date.now() + (tokens.expires_in || 14400) * 1000);
  await db.query(
    `INSERT INTO canva_auth (id, access_token, refresh_token, expires_at) VALUES (1, ?, ?, ?)
     ON DUPLICATE KEY UPDATE access_token=VALUES(access_token), refresh_token=VALUES(refresh_token), expires_at=VALUES(expires_at)`,
    [tokens.access_token, tokens.refresh_token, expiresAt]
  );
}

async function getValidAccessToken() {
  const [[row]] = await db.query('SELECT access_token, refresh_token, expires_at FROM canva_auth WHERE id=1');
  if (!row) throw new Error('Canva ist nicht verbunden. Bitte zuerst im Admin-Bereich verbinden.');
  if (new Date(row.expires_at).getTime() > Date.now() + 60_000) return row.access_token;
  const tokens = await refreshTokens(row.refresh_token);
  await saveTokens(tokens);
  return tokens.access_token;
}

async function apiRequest(path, opts = {}) {
  const token = await getValidAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`Canva API ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function listBrandTemplates() {
  const data = await apiRequest('/brand-templates');
  return data.items || [];
}

async function getBrandTemplateDataset(templateId) {
  const data = await apiRequest(`/brand-templates/${templateId}/dataset`);
  return data.dataset || {};
}

// Füllt Textfelder der Vorlage: erstes Textfeld = Titel, zweites (falls vorhanden) = Detail
async function createDesignFromTemplate(templateId, titleText, detailText) {
  const dataset = await getBrandTemplateDataset(templateId);
  const textFieldKeys = Object.entries(dataset)
    .filter(([, field]) => field.type === 'text')
    .map(([key]) => key);

  const data = {};
  if (textFieldKeys[0]) data[textFieldKeys[0]] = { type: 'text', text: titleText.slice(0, 200) };
  if (textFieldKeys[1] && detailText) data[textFieldKeys[1]] = { type: 'text', text: detailText.slice(0, 500) };

  const created = await apiRequest('/autofills', {
    method: 'POST',
    body: JSON.stringify({ brand_template_id: templateId, title: titleText.slice(0, 100), data }),
  });

  // Autofill läuft asynchron — kurz pollen bis der Job fertig ist (üblicherweise wenige Sekunden)
  const jobId = created.job.id;
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const job = await getAutofillJob(jobId);
    if (job.job.status === 'success') return job.job.result.design;
    if (job.job.status === 'failed') throw new Error(job.job.error?.message || 'Canva-Design konnte nicht erstellt werden');
  }
  throw new Error('Canva-Design-Erstellung hat zu lange gedauert (Timeout)');
}

async function getAutofillJob(jobId) {
  return apiRequest(`/autofills/${jobId}`);
}

module.exports = { newPkcePair, buildAuthorizeUrl, exchangeCode, saveTokens, listBrandTemplates, createDesignFromTemplate, getAutofillJob };
