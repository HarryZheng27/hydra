'use strict';
const { InputError } = require('./errors');

/**
 * Parses CSV text into records (arrays of strings), per RFC 4180 (SPEC.md section 2): quoted fields may hold the
 * delimiter, line breaks and "" for one quote; records end with \n or \r\n; a final line ending doesn't start
 * another record; blank lines outside quotes are skipped.
 */
function parseCsv(text, delimiter = ',') {
  if (typeof text !== 'string') throw new TypeError('parseCsv needs a string');
  if (typeof delimiter !== 'string' || delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') throw new InputError('the delimiter must be one character');
  const records = [];
  let record = [], field = '', quoted = false, fieldStarted = false, i = 0;
  const endField = () => { record.push(field); field = ''; fieldStarted = false; };
  const endRecord = () => {
    endField();
    if (!(record.length === 1 && record[0] === '')) records.push(record);
    record = [];
  };
  while (i < text.length) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += char; i++; continue;
    }
    if (char === '"' && !fieldStarted && field === '') { quoted = true; fieldStarted = true; i++; continue; }
    if (char === delimiter) { endField(); i++; continue; }
    if (char === '\r' && text[i + 1] === '\n') { endRecord(); i += 2; continue; }
    if (char === '\n') { endRecord(); i++; continue; }
    field += char; fieldStarted = true; i++;
  }
  if (quoted) throw new InputError('unterminated quoted field');
  if (field !== '' || fieldStarted || record.length) endRecord();
  return records;
}

/** Whether a value is numeric (SPEC.md section 2): after trimming, an optional minus, digits, and optional decimals. */
const isNumeric = value => /^-?\d+(\.\d+)?$/.test(String(value).trim());

/** A number as toolkit prints it (SPEC.md section 2): rounded to 4 decimal places, no trailing zeros, never -0. */
const formatNumber = value => { const rounded = Number(value.toFixed(4)); return String(Object.is(rounded, -0) ? 0 : rounded); };

module.exports = { parseCsv, isNumeric, formatNumber };
