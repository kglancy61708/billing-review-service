'use strict';

const HEADER = ['Name', 'Month', 'Amount', 'BU', 'Status', 'Category', 'Prepaid'];

function csvEscape(s) {
  s = String(s ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const lines = [HEADER.join(',')];
  for (const r of rows) {
    lines.push([r.name, r.month, r.amount, r.bu, r.status, r.category, r.prepaid].map(csvEscape).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// Minimal RFC4180 parser (quoted fields, escaped quotes, CRLF).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function fromCsv(text) {
  const [head, ...body] = parseCsv(text);
  if (!head) return [];
  const idx = Object.fromEntries(head.map((h, i) => [h.trim().toLowerCase(), i]));
  return body.filter(r => r.length > 1).map(r => ({
    name: r[idx.name], month: r[idx.month], amount: parseFloat(r[idx.amount]) || 0,
    bu: r[idx.bu] || '', status: r[idx.status] || '', category: r[idx.category] || '', prepaid: r[idx.prepaid] || '',
  }));
}

module.exports = { toCsv, fromCsv, parseCsv };
