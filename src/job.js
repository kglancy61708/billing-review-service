'use strict';
const { parseWorkbook } = require('./parse');
const { aggregateInvoices, mergeHistory, toHistoryRows, buildReview } = require('./review');
const { buildWorkbook } = require('./workbook');
const { toCsv, fromCsv } = require('./history');

const HISTORY_FILE = 'wm-billing-history.csv';
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const prettyMonth = k => { const [y, m] = k.split('/'); return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`; };
const fmt = n => n.toLocaleString('en-US');

// Thrown for conditions that should be reported to the channel and stop the run.
class StopRun extends Error {}

function dominantMonth(months) {
  return Object.entries(months).sort((a, b) => b[1] - a[1])[0][0];
}

async function collectInputs({ box, folderId, maxAgeDays, log }) {
  const items = await box.listFolder(folderId);
  const cutoff = Date.now() - maxAgeDays * 86400000;
  const fresh = items.filter(i => i.type === 'file' && /\.xlsx$/i.test(i.name) && Date.parse(i.modified_at) >= cutoff);
  log(`Found ${fresh.length} .xlsx file(s) modified in the last ${maxAgeDays} days`);
  if (fresh.length < 4) {
    throw new StopRun(`Only ${fresh.length} fresh Excel file(s) found in the Billing Review folder (modified in the last ${maxAgeDays} days). Need 4: last/this/next month invoices + control forms.`);
  }

  const parsed = [];
  for (const f of fresh.sort((a, b) => Date.parse(b.modified_at) - Date.parse(a.modified_at))) {
    const buf = await box.downloadFile(f.id);
    const p = await parseWorkbook(buf, f.name);
    p.modifiedAt = f.modified_at;
    log(`  ${f.name} -> ${p.kind}${p.title ? ` ('${p.title}')` : ''}${p.rows ? `, ${p.dataRows} rows` : ''}`);
    parsed.push(p);
  }

  // Invoices: newest file per month; refuse anything that looks cut off at NetSuite's 10,000-row cap.
  const invoiceFiles = parsed.filter(p => p.kind === 'invoices');
  for (const p of invoiceFiles) {
    if (p.dataRows >= 9900 && p.dataRows <= 10010) {
      throw new StopRun(`Invoice file '${p.title}' has ${p.dataRows} data rows - that is NetSuite's 10,000-row export cap, so it is almost certainly truncated. Stopped before touching the saved history. Re-send the export.`);
    }
  }
  const byMonth = new Map();
  for (const p of invoiceFiles) {
    const m = dominantMonth(p.months);
    if (!byMonth.has(m)) byMonth.set(m, p);       // list is already newest-first
  }
  const chosenInvoices = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(e => e[1]);
  const cf = parsed.find(p => p.kind === 'controlforms');
  const missing = [];
  if (chosenInvoices.length < 2) missing.push(`invoice exports (found ${chosenInvoices.length}, need Last/This/Next month)`);
  if (!cf) missing.push('control-forms export');
  if (missing.length) throw new StopRun(`Missing: ${missing.join('; ')}.`);

  const warnings = [];
  if (chosenInvoices.length !== 3) warnings.push(`Expected 3 monthly invoice files but found ${chosenInvoices.length}.`);
  for (const p of chosenInvoices) {
    if (Object.keys(p.months).length > 1) warnings.push(`File '${p.title}' spans ${Object.keys(p.months).length} months (${Object.keys(p.months).sort().join(', ')}).`);
  }
  return { invoiceFiles: chosenInvoices, controlForms: cf.records, warnings };
}

async function loadHistory({ box, folderId }) {
  const items = await box.listFolder(folderId);
  const h = items.find(i => i.type === 'file' && i.name === HISTORY_FILE);
  if (!h) throw new StopRun(`The saved history file (${HISTORY_FILE}) is missing from the Billing Review folder, so I can't build the full 12-month view. It needs to be restored (Box version history may have it).`);
  return { id: h.id, rows: fromCsv((await box.downloadFile(h.id)).toString('utf8')) };
}

async function runReview({ box, slack, folderId, maxAgeDays = 3, dryRun = false, log = console.log }) {
  const inputs = await collectInputs({ box, folderId, maxAgeDays, log });
  const history = await loadHistory({ box, folderId });
  log(`History: ${history.rows.length} rows`);

  const agg = aggregateInvoices(inputs.invoiceFiles.flatMap(p => p.rows));
  const merged = mergeHistory(agg, history.rows);
  const review = buildReview({ ...merged, controlForms: inputs.controlForms });
  const warnings = [...inputs.warnings, ...merged.warnings];
  log(`Latest ${review.latest} vs ${review.prior}: ${JSON.stringify(review.counts)} of ${review.total}`);

  const xlsx = await buildWorkbook({ review, controlForms: inputs.controlForms });
  const filename = `WM Billing Review - ${prettyMonth(review.latest)}.xlsx`;

  const text = [
    `*WM Billing Review — ${prettyMonth(review.latest)}* (vs. ${prettyMonth(review.prior)})`,
    `Total customers: ${fmt(review.total)}`,
    `✅ OK: ${fmt(review.counts.OK)}   🌦️ Seasonal (expected): ${fmt(review.counts.SEASONAL)}   ⚪ Lost/inactive: ${fmt(review.counts.LOST)}   🔴 Needs review: ${fmt(review.counts.REVIEW)}`,
    'Full workbook attached — see the *Summary* tab, filter the Flag column to `REVIEW` for this month\'s exceptions. Fill in the Notes column as you clear each one.',
    ...warnings.map(w => `⚠️ ${w}`),
  ].join('\n');

  const result = { review: { latest: review.latest, prior: review.prior, counts: review.counts, total: review.total }, filename, text, warnings, xlsx };
  if (dryRun) { log('DRY RUN - not posting and not saving history'); return result; }

  // Save merged history first (the run is idempotent: replaying the same files gives the same history).
  await box.uploadNewVersion(history.id, HISTORY_FILE, Buffer.from(toCsv(toHistoryRows(merged.revenue, merged.info)), 'utf8'));
  log('History saved to Box');

  try {
    await slack.uploadFile({ filename, buffer: xlsx, comment: text });
    log('Posted workbook + summary to Slack');
  } catch (e) {
    log(`File upload failed (${e.message}); posting summary only`);
    await slack.postMessage(`${text}\n(The workbook upload to Slack failed: ${e.message})`);
  }
  return result;
}

// Wrapper used by the scheduler: reports StopRun / unexpected errors to the channel.
async function runAndReport(deps) {
  const log = deps.log || console.log;
  try {
    return await runReview(deps);
  } catch (e) {
    log(`Run failed: ${e.message}`);
    if (!deps.dryRun && deps.slack) {
      const msg = e instanceof StopRun
        ? `⚠️ *WM Billing Review not posted:* ${e.message}`
        : `⚠️ *WM Billing Review failed:* ${e.message}`;
      try { await deps.slack.postMessage(msg); } catch (se) { log(`Could not post the error to Slack: ${se.message}`); }
    }
    throw e;
  }
}

module.exports = { runReview, runAndReport, StopRun, HISTORY_FILE, prettyMonth };
