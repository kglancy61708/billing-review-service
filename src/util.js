'use strict';

// Normalise any exceljs cell value to plain text/number/Date.
function cellValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    if ('result' in v) return cellValue(v.result);
    if ('text' in v) return String(v.text);
    if ('error' in v) return '';
  }
  return v;
}

const pad2 = n => String(n).padStart(2, '0');

// Returns {y, m} (1-12) from a Date, serial, or "M/D/YY" / "M/D/YYYY" text. null when unparseable.
function parseYearMonth(v) {
  if (v instanceof Date) return { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1 };
  if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 86400000)); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 }; }
  const parts = String(v).trim().split(/[\/\s]/);
  if (parts.length < 3) return null;
  const m = parseInt(parts[0], 10), yy = parseInt(parts[2], 10);
  if (!(m >= 1 && m <= 12) || Number.isNaN(yy)) return null;
  return { y: yy < 100 ? 2000 + yy : yy, m };
}
const monthKey = ({ y, m }) => `${y}/${pad2(m)}`;

function parseAmount(v) {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').trim();
  if (!s) return 0;
  let neg = false;
  if (s.startsWith('(') && s.endsWith(')')) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$,]/g, '');
  const n = parseFloat(s);
  if (Number.isNaN(n)) return 0;
  return neg ? -n : n;
}

// Timestamp (ms) for sorting "Date Created" values; 0 when unknown.
function toTimestamp(v) {
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? 0 : t;
}

// Display text for date-ish cells, e.g. "8/18/26 9:01".
function displayDate(v, withTime) {
  if (v instanceof Date) {
    const base = `${v.getUTCMonth() + 1}/${v.getUTCDate()}/${pad2(v.getUTCFullYear() % 100)}`;
    return withTime ? `${base} ${v.getUTCHours()}:${pad2(v.getUTCMinutes())}` : base;
  }
  return String(v ?? '').trim();
}

const round2 = x => Math.round(x * 100) / 100;

module.exports = { cellValue, parseYearMonth, monthKey, parseAmount, toTimestamp, displayDate, round2, pad2 };
