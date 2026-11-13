import { InvalidRequestError, ValidationError } from '../errors';
import type { Json } from '../http';
import { MAX_BULK_MESSAGES, MAX_BULK_PHONES } from '../validate';
import { Resource } from './base';

export class Sms extends Resource {
  /**
   * Envia um SMS. Números de qualquer país em formato internacional (+27...), ou 9 dígitos de Moçambique.
   * Gasta saldo. Num erro 5xx o SMS pode já estar registado: confirme em `history()` antes de repetir.
   *
   * @param extra provider, device_id, sim_slot
   * @returns {id, phone, status, parts, cost, remaining_balance, ...}
   */
  async send(phone: string, message: string, senderId?: string, extra: Json = {}): Promise<Json> {
    const payload: Json = { phone: this.v.phone(phone), message: this.v.message(message), ...extra };
    const sender = this.v.sender(senderId);
    if (sender !== undefined) payload.sender_id = sender;
    const r = await this.http.request('POST', '/sms/send', { json: payload });
    return r.data ?? {};
  }

  /** Um texto para muitos números (até 100000). {{nome}}, {{telefone}} e {{empresa}} são personalizados. */
  async bulk(phones: Array<string | number>, message: string, senderId?: string): Promise<Json> {
    const payload: Json = { phones: this.v.phones(phones, MAX_BULK_PHONES), message: this.v.message(message) };
    const sender = this.v.sender(senderId);
    if (sender !== undefined) payload.sender_id = sender;
    const r = await this.http.request('POST', '/sms/bulk', { json: payload });
    return r.data ?? {};
  }

  /** Texto diferente por destinatário (até 2000 por pedido). */
  async bulkMessages(messages: Array<{ phone: string; message: string }>, senderId?: string): Promise<Json> {
    if (!Array.isArray(messages) || messages.length === 0) throw new InvalidRequestError("'messages' tem de ser uma lista não vazia");
    if (messages.length > MAX_BULK_MESSAGES) throw new InvalidRequestError(`'messages' admite no máximo ${MAX_BULK_MESSAGES} itens; para mais use bulk()`);
    messages.forEach((m, i) => {
      if (!m || typeof m.message !== 'string' || m.phone === undefined) throw new InvalidRequestError(`messages[${i}] precisa de 'phone' e 'message' (texto)`);
      this.v.message(m.message, `messages[${i}].message`);
    });
    const phones = this.v.phones(messages.map((m) => m.phone), MAX_BULK_MESSAGES, 'messages[].phone');
    const payload: Json = { messages: messages.map((m, i) => ({ ...m, phone: phones[i] })) };
    const sender = this.v.sender(senderId);
    if (sender !== undefined) payload.sender_id = sender;
    const r = await this.http.request('POST', '/sms/bulk', { json: payload });
    return r.data ?? {};
  }

  /** Estado de uma mensagem. `id` é o `id` devolvido por send(). */
  async status(id: string): Promise<Json> {
    return this.item('GET', `/sms/status/${this.enc(this.v.id(id))}`);
  }

  /** Histórico (corpo completo, com paginação). Filtros: sender_id, status, search, date_from, date_to, page, limit. */
  async history(filters: Json = {}): Promise<Json> {
    return this.body('GET', '/sms/history', { query: filters });
  }

  /** Histórico em CSV (até 50000 linhas). */
  async exportHistory(filters: Json = {}): Promise<Uint8Array> {
    return this.http.download('/sms/history/export', filters);
  }

  /** Agenda um envio. `scheduledAt` p.ex. "2026-12-01 09:00:00" (fuso da conta). repeat: none|daily|weekly|monthly. */
  async schedule(numbers: Array<string | number>, message: string, scheduledAt: string, senderId?: string, repeat: 'none' | 'daily' | 'weekly' | 'monthly' = 'none'): Promise<Json> {
    const payload: Json = {
      numbers: this.v.phones(numbers, MAX_BULK_PHONES, 'numbers'),
      message: this.v.message(message),
      scheduled_at: this.v.required(scheduledAt, 'scheduledAt'),
      repeat: this.v.oneOf(repeat, ['none', 'daily', 'weekly', 'monthly'] as const, 'repeat'),
    };
    const sender = this.v.sender(senderId);
    if (sender !== undefined) payload.sender_id = sender;
    return this.item('POST', '/sms/schedule', { json: payload });
  }

  async schedules(): Promise<Json> {
    return this.body('GET', '/sms/schedule');
  }
}

export class Otp extends Resource {
  /** Opções: sender_id, message, digits (4-10), expiry (s), max_attempts, ref_id, metadata, channel, email. Gasta saldo. */
  async send(phone: string, options: Json = {}): Promise<Json> {
    const p = this.v.phone(phone);
    this.v.sender(options.sender_id);
    if (options.digits !== undefined && (Number(options.digits) < 4 || Number(options.digits) > 10)) throw new InvalidRequestError("'digits' tem de estar entre 4 e 10");
    if (options.expiry !== undefined && Number(options.expiry) < 1) throw new InvalidRequestError("'expiry' tem de ser positivo (segundos)");
    const r = await this.http.request('POST', '/otp/send', { json: { phone: p, ...options } });
    return r.data ?? {};
  }

  /**
   * Verifica o código. Lança ValidationError (code WRONG_CODE) se estiver errado;
   * outros códigos: EXPIRED, MAX_ATTEMPTS, ALREADY_VERIFIED, SESSION_NOT_FOUND.
   */
  async verify(sessionId: string, code: string): Promise<Json> {
    return this.body('POST', '/otp/verify', { json: { session_id: this.v.id(sessionId, 'sessionId'), code: this.v.required(String(code ?? ''), 'code') } });
  }

