/**
 * Números em formato internacional (E.164, só dígitos, sem "+").
 *
 *   "+27 82 123 4567"  → "27821234567"
 *   "0027821234567"    → "27821234567"
 *   "27821234567"      → "27821234567"     (10 a 15 dígitos: já traz o código do país)
 *   "846000000"        → "258846000000"    (atalho: 9 dígitos 8x/9x = Moçambique)
 *
 * Moçambique (258) é validado a fundo (258 + 8x/9x + 7 dígitos). Para os outros países valida-se o formato E.164
 * (8 a 15 dígitos, sem zero inicial); não existe uma lista de operadores.
 */
export function normalizePhone(phone: string): string | null {
  const p = String(phone ?? '').trim();
  if (p === '' || /[^0-9+\s().\-]/.test(p)) return null; // letras e outros símbolos
  let digits = p.replace(/\D/g, '');
  if (digits === '') return null;

  if (p[0] === '+') {
    if (p.indexOf('+', 1) !== -1) return null; // "+" só à frente
  } else if (p.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.length === 9 && /^[89]/.test(digits)) {
    digits = '258' + digits; // atalho nacional de Moçambique
  } else if (digits.length < 10) {
    return null; // curto demais para já trazer o código do país
  }

  if (!/^[1-9][0-9]{7,14}$/.test(digits)) return null;
  if (digits.startsWith('258') && !/^258[89][0-9]{8}$/.test(digits)) return null;
  return digits;
}

export function isValidPhone(phone: string, allowedCountries?: string[] | null): boolean {
  const n = normalizePhone(phone);
  if (n === null) return false;
  if (!allowedCountries) return true;
  return allowedCountries.some((c) => n.startsWith(String(c)));
}

export function isMozambican(phone: string): boolean {
  const n = normalizePhone(phone);
  return n !== null && n.startsWith('258');
}
