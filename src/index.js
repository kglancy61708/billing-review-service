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
