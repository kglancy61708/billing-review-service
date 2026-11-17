'use strict';
// One-time: upload the saved monthly-totals history to the Billing Review Box folder as wm-billing-history.csv.
// Usage: BOX_CONFIG_PATH=... node scripts/seed-history.js "<path to monthly-totals.csv>"
const fs = require('fs');
const box = require('../src/box');
const { HISTORY_FILE } = require('../src/job');

const FOLDER_ID = process.env.BOX_FOLDER_ID || '406564573839';

(async () => {
  const src = process.argv[2];
  if (!src) throw new Error('Pass the path to monthly-totals.csv');
  const buf = fs.readFileSync(src);
  const items = await box.listFolder(FOLDER_ID);
  const existing = items.find(i => i.type === 'file' && i.name === HISTORY_FILE);
  if (existing) {
    await box.uploadNewVersion(existing.id, HISTORY_FILE, buf);
    console.log(`Uploaded a new version of ${HISTORY_FILE} (file ${existing.id})`);
  } else {
    const r = await box.uploadNewFile(FOLDER_ID, HISTORY_FILE, buf);
    console.log(`Created ${HISTORY_FILE} (file ${r.entries[0].id})`);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
