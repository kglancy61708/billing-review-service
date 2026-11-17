'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { runReview, runAndReport, StopRun } = require('../src/job');
const { toCsv, fromCsv } = require('../src/history');
const { parseYearMonth } = require('../src/util');

const TR = 'C:/Users/kglan/.claude/projects/C--Users-kglan-Claude-Work/95ff8d44-a3ae-4000-bded-d155c196e599/tool-results/mcp-a13c41b8-a077-41ce-b46b-f03a53cf20ad-get_file_content-';
const INV = { '2026/10': '1794861074718', '2026/11': '1794861074951', '2026/12': '1794861075259' };
const CF = `${TR}1794860103287.txt`;
const HIST = 'C:/Users/kglan/Claude Work/WM Billing Review/history/monthly-totals.csv';
const have = [...Object.values(INV).map(i => `${TR}${i}.txt`), CF, HIST].every(p => fs.existsSync(p));

const INV_HEADERS = ['Internal ID', 'Line ID', 'Date', 'Type', 'Document Number', 'Name', 'Customer Name', 'Item', 'Amount', 'Current Base Rate', 'Business Unit', 'Status', 'Category', 'Prepaid Through', 'Date Created', 'Summer Multiplier', 'Winter Multiplier', 'Date of First Sale'];
const CF_HEADERS = ['Internal ID', 'ID', 'Script ID', 'Date Created', 'Effective Date', 'Property', 'Employee', 'Type of Change', 'Salvage Processed', 'Billing Change Reason', 'Cancellation Reason', 'Billing Stopped', 'Completed and Reviewed', 'Billing Address', 'One-Time Credit Amount', 'Memo'];

const lines = p => fs.readFileSync(p, 'utf8').split(/\r?\n/);

// variant 'native' = real Date + numeric amount; 'text' = text date + text amount with commas/parens
async function invoiceXlsx(path, title, variant) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title);
  ws.addRow(INV_HEADERS);
  for (const l of lines(path).slice(2)) {
    const f = l.split('\t');
    if (f.length < 19) continue;
    const ym = parseYearMonth(f[3].trim()); if (!ym) continue;
    const [mm, dd, yy] = f[3].trim().split('/').map(Number);
    const raw = f[9].trim();
    const neg = raw.startsWith('(');
    const num = parseFloat(raw.replace(/[(),]/g, '')) * (neg ? -1 : 1);
    ws.addRow([
      f[1], f[2],
      variant === 'native' ? new Date(Date.UTC(yy < 100 ? 2000 + yy : yy, mm - 1, dd)) : f[3].trim(),
      f[4], f[5], f[6], f[7], f[8],
      variant === 'native' ? (Number.isNaN(num) ? 0 : num) : raw,
      f[10], f[11], f[12], f[13], f[14], f[15], f[16], f[17], f[18],
    ]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function cfXlsx(path) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('MonthlyBillingReviewControlFor');
  ws.addRow(CF_HEADERS);
  for (const l of lines(path).slice(2)) {
    const f = l.split('\t');
    if (f.length < 17 || f[0].trim() !== '' || !/^\d+$/.test(f[1])) continue;
    ws.addRow(f.slice(1, 17));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function mockBox({ files, history }) {
  const saved = {};
  return {
    saved,
    async listFolder() {
      const items = files.map(f => ({ id: f.id, name: f.name, type: 'file', modified_at: f.modified_at || new Date().toISOString() }));
      if (history) items.push({ id: 'H1', name: 'wm-billing-history.csv', type: 'file', modified_at: '2026-11-16T00:00:00Z' });
      return items;
    },
    async downloadFile(id) { return id === 'H1' ? Buffer.from(history, 'utf8') : files.find(f => f.id === id).buf; },
    async uploadNewVersion(id, name, buf) { saved[name] = buf.toString('utf8'); },
  };
}
function mockSlack() {
  const posts = [];
  return { posts, async uploadFile(a) { posts.push({ type: 'file', ...a }); }, async postMessage(t) { posts.push({ type: 'msg', text: t }); } };
}

test('end to end: three one-month xlsx files + control forms + history -> same result as PowerShell', { skip: !have }, async () => {
  const files = [
    { id: 'f1', name: 'searchresults (a).xlsx', buf: await invoiceXlsx(`${TR}${INV['2026/10']}.txt`, 'MonthlyWMBillingCheckLastMonth', 'native') },
    { id: 'f2', name: 'searchresults (b).xlsx', buf: await invoiceXlsx(`${TR}${INV['2026/11']}.txt`, 'MonthlyWMBillingCheckThisMonth', 'text') },
    { id: 'f3', name: 'searchresults (c).xlsx', buf: await invoiceXlsx(`${TR}${INV['2026/12']}.txt`, 'MonthlyWMBillingCheckNextMonth', 'native') },
    { id: 'f4', name: 'searchresults (d).xlsx', buf: await cfXlsx(CF) },
  ];
  const histText = fs.readFileSync(HIST, 'utf8');
  const box = mockBox({ files, history: histText });
  const slack = mockSlack();
  const r = await runReview({ box, slack, folderId: 'x', log: () => {} });

  assert.deepStrictEqual(r.review.counts, { OK: 3504, SEASONAL: 0, LOST: 26, REVIEW: 33 });
  assert.strictEqual(r.review.total, 3563);
  assert.strictEqual(r.filename, 'WM Billing Review - December 2026.xlsx');
  assert.strictEqual(slack.posts.length, 1);
  assert.strictEqual(slack.posts[0].type, 'file');
  assert.match(slack.posts[0].comment, /Needs review: 33/);
  assert.deepStrictEqual(r.warnings, []);
  // history written back and still has all 12 months
  const saved = fromCsv(box.saved['wm-billing-history.csv']);
  assert.strictEqual(new Set(saved.map(x => x.month)).size, 12);
  assert.ok(fromCsv(toCsv(saved)).length === saved.length);

  // the generated workbook opens and has the right sheets/columns
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.xlsx);
  assert.deepStrictEqual(wb.worksheets.map(w => w.name), ['Summary', 'ControlForms']);
  assert.strictEqual(wb.getWorksheet('Summary').rowCount, 3564);
  assert.match(String(wb.getWorksheet('Summary').getRow(1).getCell(18).value), /Difference/);
});

test('refuses a file cut off at the 10,000-row cap and leaves history alone', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('MonthlyWMBillingCheckThisMonth');
  ws.addRow(INV_HEADERS);
  for (let i = 0; i < 10000; i++) ws.addRow(['1', '1', '11/1/26', 'Invoice', 'D', `C : ${i}`, 'x', 'item', 10, '', 'Poolsure', '5 - Closed Won', 'cat', '', '', 1, 1, '']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const filler = (id) => ({ id, name: `${id}.xlsx`, buf });
  const box = mockBox({ files: [filler('a'), filler('b'), filler('c'), filler('d')], history: 'Name,Month,Amount,BU,Status,Category,Prepaid\r\n' });
  const slack = mockSlack();
  await assert.rejects(runAndReport({ box, slack, folderId: 'x', log: () => {} }), StopRun);
  assert.deepStrictEqual(box.saved, {});
  assert.match(slack.posts[0].text, /10,000-row export cap/);
});

test('reports to the channel when files are missing', async () => {
  const box = mockBox({ files: [], history: 'x' });
  const slack = mockSlack();
  await assert.rejects(runAndReport({ box, slack, folderId: 'x', log: () => {} }), StopRun);
  assert.match(slack.posts[0].text, /Only 0 fresh Excel file/);
});
