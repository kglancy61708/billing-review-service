'use strict';
const ExcelJS = require('exceljs');
const { cellValue, parseYearMonth, monthKey, parseAmount, toTimestamp, displayDate } = require('./util');

// Finds the header row (first row containing the required header names) and maps names -> column index.
function findHeaders(ws, required) {
  for (let r = 1; r <= Math.min(ws.rowCount, 10); r++) {
    const row = ws.getRow(r);
    const map = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const t = String(cellValue(cell.value)).trim();
      if (t) map[t] = col;
    });
    if (required.every(h => h in map)) return { headerRow: r, map };
  }
  return null;
}

// Classify + parse one NetSuite export workbook buffer.
async function parseWorkbook(buffer, fileName = '') {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return { kind: 'unknown', title: '', fileName };
  const title = ws.name;

  const inv = findHeaders(ws, ['Date', 'Name', 'Amount', 'Type', 'Business Unit']);
  if (inv) return parseInvoices(ws, inv, title, fileName);
  const cf = findHeaders(ws, ['Property', 'Type of Change', 'Effective Date']);
  if (cf) return parseControlForms(ws, cf, title, fileName);
  return { kind: 'unknown', title, fileName };
}

function parseInvoices(ws, { headerRow, map }, title, fileName) {
  const rows = [];
  let skipped = 0;
  const get = (row, h) => (map[h] ? cellValue(row.getCell(map[h]).value) : '');
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name = String(get(row, 'Name')).trim();
    const dateV = get(row, 'Date');
    if (!name && dateV === '') continue;           // blank line
    const ym = dateV === '' ? null : parseYearMonth(dateV);
    if (!name || !ym) { skipped++; continue; }
    rows.push({
      name,
      month: monthKey(ym),
      amount: parseAmount(get(row, 'Amount')),
      bu: String(get(row, 'Business Unit')).trim(),
      status: String(get(row, 'Status')).trim(),
      category: String(get(row, 'Category')).trim(),
      prepaid: displayDate(get(row, 'Prepaid Through'), false),
    });
  }
  const months = {};
  for (const x of rows) months[x.month] = (months[x.month] || 0) + 1;
  return { kind: 'invoices', title, fileName, rows, skipped, dataRows: rows.length + skipped, months };
}

function parseControlForms(ws, { headerRow, map }, title, fileName) {
  const records = [];
  const get = (row, h) => (map[h] ? cellValue(row.getCell(map[h]).value) : '');
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const property = String(get(row, 'Property')).trim();
    if (!property) continue;
    const created = get(row, 'Date Created');
    records.push({
      internalId: String(get(row, 'Internal ID') || get(row, 'ID')).trim(),
      property,
      dateCreated: displayDate(created, true),
      dateCreatedTs: toTimestamp(created),
      effectiveDate: displayDate(get(row, 'Effective Date'), false),
      employee: String(get(row, 'Employee')).trim(),
      typeOfChange: String(get(row, 'Type of Change')).trim(),
      billingChangeReason: String(get(row, 'Billing Change Reason')).trim(),
      cancellationReason: String(get(row, 'Cancellation Reason')).trim(),
    });
  }
  return { kind: 'controlforms', title, fileName, records };
}

module.exports = { parseWorkbook };