  /** Como verify(), mas devolve false quando o código está simplesmente errado. */
  async check(sessionId: string, code: string): Promise<boolean> {
    try {
      await this.verify(sessionId, code);
      return true;
    } catch (e) {
      if (e instanceof ValidationError && e.code === 'WRONG_CODE') return false;
      throw e;
    }
  }

  async status(sessionId: string): Promise<Json> {
    return this.body('GET', `/otp/status/${this.enc(this.v.id(sessionId, 'sessionId'))}`);
  }

  async cancel(sessionId: string): Promise<Json> {
    return this.body('POST', `/otp/cancel/${this.enc(this.v.id(sessionId, 'sessionId'))}`);
  }

  /** Filtros: phone, status (pending|verified|expired|cancelled), ref_id, page, limit. */
  async sessions(filters: Json = {}): Promise<Json> {
    return this.body('GET', '/otp/sessions', { query: filters });
  }

  async stats(days = 7): Promise<Json> {
    return this.body('GET', '/otp/stats', { query: { days: Math.max(1, Math.min(90, Math.trunc(days))) } });
  }
}

export class Account extends Resource {
  /** {balance, currency, sms_price, estimated_sms, account:{name,email,company}} */
  async balance(): Promise<Json> {
    const r = await this.http.request('GET', '/v1/account/balance');
    return r.data ?? {};
  }

  async profile(): Promise<Json> {
    return this.item('GET', '/settings/profile');
  }

  /** Só name, phone, timezone e language (pt|en). Palavra-passe e email não se mudam por aqui. */
  async updateProfile(fields: { name?: string; phone?: string; timezone?: string; language?: 'pt' | 'en' }): Promise<Json> {
    const allowed = ['name', 'phone', 'timezone', 'language'];
    const unknown = Object.keys(fields ?? {}).filter((k) => !allowed.includes(k));
    if (unknown.length) throw new InvalidRequestError(`Campos não suportados: ${unknown.join(', ')}. Aceites: ${allowed.join(', ')}`);
    if (Object.keys(fields ?? {}).length === 0) throw new InvalidRequestError('Nada para atualizar');
    if (fields.language !== undefined && !['pt', 'en'].includes(fields.language)) throw new InvalidRequestError("'language' tem de ser pt ou en");
    return this.body('PUT', '/settings/profile', { json: fields });
  }

  async plan(): Promise<Json> {
    return this.item('GET', '/account/plan');
  }

  async tenantPlans(): Promise<Json> {
    return this.item('GET', '/account/tenant/plans');
  }

  async tenantInfo(): Promise<Json> {
    return this.item('GET', '/tenant/info');
  }

  async pricing(): Promise<Json> {
    return this.item('GET', '/tenant/pricing');
  }

  /** Estado público da API (bom para health checks). */
  async apiStatus(): Promise<Json> {
    return this.body('GET', '/status');
  }
}

export const WEBHOOK_EVENTS = [
  'sms.sent', 'sms.delivered', 'sms.undelivered', 'sms.failed', 'sms.expired',
  'sms.cancelled', 'sms.undeliverable', 'sms.rejected', 'sms.unknown',
] as const;

/** Gestão dos webhooks (URLs que a MozeSMS chama com o estado das mensagens). Para os receber, veja verifyWebhookSignature. */
export class Webhooks extends Resource {
  static readonly EVENTS = WEBHOOK_EVENTS;

  async list(): Promise<Json> {
    return this.body('GET', '/webhooks');
  }

  /** Sem `secret` a API gera um (whsec_...) e devolve-o: guarde-o para verificar assinaturas. */
  async create(name: string, url: string, events: string[], secret?: string): Promise<Json> {
    if (this.v.required(name, 'name').length > 100) throw new InvalidRequestError("'name' tem de ter entre 1 e 100 caracteres");
    if (!/^https?:\/\/[^\s/]+/i.test(String(url))) throw new InvalidRequestError(`'url' inválida: '${url}'`);
    this.checkEvents(events);
    const json: Json = { name, url, events };
    if (secret !== undefined) json.secret = secret;
    return this.body('POST', '/webhooks', { json });
  }

  async get(id: number): Promise<Json> {
    return this.body('GET', `/webhooks/${this.v.positiveInt(id)}`);
  }

  async update(id: number, fields: Json): Promise<Json> {
    this.v.positiveInt(id);
    if (!fields || Object.keys(fields).length === 0) throw new InvalidRequestError('Nada para atualizar');
    if (fields.events !== undefined) this.checkEvents(fields.events);
    return this.body('PUT', `/webhooks/${id}`, { json: fields });
  }

  async toggle(id: number): Promise<Json> {
    return this.body('POST', `/webhooks/${this.v.positiveInt(id)}/toggle`);
  }

  /** Pede à API que envie um evento de teste. */
  async test(id: number): Promise<Json> {
    return this.body('POST', `/webhooks/${this.v.positiveInt(id)}/test`);
  }

  async logs(id: number): Promise<Json> {
    return this.body('GET', `/webhooks/${this.v.positiveInt(id)}/logs`);
  }

  private checkEvents(events: unknown): void {
    if (!Array.isArray(events) || events.length === 0) throw new InvalidRequestError("'events' tem de ter pelo menos um evento");
    const bad = events.map(String).filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
    if (bad.length) throw new InvalidRequestError(`Eventos inválidos: ${bad.join(', ')}`, bad);
  }
}
