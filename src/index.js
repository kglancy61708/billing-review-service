'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const box = require('./box');
const { slackClient } = require('./slack');
const { runAndReport } = require('./job');

const FOLDER_ID = process.env.BOX_FOLDER_ID || '406564573839';
const SCHEDULE = process.env.REVIEW_CRON || '0 12 15 * *';      // noon on the 15th
const TZ = process.env.REVIEW_TZ || 'America/Chicago';
const MAX_AGE_DAYS = parseInt(process.env.MAX_FILE_AGE_DAYS || '3', 10);
const args = new Set(process.argv.slice(2));

const stamp = () => new Date().toISOString();
const log = m => console.log(`[${stamp()}] ${m}`);

function deps({ dryRun }) {
  return {
    box,
    slack: dryRun ? null : slackClient({ token: process.env.SLACK_BOT_TOKEN, channel: process.env.SLACK_CHANNEL_ID }),
    folderId: FOLDER_ID,
    maxAgeDays: MAX_AGE_DAYS,
    dryRun,
    log,
  };
}

// Logs whether Box and Slack are reachable and the history file exists. Posts nothing, changes nothing.
async function selfCheck() {
  const ok = m => log(`SELF-CHECK OK:   ${m}`);
  const bad = m => log(`SELF-CHECK FAIL: ${m}`);
  try {
    const items = await box.listFolder(FOLDER_ID);
    ok(`Box folder ${FOLDER_ID} readable (${items.length} items)`);
    const h = items.find(i => i.type === 'file' && i.name === 'wm-billing-history.csv');
    h ? ok(`history file present (${h.size} bytes, modified ${h.modified_at})`) : bad('wm-billing-history.csv is missing from the Box folder - run scripts/seed-history.js');
    const fresh = items.filter(i => /\.xlsx$/i.test(i.name) && Date.parse(i.modified_at) >= Date.now() - MAX_AGE_DAYS * 86400000);
    log(`SELF-CHECK INFO: ${fresh.length} .xlsx file(s) modified in the last ${MAX_AGE_DAYS} days`);
  } catch (e) { bad(`Box: ${e.message}`); }
  try {
    const res = await fetch('https://slack.com/api/auth.test', { method: 'POST', headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN || ''}` } });
    const j = await res.json();
    j.ok ? ok(`Slack token valid (bot "${j.user}" in workspace "${j.team}")`) : bad(`Slack: ${j.error}`);
    if (j.ok) {
      const r = await fetch('https://slack.com/api/conversations.info', { method: 'POST', headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ channel: process.env.SLACK_CHANNEL_ID || '' }) });
      const c = await r.json();
      c.ok ? ok(`channel #${c.channel.name} found; bot is ${c.channel.is_member ? 'a member' : 'NOT a member - invite it with /invite'}`) : log(`SELF-CHECK INFO: could not read channel info (${c.error}) - not necessarily a problem`);
    }
  } catch (e) { bad(`Slack: ${e.message}`); }
}

async function main() {
  if (args.has('--run-now') || args.has('--dry-run')) {
    const dryRun = args.has('--dry-run');
    const r = await runAndReport(deps({ dryRun }));
    if (dryRun) {
      const out = path.join(process.cwd(), 'out');
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, r.filename), r.xlsx);
      console.log('\n--- Slack message that would be posted ---\n' + r.text);
      console.log(`\nWorkbook written to ${path.join(out, r.filename)}`);
    }
    return;
  }

  await selfCheck();
  // Optional one-off test on boot: set RUN_ON_START=dry-run (logs the result, posts/saves nothing). Remove it afterwards.
  if (process.env.RUN_ON_START === 'dry-run') {
    try { const r = await runAndReport(deps({ dryRun: true })); log(`DRY RUN RESULT: ${r.review.latest} vs ${r.review.prior} ${JSON.stringify(r.review.counts)} of ${r.review.total}; warnings: ${JSON.stringify(r.warnings)}`); }
    catch (e) { log(`DRY RUN FAILED: ${e.message}`); }
  }

  // RUN_ON_START=live posts to Slack and updates the history right now. Remove the variable afterwards or every restart will post again.
  if (process.env.RUN_ON_START === 'live') {
    log('RUN_ON_START=live: running a real review now (this posts to Slack)');
    try { const r = await runAndReport(deps({ dryRun: false })); log(`LIVE RUN DONE: ${r.review.latest} vs ${r.review.prior} ${JSON.stringify(r.review.counts)} of ${r.review.total}`); }
    catch (e) { log(`LIVE RUN FAILED: ${e.message}`); }
    log('Reminder: delete the RUN_ON_START variable in Railway now.');
  }

  let running = false;
  cron.schedule(SCHEDULE, async () => {
    if (running) return;
    running = true;
    try { await runAndReport(deps({ dryRun: false })); }
    catch (e) { /* already logged and reported to Slack */ }
    finally { running = false; }
  }, { timezone: TZ });
  log(`Scheduled "${SCHEDULE}" (${TZ}). Waiting.`);

  // Health endpoint so Railway can see the service is alive.
  const port = process.env.PORT || 8080;
  http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('billing-review-service ok\n'); })
    .listen(port, () => log(`Health endpoint on :${port}`));
}

main().catch(e => { console.error(e); process.exit(1); });
