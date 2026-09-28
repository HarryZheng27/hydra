'use strict';

// ---- CSV, dates and checks: private copies ----

function readCsv(text) {
  const out = [];
  let record = [], value = '', inQuotes = false, begun = false;
  const push = () => { record.push(value); value = ''; begun = false; };
  const finish = () => { push(); if (record.length > 1 || record[0] !== '') out.push(record); record = []; };
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (inQuotes) {
      if (char !== '"') value += char;
      else if (text[at + 1] === '"') { value += '"'; at++; }
      else inQuotes = false;
      continue;
    }
    if (char === '"' && !begun) { inQuotes = true; begun = true; continue; }
    if (char === ',') { push(); continue; }
    if (char === '\n' || (char === '\r' && text[at + 1] === '\n')) { if (char === '\r') at++; finish(); continue; }
    value += char; begun = true;
  }
  if (inQuotes) throw new Error('unterminated quoted field');
  if (value !== '' || begun || record.length) finish();
  return out;
}

/** "3/7/1990" or "03/07/1990" → "1990-03-07". */
function usToIso(text) {
  const match = typeof text === 'string' && /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (!match) throw new Error(`invalid date: ${text}`);
  const month = +match[1], day = +match[2], year = +match[3];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) throw new Error(`invalid date: ${text}`);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function requireText(value, field, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  if (value.trim().length > max) throw new Error(`${field} must be at most ${max} characters`);
  return value.trim();
}

const checkEmail = text => typeof text === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);

/** Ten digits, or eleven starting with 1, however they're punctuated → "(555) 123-4567". */
function tidyPhone(text) {
  let digits = String(text ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
  if (digits.length !== 10) throw new Error(`invalid phone: ${text}`);
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

// ---- customers ----

/**
 * Customers from CSV with the header `name,email,phone,birthday` (birthday as M/D/YYYY, may be empty). Records that
 * fail are left out and reported as "line <n>: <reason>" (the header is line 1).
 */
function importCustomers(text) {
  const [header, ...records] = readCsv(text);
  if (!header) return { customers: [], errors: [] };
  const names = header.map(name => name.trim().toLowerCase());
  const customers = [], errors = [];
  records.forEach((record, index) => {
    const line = index + 2;
    if (record.length !== names.length) { errors.push(`line ${line}: expected ${names.length} fields, got ${record.length}`); return; }
    const row = Object.fromEntries(names.map((name, column) => [name, record[column]]));
    try {
      const name = requireText(row.name, 'name', 100);
      const email = (row.email ?? '').trim().toLowerCase();
      if (!checkEmail(email)) throw new Error(`invalid email: ${row.email}`);
      const phone = tidyPhone(row.phone);
      const birthday = row.birthday && row.birthday.trim() ? usToIso(row.birthday) : null;
      customers.push({ name, email, phone, birthday });
    } catch (error) { errors.push(`line ${line}: ${error.message}`); }
  });
  return { customers, errors };
}

/** "Ada Lovelace <ada@example.com>" */
const customerLabel = customer => `${customer.name} <${customer.email}>`;

module.exports = { importCustomers, customerLabel };
