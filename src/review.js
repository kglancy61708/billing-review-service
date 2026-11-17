'use strict';
const { round2 } = require('./util');

const SUMMER_MULT = 1.25; // Apr-Sep
const WINTER_MULT = 0.75; // Oct-Mar
const isSummer = m => m >= 4 && m <= 9;

// Aggregate invoice rows (from one or more files) into per-customer monthly totals.
function aggregateInvoices(invoiceRows) {
  const revenue = new Map(); // name -> Map(month -> amount)
  const info = new Map();    // name -> {bu,status,category,prepaid}
  const months = new Set();
  for (const r of invoiceRows) {
    if (!revenue.has(r.name)) revenue.set(r.name, new Map());
    const m = revenue.get(r.name);
    m.set(r.month, (m.get(r.month) || 0) + r.amount);
    months.add(r.month);
    info.set(r.name, { bu: r.bu, status: r.status, category: r.category, prepaid: r.prepaid });
  }
  return { revenue, info, months };
}

// Months present in the new data REPLACE stored months; months not in the new data are kept from history.
// historyRows: [{name, month, amount, bu, status, category, prepaid}]
function mergeHistory(agg, historyRows) {
  const warnings = [];
  const newMonths = [...agg.months].sort();
  const newSet = new Set(newMonths);

  if (historyRows.length && newMonths.length) {
    const oldest = newMonths[0];
    let stored = 0, fresh = 0;
    for (const h of historyRows) if (h.month === oldest) stored += h.amount;
    for (const m of agg.revenue.values()) fresh += m.get(oldest) || 0;
    if (stored > 0 && fresh < 0.8 * stored) {
      warnings.push(
        `Oldest month in new files (${oldest}) totals ${Math.round(fresh).toLocaleString('en-US')} vs ` +
        `${Math.round(stored).toLocaleString('en-US')} stored - the date range may start mid-month, ` +
        'so that month was overwritten with a partial total.'
      );
    }
  }

  const revenue = agg.revenue, info = agg.info, months = new Set(agg.months);
  for (const h of historyRows) {
    if (!newSet.has(h.month)) {
      if (!revenue.has(h.name)) revenue.set(h.name, new Map());
      revenue.get(h.name).set(h.month, h.amount);
      months.add(h.month);
    }
    if (!info.has(h.name)) info.set(h.name, { bu: h.bu, status: h.status, category: h.category, prepaid: h.prepaid });
  }
  return { revenue, info, months, newMonths, warnings };
}

function toHistoryRows(revenue, info) {
  const out = [];
  for (const [name, m] of revenue) {
    const i = info.get(name) || {};
    for (const [month, amount] of m) {
      out.push({ name, month, amount: round2(amount), bu: i.bu || '', status: i.status || '', category: i.category || '', prepaid: i.prepaid || '' });
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  return out;
}

function buildTagLookup(records) {
  const exact = new Map(), parent = new Map();
  for (const r of records) {
    const target = r.property.includes(':') ? exact : parent;
    if (!target.has(r.property)) target.set(r.property, []);
    target.get(r.property).push(r);
  }
  const newest = list => list.reduce((a, b) => (b.dateCreatedTs > a.dateCreatedTs ? b : a));
  return name => {
    if (exact.has(name)) return newest(exact.get(name));
    const p = name.split(' : ')[0].trim();
    if (parent.has(p)) return newest(parent.get(p));
    return null;
  };
}

function buildReview({ revenue, info, months: monthSet, controlForms = [], maxMonthsShown = 14 }) {
  const all = [...monthSet].sort();
  const months = all.slice(-maxMonthsShown);
  if (months.length < 2) throw new Error(`Need at least 2 months of data to compute a difference; found ${months.length}.`);
  const shown = new Set(months);
  const latest = months[months.length - 1], prior = months[months.length - 2];
  const latestMM = parseInt(latest.split('/')[1], 10), priorMM = parseInt(prior.split('/')[1], 10);
  const crossesSeason = isSummer(latestMM) !== isSummer(priorMM);
  const tagFor = buildTagLookup(controlForms);

  const names = [...revenue.keys()]
    .filter(n => [...revenue.get(n).keys()].some(m => shown.has(m)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const counts = { OK: 0, SEASONAL: 0, LOST: 0, REVIEW: 0 };
  const rows = [];

  for (const name of names) {
    const mo = revenue.get(name);
    const amounts = months.map(m => round2(mo.get(m) || 0));
    const latestAmt = amounts[amounts.length - 1], priorAmt = amounts[amounts.length - 2];
    const diff = round2(latestAmt - priorAmt);
    let flag = 'OK', impliedBase = null;

    if (Math.abs(diff) > 0.01) {
      flag = 'REVIEW';
      if (crossesSeason) {
        const priorIsSummer = isSummer(priorMM);
        const summerAmt = priorIsSummer ? priorAmt : latestAmt;
        const winterAmt = priorIsSummer ? latestAmt : priorAmt;
        let residual = 0;
        if (Math.abs(summerAmt) > 0.01) {
          impliedBase = summerAmt / SUMMER_MULT;
          residual = winterAmt - impliedBase * WINTER_MULT;
        } else if (Math.abs(winterAmt) > 0.01) {
          impliedBase = winterAmt / WINTER_MULT;
          residual = summerAmt - impliedBase * SUMMER_MULT;
        }
        const tol = Math.max(15, 0.08 * Math.abs(impliedBase || 0));
        if (Math.abs(residual) <= tol) flag = 'SEASONAL';
      }
    }

    const i = info.get(name) || { bu: '', status: '', category: '', prepaid: '' };
    if (flag === 'REVIEW' && /lost/i.test(i.status) && Math.abs(latestAmt) <= 0.01) flag = 'LOST';
    counts[flag]++;

    const tag = tagFor(name);
    rows.push({
      name, bu: i.bu, status: i.status, category: i.category, prepaid: i.prepaid,
      amounts, diff, impliedBase: impliedBase === null ? null : round2(impliedBase), flag,
      tagType: tag ? tag.typeOfChange : '',
      tagDateCreated: tag ? tag.dateCreated : '',
      tagEffectiveDate: tag ? tag.effectiveDate : '',
    });
  }
  return { rows, months, latest, prior, counts, total: rows.length };
}

module.exports = { aggregateInvoices, mergeHistory, toHistoryRows, buildReview, SUMMER_MULT, WINTER_MULT };
