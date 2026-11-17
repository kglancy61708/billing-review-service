'use strict';
// Parity check against the PowerShell pipeline's output, using the tab-delimited text dumps from the Box connector.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { parseYearMonth, monthKey, parseAmount, toTimestamp } = require('../src/util');
const { aggregateInvoices, mergeHistory, toHistoryRows, buildReview } = require('../src/review');
const { fromCsv, toCsv } = require('../src/history');

const TR = 'C:/Users/kglan/.claude/projects/C--Users-kglan-Claude-Work/95ff8d44-a3ae-4000-bded-d155c196e599/tool-results/mcp-a13c41b8-a077-41ce-b46b-f03a53cf20ad-get_file_content-';
const INV = ['1794861074718', '1794861074951', '1794861075259'].map(id => `${TR}${id}.txt`);
const CF = `${TR}1794860103287.txt`;
const HIST = 'C:/Users/kglan/Claude Work/WM Billing Review/history/monthly-totals.csv';
const have = [...INV, CF, HIST].every(p => fs.existsSync(p));

function invoiceRowsFromText(path) {
  const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/).slice(2);
  const rows = [];
  for (const l of lines) {
    const f = l.split('\t');
    if (f.length < 19) continue;
    const ym = parseYearMonth(f[3].trim());
    if (!f[6].trim() || !ym) continue;
    rows.push({ name: f[6].trim(), month: monthKey(ym), amount: parseAmount(f[9]), bu: f[11].trim(), status: f[12].trim(), category: f[13].trim(), prepaid: f[14].trim() });
  }
  return rows;
}

function cfFromText(path) {
  const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/).slice(2);
  const out = [];
  for (const l of lines) {
    const f = l.split('\t');
    if (f.length < 17 || f[0].trim() !== '' || !/^\d+$/.test(f[1])) continue;
    out.push({ internalId: f[1], property: f[6].trim(), dateCreated: f[4].trim(), dateCreatedTs: toTimestamp(f[4].trim()), effectiveDate: f[5].trim(), typeOfChange: f[8].trim() });
  }
  return out;
}

test('matches the PowerShell pipeline for December 2026', { skip: !have }, () => {
  const rows = INV.flatMap(invoiceRowsFromText);
  assert.strictEqual(rows.length, 14462);
  const agg = aggregateInvoices(rows);
  const history = fromCsv(fs.readFileSync(HIST, 'utf8'));
  const merged = mergeHistory(agg, history);
  assert.deepStrictEqual(merged.newMonths, ['2026/10', '2026/11', '2026/12']);
  assert.deepStrictEqual(merged.warnings, []);
  const cf = cfFromText(CF);
  assert.strictEqual(cf.length, 284);
  const review = buildReview({ ...merged, controlForms: cf });
  assert.strictEqual(review.latest, '2026/12');
  assert.strictEqual(review.prior, '2026/11');
  assert.deepStrictEqual(review.counts, { OK: 3504, SEASONAL: 0, LOST: 26, REVIEW: 33 });
  assert.strictEqual(review.total, 3563);
});

test('history CSV round-trips', { skip: !have }, () => {
  const history = fromCsv(fs.readFileSync(HIST, 'utf8'));
  const again = fromCsv(toCsv(history));
  assert.strictEqual(again.length, history.length);
  assert.deepStrictEqual(again[100], history[100]);
});

test('seasonal step: Sep->Oct is explained by the 125%/75% base rate', () => {
  const months = new Set(['2026/09', '2026/10']);
  const mk = (a, b) => new Map([['2026/09', a], ['2026/10', b]]);
  const revenue = new Map([
    ['Steady : 1', mk(1000, 600)],     // 1000 * .75/1.25 = 600 -> SEASONAL
    ['Changed : 2', mk(1000, 900)],    // not explained -> REVIEW
    ['Gone : 3', mk(500, 0)],          // lost
    ['Same : 4', mk(300, 300)],        // OK
  ]);
  const info = new Map([
    ['Steady : 1', { status: '5 - Closed Won' }], ['Changed : 2', { status: '5 - Closed Won' }],
    ['Gone : 3', { status: 'Lost Customer' }], ['Same : 4', { status: '5 - Closed Won' }],
  ]);
  const r = buildReview({ revenue, info, months });
  const flags = Object.fromEntries(r.rows.map(x => [x.name, x.flag]));
  assert.deepStrictEqual(flags, { 'Changed : 2': 'REVIEW', 'Gone : 3': 'LOST', 'Same : 4': 'OK', 'Steady : 1': 'SEASONAL' });
});

test('merge replaces months in new data and keeps older ones', () => {
  const agg = aggregateInvoices([{ name: 'A : 1', month: '2026/12', amount: 50, bu: '', status: '', category: '', prepaid: '' }]);
  const hist = [
    { name: 'A : 1', month: '2026/11', amount: 40, bu: '', status: '', category: '', prepaid: '' },
    { name: 'A : 1', month: '2026/12', amount: 10, bu: '', status: '', category: '', prepaid: '' },
    { name: 'B : 2', month: '2026/12', amount: 99, bu: '', status: '', category: '', prepaid: '' },
  ];
  const m = mergeHistory(agg, hist);
  const out = toHistoryRows(m.revenue, m.info);
  assert.deepStrictEqual(out.map(x => `${x.name}|${x.month}|${x.amount}`), ['A : 1|2026/11|40', 'A : 1|2026/12|50']);
});
