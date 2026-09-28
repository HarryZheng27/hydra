'use strict';

// ---- money, dates and CSV: private copies ----

function dollars(cents) {
  if (!Number.isInteger(cents)) throw new Error(`invalid cents: ${cents}`);
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${cents < 0 ? '-' : ''}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

function checkedDate(text) {
  const match = typeof text === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error(`invalid date: ${text}`);
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  if (date.getUTCFullYear() !== +match[1] || date.getUTCMonth() !== +match[2] - 1 || date.getUTCDate() !== +match[3]) throw new Error(`invalid date: ${text}`);
  return text;
}
const monthOf = text => checkedDate(text).slice(0, 7);

function csvField(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
const csvLine = fields => fields.map(csvField).join(',');

// ---- reports ----

/** Entries ({ date, cents }) totalled per month, oldest first: `{ month, count, total }`, total formatted. */
function monthlyReport(entries) {
  const months = new Map();
  for (const entry of entries) {
    if (!Number.isInteger(entry.cents)) throw new Error(`invalid cents: ${entry.cents}`);
    const month = monthOf(entry.date);
    const current = months.get(month) ?? { count: 0, cents: 0 };
    months.set(month, { count: current.count + 1, cents: current.cents + entry.cents });
  }
  return [...months].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, value]) => ({ month, count: value.count, total: dollars(value.cents) }));
}

/** The report as CSV (header month,count,total), CRLF line endings, a CRLF after the last line too. */
function reportCsv(rows) {
  return [csvLine(['month', 'count', 'total']), ...rows.map(row => csvLine([row.month, row.count, row.total]))].map(line => `${line}\r\n`).join('');
}

/** The change from `before` to `after` as a signed percentage with one decimal: "+12.5%", "-3.0%"; "n/a" from 0. */
function percentChange(before, after) {
  if (before === 0) return 'n/a';
  const change = ((after - before) / Math.abs(before)) * 100;
  const rounded = Math.round(change * 10) / 10;
  return `${rounded >= 0 ? '+' : ''}${rounded.toFixed(1)}%`;
}

module.exports = { monthlyReport, reportCsv, percentChange };
