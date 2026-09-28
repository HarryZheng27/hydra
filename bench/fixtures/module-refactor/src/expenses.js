'use strict';

// ---- CSV, money, dates and checks: private copies ----

function splitRecords(text, delimiter = ',') {
  const rows = [];
  let row = [], field = '', quoted = false, touched = false;
  const endField = () => { row.push(field); field = ''; touched = false; };
  const endRow = () => { endField(); if (!(row.length === 1 && row[0] === '')) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && !touched) { quoted = true; touched = true; }
    else if (char === delimiter) endField();
    else if (char === '\r' && text[i + 1] === '\n') { endRow(); i++; }
    else if (char === '\n') endRow();
    else { field += char; touched = true; }
  }
  if (quoted) throw new Error('unterminated quoted field');
  if (field !== '' || touched || row.length) endRow();
  return rows;
}

/** Money as accountants write it: "$1,234.56", "12.3", and "(12.30)" for a negative amount. */
function readMoney(text) {
  if (typeof text !== 'string') throw new Error(`invalid amount: ${text}`);
  let body = text.trim(), negative = false;
  const parens = /^\((.*)\)$/.exec(body);
  if (parens) { body = parens[1]; negative = true; }
  const match = /^(-)?\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(body);
  if (!match || (parens && match[1])) throw new Error(`invalid amount: ${text}`);
  const cents = Number(match[2].replace(/,/g, '')) * 100 + Number((match[3] ?? '').padEnd(2, '0'));
  return negative || match[1] ? -cents : cents;
}

/** "$1,234.56", and "($1,234.56)" for a negative amount. */
function showMoney(cents) {
  if (!Number.isInteger(cents)) throw new Error(`invalid cents: ${cents}`);
  const abs = Math.abs(cents);
  const text = `$${String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(abs % 100).padStart(2, '0')}`;
  return cents < 0 ? `(${text})` : text;
}

function validDate(text) {
  const match = typeof text === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const ok = match && (() => { const d = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])); return d.getUTCFullYear() === +match[1] && d.getUTCMonth() === +match[2] - 1 && d.getUTCDate() === +match[3]; })();
  if (!ok) throw new Error(`invalid date: ${text}`);
  return text;
}

function pick(value, allowed, field) {
  if (!allowed.includes(value)) throw new Error(`${field} must be one of ${allowed.join(', ')}`);
  return value;
}

// ---- expenses ----

const categories = ['travel', 'meals', 'office', 'other'];

/**
 * Expenses from CSV with the header `date,category,amount,note` (names trimmed; the columns may come in any order).
 * Returns `{ date, category, cents, note }` per record, in order. A bad record throws, naming its line (the header
 * is line 1).
 */
function parseExpenses(text) {
  const [header, ...records] = splitRecords(text);
  if (!header) return [];
  const names = header.map(name => name.trim());
  for (const needed of ['date', 'category', 'amount', 'note']) if (!names.includes(needed)) throw new Error(`missing column: ${needed}`);
  return records.map((record, index) => {
    const line = index + 2;
    if (record.length !== names.length) throw new Error(`line ${line}: expected ${names.length} fields, got ${record.length}`);
    const row = Object.fromEntries(names.map((name, column) => [name, record[column]]));
    try {
      return { date: validDate(row.date.trim()), category: pick(row.category.trim(), categories, 'category'), cents: readMoney(row.amount), note: row.note.trim() };
    } catch (error) { throw new Error(`line ${line}: ${error.message}`); }
  });
}

/** Totals per category that has expenses, formatted, in the order of `categories`. */
function totalsByCategory(expenses) {
  const totals = {};
  for (const category of categories) {
    const items = expenses.filter(expense => expense.category === category);
    if (items.length) totals[category] = showMoney(items.reduce((sum, item) => sum + item.cents, 0));
  }
  return totals;
}

module.exports = { parseExpenses, totalsByCategory, categories };
