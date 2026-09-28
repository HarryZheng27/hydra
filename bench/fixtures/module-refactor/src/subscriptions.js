'use strict';

// ---- money, dates and checks: private copies ----

function priceText(cents) {
  if (!Number.isInteger(cents)) throw new Error(`invalid cents: ${cents}`);
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}$${String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(abs % 100).padStart(2, '0')}`;
}

function readDay(text) {
  const match = typeof text === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error(`invalid date: ${text}`);
  const year = +match[1], month = +match[2], day = +match[3];
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new Error(`invalid date: ${text}`);
  return { year, month, day };
}

const pad = value => String(value).padStart(2, '0');

/** `n` months after the date, keeping the day but clamping it to the end of a shorter month. */
function monthsLater(text, n) {
  const { year, month, day } = readDay(text);
  const index = year * 12 + (month - 1) + n;
  const y = Math.floor(index / 12), m = index % 12 + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(Math.min(day, last))}`;
}

const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const spelled = text => { const { year, month, day } = readDay(text); return `${names[month - 1]} ${day}, ${year}`; };

function wholeNumber(value, field, min, max) {
  if (!Number.isInteger(value)) throw new Error(`${field} must be a whole number`);
  if (value < min) throw new Error(`${field} must be at least ${min}`);
  if (value > max) throw new Error(`${field} must be at most ${max}`);
  return value;
}

function among(value, allowed, field) {
  if (!allowed.includes(value)) throw new Error(`${field} must be one of ${allowed.join(', ')}`);
  return value;
}

// ---- subscriptions ----

/** Monthly price per seat, in cents. */
const plans = { basic: 900, pro: 1500, team: 1200 };

/** The next `count` renewal dates: one month apart from the start, clamped at month ends from the start's day. */
function renewalDates(start, count) {
  wholeNumber(count, 'count', 0, 120);
  return Array.from({ length: count }, (_, index) => monthsLater(start, index + 1));
}

/** A subscription: its plan, start, seats, monthly price, and the next three renewals. Team plans need 3 seats or more. */
function createSubscription({ plan, start, seats = 1 }) {
  among(plan, Object.keys(plans), 'plan');
  readDay(start);
  wholeNumber(seats, 'seats', plan === 'team' ? 3 : 1, 500);
  return { plan, start, seats, monthlyCents: plans[plan] * seats, renewals: renewalDates(start, 3) };
}

/** "Pro plan, 3 seats: $45.00/month from March 5, 2024" */
function invoiceLine(subscription) {
  const plan = subscription.plan[0].toUpperCase() + subscription.plan.slice(1);
  const seats = `${subscription.seats} seat${subscription.seats === 1 ? '' : 's'}`;
  return `${plan} plan, ${seats}: ${priceText(subscription.monthlyCents)}/month from ${spelled(subscription.start)}`;
}

module.exports = { createSubscription, renewalDates, invoiceLine, plans };
