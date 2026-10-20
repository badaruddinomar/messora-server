/** A cell: text, or an already formatted number such as a `Decimal.toFixed(2)` string. */
export type CsvCell = string | number | null | undefined;

const BOM = "\uFEFF";
const NUMBER = /^-?\d+(\.\d+)?$/;
// Spreadsheets run cells starting with these as formulas (CSV injection).
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: CsvCell) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (!NUMBER.test(text) && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * RFC 4180 CSV with a UTF-8 byte order mark, so Excel shows ৳ and Bangla names correctly. Text that
 * would run as a formula is prefixed with `'`; numbers are left alone.
 */
export function toCsv(header: string[], rows: CsvCell[][]) {
  return `${BOM}${[header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}
