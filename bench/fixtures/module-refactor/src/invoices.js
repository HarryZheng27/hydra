'use strict';

// ---- money, dates and checks: private copies ----

function parseAmount(text) {
  if (typeof text !== 'string') throw new Error(`invalid amount: ${text}`);
  const trimmed = text.trim();
  const match = /^(-)?\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) throw new Error(`invalid amount: ${text}`);
  const whole = Number(match[2].replace(/,/g, ''));
  const fraction = Number((match[3] ?? '').padEnd(2, '0'));
  const cents = whole * 100 + fraction;
  return match[1] ? -cents : cents;
}

function formatAmount(cents) {
  if (!Number.isInteger(cents)) throw new Error(`invalid cents: ${cents}`);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

function parseDay(text) {
  const match = typeof text === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error(`invalid date: ${text}`);
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) throw new Error(`invalid date: ${text}`);
  return { year, month, day };
}

function plusDays(text, days) {
  const { year, month, day } = parseDay(text);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, '0')}-${String(moved.getUTCDate()).padStart(2, '0')}`;
}

const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(text) {
  const { year, month, day } = parseDay(text);
  return `${monthNames[month - 1]} ${day}, ${year}`;
}

function needText(value, field, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  const trimmed = value.trim();
  if (max !== undefined && trimmed.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return trimmed;
}

function needWhole(value, field, min, max) {
  if (!Number.isInteger(value)) throw new Error(`${field} must be a whole number`);
  if (min !== undefined && value < min) throw new Error(`${field} must be at least ${min}`);
  if (max !== undefined && value > max) throw new Error(`${field} must be at most ${max}`);
  return value;
}

const emailLike = text => typeof text === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);

// ---- invoices ----

/**
 * An invoice from its customer, lines and issue date. Unit prices are money strings ("$1,250.00"); the due date is
 * `termsDays` after the issue date.
 */
function createInvoice({ customer, email, lines, issued, termsDays = 30 }) {
  const name = needText(customer, 'customer', 80);
  if (!emailLike(email)) throw new Error(`invalid email: ${email}`);
  if (!Array.isArray(lines) || !lines.length) throw new Error('lines is required');
  needWhole(termsDays, 'termsDays', 0, 120);
  const priced = lines.map(line => {
    const description = needText(line.description, 'description', 200);
    const quantity = needWhole(line.quantity, 'quantity', 1, 10_000);
    const unitCents = parseAmount(line.unitPrice);
    return { description, quantity, unitCents, totalCents: unitCents * quantity };
  });
  parseDay(issued);
  return {
    customer: name, email, lines: priced,
    subtotalCents: priced.reduce((sum, line) => sum + line.totalCents, 0),
    issued, due: plusDays(issued, termsDays),
  };
}

/** The invoice's total, formatted. */
const invoiceTotal = invoice => formatAmount(invoice.subtotalCents);

/** A plain-text summary: a header, one line per item, the total and the dates. */
function invoiceSummary(invoice) {
  return [
    `Invoice for ${invoice.customer} <${invoice.email}>`,
    ...invoice.lines.map(line => `  ${line.quantity} x ${line.description} @ ${formatAmount(line.unitCents)} = ${formatAmount(line.totalCents)}`),
    `Total: ${formatAmount(invoice.subtotalCents)}`,
    `Issued ${longDate(invoice.issued)}, due ${longDate(invoice.due)}`,
  ].join('\n');
}

module.exports = { createInvoice, invoiceTotal, invoiceSummary };
