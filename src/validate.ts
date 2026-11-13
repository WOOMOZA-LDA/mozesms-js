import { InvalidRequestError } from './errors';
import { normalizePhone } from './phone';

export const MAX_MESSAGE_BYTES = 60000;
export const MAX_SENDER_LEN = 50;
export const MAX_BULK_PHONES = 100000;
export const MAX_BULK_MESSAGES = 2000;

const encoder = new TextEncoder();

/** Validação local: o que falha aqui não chega à API e, por isso, não é cobrado. */
export class Validator {
  constructor(
    private readonly checkPhones = true,
    private readonly allowedCountries: string[] | null = null,
  ) {}

  /** Devolve o número normalizado (E.164, só dígitos). Com validatePhones=false devolve-o como veio. */
  phone(phone: unknown, field = 'phone'): string {
    if (typeof phone !== 'string' && typeof phone !== 'number') throw new InvalidRequestError(`'${field}' é obrigatório`);
    const raw = String(phone);
    if (raw.trim() === '') throw new InvalidRequestError(`'${field}' é obrigatório`);
    if (!this.checkPhones) return raw;
    const n = normalizePhone(raw);
    if (n === null) {
      throw new InvalidRequestError(
        `Número inválido: '${raw}'. Use o formato internacional (+258846000000, +27821234567) ou 9 dígitos de Moçambique (84xxxxxxx).`,
        [raw],
      );
    }
    if (!this.countryAllowed(n)) {
      throw new InvalidRequestError(
        `Número de um país não permitido: '${raw}'. Países aceites (allowedCountries): ${(this.allowedCountries ?? []).join(', ')}`,
        [raw],
      );
    }
    return n;
  }

  /** Devolve os números normalizados, na mesma ordem. Recusa o lote todo se algum for inválido (a API cobra os inválidos). */
  phones(phones: unknown, max: number, field = 'phones'): string[] {
    if (!Array.isArray(phones) || phones.length === 0) throw new InvalidRequestError(`'${field}' tem de ser uma lista não vazia`);
    if (phones.length > max) throw new InvalidRequestError(`'${field}' admite no máximo ${max} números (recebeu ${phones.length})`);
    const bad: string[] = [];
    const out: string[] = [];
    for (const p of phones) {
      if (typeof p !== 'string' && typeof p !== 'number') {
        bad.push(typeof p);
        continue;
      }
      const raw = String(p);
      if (raw.trim() === '') bad.push(raw);
      else if (!this.checkPhones) out.push(raw);
      else {
        const n = normalizePhone(raw);
        if (n === null || !this.countryAllowed(n)) bad.push(raw);
        else out.push(n);
      }
    }
    if (bad.length) {
      const shown = bad.slice(0, 10).join(', ') + (bad.length > 10 ? ', ...' : '');
      throw new InvalidRequestError(`${bad.length} número(s) inválido(s) em '${field}': ${shown}. Filtre com isValidPhone().`, bad);
    }
    return out;
  }

  message(message: unknown, field = 'message'): string {
    if (typeof message !== 'string' || message.trim() === '') throw new InvalidRequestError(`'${field}' é obrigatório`);
    if (encoder.encode(message).length > MAX_MESSAGE_BYTES) throw new InvalidRequestError(`'${field}' excede ${MAX_MESSAGE_BYTES} bytes`);
    return message;
  }

  sender(sender: unknown): string | undefined {
    if (sender === undefined || sender === null) return undefined;
    if (typeof sender !== 'string' || sender.trim() === '' || [...sender].length > MAX_SENDER_LEN) {
      throw new InvalidRequestError(`sender_id tem de ter entre 1 e ${MAX_SENDER_LEN} caracteres`);
    }
    return sender;
  }

  id(id: unknown, field = 'id'): string {
    if ((typeof id !== 'string' && typeof id !== 'number') || String(id).trim() === '') throw new InvalidRequestError(`'${field}' é obrigatório`);
    return String(id);
  }

  positiveInt(n: unknown, field = 'id'): number {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new InvalidRequestError(`'${field}' tem de ser um inteiro positivo`);
    return n;
  }

  intList(ids: unknown, field: string): number[] {
    if (!Array.isArray(ids) || ids.length === 0) throw new InvalidRequestError(`'${field}' tem de ser uma lista não vazia de inteiros`);
    return ids.map((v) => {
      const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new InvalidRequestError(`'${field}' só aceita inteiros positivos`);
      return n;
    });
  }

  oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
      throw new InvalidRequestError(`'${field}' inválido. Valores aceites: ${allowed.join(', ')}`);
    }
    return value as T;
  }

  required(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim() === '') throw new InvalidRequestError(`'${field}' é obrigatório`);
    return value;
  }

  private countryAllowed(normalized: string): boolean {
    return !this.allowedCountries || this.allowedCountries.some((c) => normalized.startsWith(c));
  }
}
