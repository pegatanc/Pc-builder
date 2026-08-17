/**
 * Parses a displayed price string into a number.
 *
 * Retailers render prices in wildly inconsistent ways — "$1,234.56", "1.234,56 €",
 * "US$99", "From $89.99", split whole/fraction spans — so this is deliberately
 * forgiving about surrounding text but strict about the number itself.
 */
export function parsePrice(input) {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) && input > 0 ? input : null;

  const text = String(input).replace(/\s+/g, ' ').trim();
  if (!text) return null;

  // First number-looking run, allowing both , and . as separators.
  const match = text.match(/\d[\d., ']*\d|\d/);
  if (!match) return null;

  let token = match[0].replace(/[ ']/g, '');

  const lastComma = token.lastIndexOf(',');
  const lastDot = token.lastIndexOf('.');

  if (lastComma !== -1 && lastDot !== -1) {
    // Whichever separator comes last is the decimal one.
    const decimalAt = Math.max(lastComma, lastDot);
    const groupSep = decimalAt === lastComma ? '.' : ',';
    token = token.split(groupSep).join('');
    token = token.replace(decimalAt === lastComma ? ',' : '.', '.');
  } else if (lastComma !== -1) {
    // A lone comma is a decimal separator only with 1-2 trailing digits (1.234,5).
    token = token.slice(lastComma + 1).length <= 2
      ? token.replace(',', '.')
      : token.split(',').join('');
  } else if (lastDot !== -1) {
    const decimals = token.length - lastDot - 1;
    if (decimals === 3 && !/^\d{1,2}\./.test(token)) token = token.split('.').join('');
  }

  const value = Number(token);
  return Number.isFinite(value) && value > 0 ? value : null;
}
