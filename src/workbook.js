'use strict';
const ExcelJS = require('exceljs');

const FLAG_FILL = { REVIEW: 'FFFFC7CE', SEASONAL: 'FFFFEB9C', OK: 'FFC6EFCE', LOST: 'FFD9D9D9' };
const MONEY = '$#,##0.00;($#,##0.00);-';

async function buildWorkbook({ review, controlForms }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Summary', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });

  const headers = [
    'Customer (Row Label)', 'Business Unit', 'Status', 'Category', 'Prepaid Through',
    ...review.months,
    `Difference (${review.latest} vs ${review.prior})`, 'Implied Base Rate', 'Flag',
    'Type of Change', 'Date Created', 'Effective Date', 'Notes',
  ];
  ws.addRow(headers);
  const nMonths = review.months.length;
  const diffCol = 5 + nMonths + 1, baseCol = diffCol + 1, flagCol = diffCol + 2;

  for (const r of review.rows) {
    ws.addRow([
      r.name, r.bu, r.status, r.category, r.prepaid,
      ...r.amounts, r.diff, r.impliedBase === null ? null : r.impliedBase, r.flag,
      r.tagType || null, r.tagDateCreated || null, r.tagEffectiveDate || null, null,
    ]);
  }

  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { wrapText: true, vertical: 'top' };
  head.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBFE1FF' } }; });
  ws.getColumn(1).width = 32;
  for (let c = 6; c <= baseCol; c++) { ws.getColumn(c).width = 13; ws.getColumn(c).numFmt = MONEY; }
  head.getCell(1).numFmt = 'General';
  for (let c = 6; c <= baseCol; c++) head.getCell(c).numFmt = 'General';
  ws.getColumn(flagCol).width = 11;
  ws.getColumn(flagCol + 1).width = 20;
  ws.getColumn(flagCol + 2).width = 16;
  ws.getColumn(flagCol + 3).width = 14;
  ws.getColumn(flagCol + 4).width = 40;

  for (let i = 0; i < review.rows.length; i++) {
    const cell = ws.getRow(i + 2).getCell(flagCol);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FLAG_FILL[review.rows[i].flag] } };
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: review.rows.length + 1, column: headers.length } };

  const cf = wb.addWorksheet('ControlForms');
  cf.addRow(['Internal ID', 'Date Created', 'Effective Date', 'Property', 'Employee', 'Type of Change', 'Billing Change Reason', 'Cancellation Reason']);
  for (const c of controlForms) {
    cf.addRow([c.internalId, c.dateCreated, c.effectiveDate, c.property, c.employee, c.typeOfChange, c.billingChangeReason, c.cancellationReason]);
  }
  cf.getRow(1).font = { bold: true };
  cf.getColumn(4).width = 32;
  cf.autoFilter = { from: { row: 1, column: 1 }, to: { row: controlForms.length + 1, column: 8 } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildWorkbook };
