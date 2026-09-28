'use strict';

// ---- money, dates and checks: private copies ----

/** Plain decimal amounts only: no dollar sign, no thousands separators. */
function toCents(text) {
  if (typeof text !== 'string') throw new Error(`invalid amount: ${text}`);
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) throw new Error(`invalid amount: ${text}`);
  const cents = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'));
  return match[1] ? -cents : cents;
}

/** "1234.56": no symbol, no separators. */
function centsToString(cents) {
  if (!Number.isInteger(cents)) throw new Error(`invalid cents: ${cents}`);
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function dayNumber(text) {
  const match = typeof text === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error(`invalid date: ${text}`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) throw new Error(`invalid date: ${text}`);
  return ms / 86_400_000;
}

const between = (from, to) => dayNumber(to) - dayNumber(from);
const weekday = text => new Date(dayNumber(text) * 86_400_000).getUTCDay();
const weekend = text => { const day = weekday(text); return day === 0 || day === 6; };
function shift(text, days) {
  const date = new Date((dayNumber(text) + days) * 86_400_000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function mustBeText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

// ---- payroll ----

/** A pay period from `start` to `end`, both included: its length in days, and its weekdays. */
function payPeriod(start, end) {
  const days = between(start, end) + 1;
  if (days < 1) throw new Error('end must not be before start');
  let workdays = 0;
  for (let offset = 0; offset < days; offset++) if (!weekend(shift(start, offset))) workdays++;
  return { start, end, days, workdays };
}

/**
 * Gross pay in cents for `hours` at `hourlyRate` (a plain decimal string, "25.50"): hours over 40 are paid at one
 * and a half times the rate. Rounded half up to a cent.
 */
function grossPay({ hourlyRate, hours }) {
  const rate = toCents(hourlyRate);
  if (rate <= 0) throw new Error('hourlyRate must be positive');
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0) throw new Error('hours must be a number of at least 0');
  const regular = Math.min(hours, 40), overtime = Math.max(hours - 40, 0);
  return Math.round(rate * regular + rate * 1.5 * overtime);
}

/** A payslip as text. */
function payslip(employee, period, hours) {
  const name = mustBeText(employee.name, 'name');
  const cents = grossPay({ hourlyRate: employee.hourlyRate, hours });
  return [
    `Payslip: ${name}`,
    `Period: ${period.start} to ${period.end} (${period.workdays} workdays)`,
    `Hours: ${hours}`,
    `Rate: ${centsToString(toCents(employee.hourlyRate))}`,
    `Gross: ${centsToString(cents)}`,
  ].join('\n');
}

module.exports = { payPeriod, grossPay, payslip };
