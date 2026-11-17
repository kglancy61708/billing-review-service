'use strict';
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

function loadConfig() {
  if (process.env.BOX_CONFIG_JSON) return JSON.parse(process.env.BOX_CONFIG_JSON);
  const p = process.env.BOX_CONFIG_PATH;
  if (p) return JSON.parse(fs.readFileSync(p, 'utf8'));
  throw new Error('Set BOX_CONFIG_JSON (the full JSON) or BOX_CONFIG_PATH');
}

let cached = null;
async function getToken() {
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const cfg = loadConfig();
  const s = cfg.boxAppSettings;
  const assertion = jwt.sign(
    {
      iss: s.clientID,
      sub: cfg.enterpriseID,
      box_sub_type: 'enterprise',
      aud: 'https://api.box.com/oauth2/token',
      jti: crypto.randomBytes(16).toString('hex'),
    },
    { key: s.appAuth.privateKey, passphrase: s.appAuth.passphrase },
    { algorithm: 'RS512', expiresIn: 45, keyid: s.appAuth.publicKeyID, noTimestamp: false }
  );
  const res = await fetch('https://api.box.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      client_id: s.clientID,
      client_secret: s.clientSecret,
      assertion,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Box auth failed (${res.status}): ${body.error} - ${body.error_description}`);
  cached = { token: body.access_token, exp: Date.now() + body.expires_in * 1000 };
  return cached.token;
}

async function api(path, opts = {}) {
  const token = await getToken();
  const res = await fetch(path.startsWith('http') ? path : `https://api.box.com/2.0${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  return res;
}

async function listFolder(folderId) {
  const items = [];
  let offset = 0;
  for (;;) {
    const res = await api(`/folders/${folderId}/items?limit=200&offset=${offset}&fields=id,name,type,size,modified_at,created_at`);
    if (!res.ok) throw new Error(`Box list folder ${folderId} failed: ${res.status} ${await res.text()}`);
    const j = await res.json();
    items.push(...j.entries);
    offset += j.entries.length;
    if (offset >= j.total_count || j.entries.length === 0) break;
  }
  return items;
}

async function downloadFile(fileId) {
  const res = await api(`/files/${fileId}/content`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Box download ${fileId} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function uploadNewVersion(fileId, filename, buffer) {
  const form = new FormData();
  form.append('attributes', JSON.stringify({ name: filename }));
  form.append('file', new Blob([buffer]), filename);
  const res = await api(`https://upload.box.com/api/2.0/files/${fileId}/content`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Box upload version failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function uploadNewFile(folderId, filename, buffer) {
  const form = new FormData();
  form.append('attributes', JSON.stringify({ name: filename, parent: { id: folderId } }));
  form.append('file', new Blob([buffer]), filename);
  const res = await api('https://upload.box.com/api/2.0/files/content', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Box upload failed: ${res.status} ${await res.text()}`);
  return res.json();
}

module.exports = { listFolder, downloadFile, uploadNewVersion, uploadNewFile, getToken };
