import { InvalidRequestError } from '../errors';
import type { FileInput, Json } from '../http';
import { isMozambican } from '../phone';
import { MAX_BULK_PHONES } from '../validate';
import { Resource } from './base';

const nonEmpty = (fields: unknown, what = 'Nada para atualizar') => {
  if (!fields || typeof fields !== 'object' || Object.keys(fields as object).length === 0) throw new InvalidRequestError(what);
};

export const SENDER_TYPES = ['alfanumerico', 'numerico'] as const;
export const SENDER_USES = ['marketing', 'transacional', 'otp', 'notificacao', 'outros', 'geral'] as const;
export const SENDER_ENTITY_TYPES = ['empresa', 'igreja', 'ong', 'educacao', 'singular', 'outra'] as const;
export const SENDER_FILTER_TYPES = ['keyword_block', 'keyword_allow', 'domain_block', 'rate_limit', 'message_format'] as const;
export const SENDER_DOCUMENT_TYPES = [
  'certidao_comercial', 'alvara', 'nuit', 'nuit_sing', 'logotipo', 'contrato_social', 'licenca_funcionamento', 'estatutos',
  'acto_constitutivo', 'certificado_registo', 'alvara_educacao', 'estatutos_educacao', 'bi_frente', 'bi_verso', 'bi_pass',
  'passaporte_frente', 'passaporte_verso', 'id_representante', 'carta_assinada', 'carta_autorizacao', 'carta_autorizacao_gerada',
  'procuracao', 'autorizacao_atividade', 'outro',
] as const;

/** Sender IDs: pedido, listagem, partilha, filtros e documentos de aprovação. Não há métodos de apagar: use o painel. */
export class SenderIds extends Resource {
  /**
   * Pede um sender ID. ATENÇÃO: o preço é DEBITADO do saldo no momento do pedido.
   * Alfanumérico: 3-11 caracteres A-Z/0-9. Numérico: 3-11 dígitos. O nome é convertido para maiúsculas.
   */
  async request(
    senderId: string,
    type: (typeof SENDER_TYPES)[number],
    use: (typeof SENDER_USES)[number],
    description: string,
    options: { entity_type?: (typeof SENDER_ENTITY_TYPES)[number]; entity_name?: string; compartilhado?: boolean } = {},
  ): Promise<Json> {
    const name = String(senderId ?? '').trim().toUpperCase();
    this.v.oneOf(type, SENDER_TYPES, 'tipo');
    this.v.oneOf(use, SENDER_USES, 'uso');
    if (type === 'alfanumerico' && !/^[A-Z0-9]{3,11}$/.test(name)) throw new InvalidRequestError('Sender ID alfanumérico: 3 a 11 caracteres (A-Z, 0-9, sem espaços nem acentos)');
    if (type === 'numerico' && !/^[0-9]{3,11}$/.test(name)) throw new InvalidRequestError('Sender ID numérico: 3 a 11 dígitos');
    this.v.required(description, 'descricao');
    if ([...description].length > 500) throw new InvalidRequestError("'descricao' excede 500 caracteres");
    const json: Json = { sender_id: name, tipo: type, uso: use, descricao: description };
    if (options.entity_type !== undefined) json.entity_type = this.v.oneOf(options.entity_type, SENDER_ENTITY_TYPES, 'entity_type');
    if (options.entity_name !== undefined) {
      if ([...String(options.entity_name)].length > 255) throw new InvalidRequestError("'entity_name' excede 255 caracteres");
      json.entity_name = String(options.entity_name);
    }
    if (options.compartilhado !== undefined) json.compartilhado = !!options.compartilhado;
    return this.item('POST', '/sender-ids/request', { json });
  }

  /** Filtros: status, tipo, uso, search, has_filters, include_filters. */
  async list(filters: Json = {}): Promise<Json> {
    return this.body('GET', '/sender-ids', { query: filters });
  }
  /** Todos, agrupados por estado (aprovado/pendente/rejeitado). */
  async all(): Promise<Json> {
    return this.item('GET', '/sender-ids/all');
  }
  async withFilters(): Promise<Json> {
    return this.body('GET', '/sender-ids/with-filters');
  }
  async filtersOverview(): Promise<Json> {
    return this.item('GET', '/sender-ids/filters/overview');
  }
  async get(id: number): Promise<Json> {
    return this.item('GET', `/sender-ids/${this.v.positiveInt(id)}`);
  }
  async share(id: number, shared: boolean): Promise<Json> {
    return this.body('PUT', `/sender-ids/${this.v.positiveInt(id)}/share`, { json: { compartilhado: shared ? 1 : 0 } });
  }
  async setDefault(id: number): Promise<Json> {
    return this.body('PUT', `/sender-ids/${this.v.positiveInt(id)}/set-default`);
  }
  async history(id: number): Promise<Json> {
    return this.body('GET', `/sender-ids/${this.v.positiveInt(id)}/history`);
  }
  async activity(id: number): Promise<Json> {
    return this.body('GET', `/sender-ids/${this.v.positiveInt(id)}/activity`);
  }

  async filters(id: number): Promise<Json> {
    return this.body('GET', `/sender-ids/${this.v.positiveInt(id)}/filters`);
  }
  async filterStats(id: number): Promise<Json> {
    return this.body('GET', `/sender-ids/${this.v.positiveInt(id)}/filters/stats`);
  }
  async addFilter(id: number, type: (typeof SENDER_FILTER_TYPES)[number], value: string, config?: Json): Promise<Json> {
    this.v.positiveInt(id);
    this.v.oneOf(type, SENDER_FILTER_TYPES, 'filter_type');
    this.v.required(value, 'filter_value');
    if ([...value].length > 500) throw new InvalidRequestError("'filter_value' excede 500 caracteres");
    const json: Json = { filter_type: type, filter_value: value };
    if (config) json.filter_config = config;
    return this.body('POST', `/sender-ids/${id}/filters`, { json });
  }
  async updateFilter(id: number, filterId: number, fields: Json): Promise<Json> {
    this.v.positiveInt(id);
    this.v.positiveInt(filterId, 'filterId');
    nonEmpty(fields);
    return this.body('PUT', `/sender-ids/${id}/filters/${filterId}`, { json: fields });
  }

  async documents(id: number): Promise<Json> {
    return this.body('GET', `/sender-ids/${this.v.positiveInt(id)}/documents`);
  }
  async documentRequests(id: number): Promise<Json> {
    return this.body('GET', `/sender-ids/${this.v.positiveInt(id)}/doc-requests`);
  }
  /** Envia um documento (PDF/imagem, até 10 MB). `file`: Blob/File ou { data, filename }. */
  async uploadDocument(id: number, type: (typeof SENDER_DOCUMENT_TYPES)[number], file: FileInput): Promise<Json> {
    this.v.positiveInt(id);
    this.v.oneOf(type, SENDER_DOCUMENT_TYPES, 'tipo_documento');
    const r = await this.http.upload('POST', `/sender-ids/${id}/documents`, { tipo_documento: type }, { document: file }, 10 * 1024 * 1024);
    return r.data ?? r;
  }
  async downloadDocument(id: number, docId: number): Promise<Uint8Array> {
    return this.http.download(`/sender-ids/${this.v.positiveInt(id)}/documents/${this.v.positiveInt(docId, 'docId')}/download`);
  }
}

export const BILLING_GATEWAYS = ['mpesa', 'emola', 'bank_transfer', 'paypal', 'txenka', 'manual'] as const;

/** Recargas (topup), faturas e transações. */
export class Billing extends Resource {
  /** Métodos de pagamento ativos (taxas, mínimo/máximo, instruções). */
  async gateways(): Promise<Json> {
    return this.body('GET', '/billing/gateways');
  }

  /** Simula uma recarga: taxa, total a pagar e créditos. Não cria nada. */
  async calculate(amount: number, gateway: (typeof BILLING_GATEWAYS)[number]): Promise<Json> {
    this.checkAmount(amount, gateway);
    return this.item('POST', '/billing/calculate', { json: { amount, gateway } });
  }

  /**
   * Cria uma recarga PENDENTE (não debita nada; o saldo só sobe quando o pagamento é confirmado). mpesa/emola exigem
   * `customerPhone` de Moçambique. A resposta traz payment_to (mpesa/emola), bank_account, redirect_url (PayPal) ou
   * checkout_url (Txenka), e sempre transaction_id/expires_at. Cada chamada cria uma transação nova.
   */
  async topup(amount: number, gateway: (typeof BILLING_GATEWAYS)[number], customerPhone?: string): Promise<Json> {
    this.checkAmount(amount, gateway);
    const json: Json = { amount, gateway };
    const hasPhone = typeof customerPhone === 'string' && customerPhone.trim() !== '';
    if ((gateway === 'mpesa' || gateway === 'emola') && !hasPhone) throw new InvalidRequestError(`'customerPhone' é obrigatório para ${gateway}`);
    if (hasPhone) {
      const n = this.v.phone(customerPhone, 'customerPhone');
      if ((gateway === 'mpesa' || gateway === 'emola') && !isMozambican(n)) throw new InvalidRequestError(`${gateway} só aceita números de Moçambique (258)`);
      json.customer_phone = n;
    }
    return this.item('POST', '/billing/purchase', { json });
  }
  purchase = this.topup;

  async paypalCapture(orderId: string): Promise<Json> {
    return this.body('POST', '/billing/paypal/capture', { json: { order_id: this.v.required(orderId, 'order_id') } });
  }
  async transactions(filters: { limit?: number; offset?: number; status?: string } = {}): Promise<Json> {
    return this.body('GET', '/billing/transactions', { query: filters });
  }
  async transaction(id: number): Promise<Json> {
    return this.item('GET', `/billing/transactions/${this.v.positiveInt(id)}`);
  }
  /** Estado atual (polling depois de pagar). */
  async transactionStatus(id: number): Promise<Json> {
    return this.item('GET', `/billing/transactions/${this.v.positiveInt(id)}/status`);
  }
  /** Comprovativo da transferência (JPG, PNG ou PDF, até 5 MB). */
  async uploadProof(transactionId: number, file: FileInput): Promise<Json> {
    this.v.positiveInt(transactionId, 'transactionId');
    const name = file instanceof Blob ? (file as File).name ?? '' : file?.filename ?? '';
    if (name && !/\.(jpe?g|png|pdf)$/i.test(name)) throw new InvalidRequestError('Comprovativo tem de ser JPG, PNG ou PDF');
    const r = await this.http.upload('PUT', `/billing/transactions/${transactionId}/proof`, {}, { proof: file }, 5 * 1024 * 1024);
    return r.data ?? r;
  }
  /** Reativa uma transação expirada. */
  async reactivate(transactionId: number): Promise<Json> {
    return this.body('POST', `/billing/transactions/${this.v.positiveInt(transactionId, 'transactionId')}/reactivate`);
  }
  async invoices(filters: Json = {}): Promise<Json> {
    return this.body('GET', '/billing/invoices', { query: filters });
  }
  async downloadInvoice(id: number): Promise<Uint8Array> {
    return this.http.download(`/billing/invoices/${this.v.positiveInt(id)}/download`);
  }

  private checkAmount(amount: unknown, gateway: unknown): void {
    this.v.oneOf(gateway, BILLING_GATEWAYS, 'gateway');
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 1 || amount > 1e9) throw new InvalidRequestError("'amount' tem de estar entre 1 e 1000000000 MZN");
  }
}

export class Contacts extends Resource {
  /** Filtros: search, status, group_id, page, limit. */
  async list(filters: Json = {}): Promise<Json> {
    return this.body('GET', '/contacts', { query: filters });
  }
  /** nome e telefone (7-20 dígitos) obrigatórios. 409 se o número já existir. */
  async create(name: string, phone: string, extra: Json = {}): Promise<Json> {
    this.checkPhone(phone);
    return this.item('POST', '/contacts', { json: { nome: this.v.required(name, 'nome'), telefone: phone, ...extra } });
  }
  async get(id: number): Promise<Json> {
    return this.item('GET', `/contacts/${this.v.positiveInt(id)}`);
  }
  async update(id: number, fields: Json): Promise<Json> {
    this.v.positiveInt(id);
    nonEmpty(fields);
    if (fields.telefone !== undefined) this.checkPhone(String(fields.telefone));
    return this.item('PUT', `/contacts/${id}`, { json: fields });
  }
  /** Importa um CSV (ou vCard), até 50000 linhas. */
  async import(csv: FileInput, groupId?: number): Promise<Json> {
    const fields: Record<string, string | number> = {};
    if (groupId !== undefined) fields.group_id = this.v.positiveInt(groupId, 'groupId');
    const r = await this.http.upload('POST', '/contacts/import', fields, { csv_file: csv }, 10 * 1024 * 1024);
    return r.data ?? r;
  }
  async bulkAssign(contactIds: number[], groupIds: number[]): Promise<Json> {
    return this.body('POST', '/contacts/bulk-assign', { json: { contact_ids: this.v.intList(contactIds, 'contact_ids'), group_ids: this.v.intList(groupIds, 'group_ids') } });
  }
  private checkPhone(phone: string): void {
    const d = String(phone ?? '').replace(/\D/g, '');
    if (d.length < 7 || d.length > 20) throw new InvalidRequestError(`Telefone inválido: '${phone}' (7 a 20 dígitos)`);
  }
}

export class ContactGroups extends Resource {
  async list(): Promise<Json> {
    return this.body('GET', '/contacts/groups');
  }
  async create(name: string, options: { descricao?: string; cor?: string; icone?: string; compartilhado?: boolean } = {}): Promise<Json> {
    if ([...this.v.required(name, 'nome')].length > 255) throw new InvalidRequestError("'nome' excede 255 caracteres");
    return this.item('POST', '/contacts/groups', { json: { nome: name, ...options } });
  }
  async get(groupId: number): Promise<Json> {
    return this.item('GET', `/contacts/groups/${this.v.positiveInt(groupId, 'groupId')}`);
  }
  async update(groupId: number, fields: Json): Promise<Json> {
    this.v.positiveInt(groupId, 'groupId');
    nonEmpty(fields);
    return this.body('PUT', `/contacts/groups/${groupId}`, { json: fields });
  }
  async contacts(groupId: number, filters: Json = {}): Promise<Json> {
    return this.body('GET', `/contacts/groups/${this.v.positiveInt(groupId, 'groupId')}/contacts`, { query: filters });
  }
  async addContacts(groupId: number, contactIds: number[]): Promise<Json> {
    this.v.positiveInt(groupId, 'groupId');
    return this.body('POST', `/contacts/groups/${groupId}/contacts`, { json: { contact_ids: this.v.intList(contactIds, 'contact_ids') } });
  }
}

export const TEMPLATE_CATEGORIES = ['marketing', 'transacional', 'otp', 'notificacao', 'cobranca', 'confirmacao', 'outros'] as const;

export class Templates extends Resource {
  async list(filters: Json = {}): Promise<Json> {
    return this.body('GET', '/templates', { query: filters });
  }
  async create(name: string, message: string, category: (typeof TEMPLATE_CATEGORIES)[number] = 'outros'): Promise<Json> {
    this.v.required(name, 'nome');
    this.v.required(message, 'mensagem');
    this.v.oneOf(category, TEMPLATE_CATEGORIES, 'categoria');
    if ([...message].length > 918) throw new InvalidRequestError("'mensagem' excede 918 caracteres");
    if ([...name].length > 255) throw new InvalidRequestError("'nome' excede 255 caracteres");
    return this.item('POST', '/templates', { json: { nome: name, mensagem: message, categoria: category } });
  }
  async get(id: number): Promise<Json> {
    return this.item('GET', `/templates/${this.v.positiveInt(id)}`);
  }
  async update(id: number, fields: { nome?: string; mensagem?: string; categoria?: (typeof TEMPLATE_CATEGORIES)[number] }): Promise<Json> {
    this.v.positiveInt(id);
    nonEmpty(fields);
    if (fields.categoria !== undefined) this.v.oneOf(fields.categoria, TEMPLATE_CATEGORIES, 'categoria');
    if (fields.mensagem !== undefined && [...String(fields.mensagem)].length > 918) throw new InvalidRequestError("'mensagem' excede 918 caracteres");
    return this.body('PUT', `/templates/${id}`, { json: fields });
  }
}

/** Campanhas SMS: criar → adicionar destinatários → enviar. */
export class Campaigns extends Resource {
  async list(filters: Json = {}): Promise<Json> {
    return this.body('GET', '/campaigns', { query: filters });
  }
  async export(filters: Json = {}): Promise<Uint8Array> {
    return this.http.download('/campaigns/export', filters);
  }
  /** Cria um rascunho. `sendAt` opcional (futuro) agenda o envio. */
  async create(name: string, message: string, senderId?: string | number, sendAt?: string): Promise<Json> {
    this.v.required(name, 'nome');
    this.v.message(message, 'mensagem');
    if ([...name].length > 255) throw new InvalidRequestError("'nome' excede 255 caracteres");
    if ([...message].length > 918) throw new InvalidRequestError("'mensagem' excede 918 caracteres");
    const json: Json = { nome: name, mensagem: message };
    if (senderId !== undefined) json.sender_id = senderId;
    if (sendAt !== undefined) json.data_envio = sendAt;
    return this.item('POST', '/campaigns', { json });
  }
  async get(id: number): Promise<Json> {
    return this.item('GET', `/campaigns/${this.v.positiveInt(id)}`);
  }
  async update(id: number, fields: Json): Promise<Json> {
    this.v.positiveInt(id);
    nonEmpty(fields);
    return this.item('PUT', `/campaigns/${id}`, { json: fields });
  }
  async recipients(id: number, filters: Json = {}): Promise<Json> {
    return this.body('GET', `/campaigns/${this.v.positiveInt(id)}/recipients`, { query: filters });
  }
  /** Por números, contactos e/ou grupos (pelo menos um). Só em rascunho/agendada. */
  async addRecipients(id: number, recipients: { phones?: Array<string | number>; contactIds?: number[]; groupIds?: number[] }): Promise<Json> {
    this.v.positiveInt(id);
    const { phones, contactIds, groupIds } = recipients ?? {};
    if (!phones?.length && !contactIds?.length && !groupIds?.length) throw new InvalidRequestError('Indique phones, contactIds ou groupIds');
    const json: Json = {};
    if (phones?.length) json.phones = this.v.phones(phones, MAX_BULK_PHONES);
    if (contactIds?.length) json.contact_ids = this.v.intList(contactIds, 'contact_ids');
    if (groupIds?.length) json.group_ids = this.v.intList(groupIds, 'group_ids');
    return this.body('POST', `/campaigns/${id}/recipients`, { json });
  }
  /** Dispara a campanha (DEBITA o saldo; não é repetível). */
  async send(id: number): Promise<Json> {
    return this.body('POST', `/campaigns/${this.v.positiveInt(id)}/send`);
  }
  async cancel(id: number): Promise<Json> {
    return this.body('POST', `/campaigns/${this.v.positiveInt(id)}/cancel`);
  }
  async report(id: number): Promise<Json> {
    return this.body('GET', `/campaigns/${this.v.positiveInt(id)}/report`);
  }
  async duplicate(id: number): Promise<Json> {
    return this.body('POST', `/campaigns/${this.v.positiveInt(id)}/duplicate`);
  }
}

/** Relatórios (só leitura). Filtros habituais: date_from, date_to, sender_id, status, page, limit. */
export class Reports extends Resource {
  async sms(filters: Json = {}): Promise<Json> {
    return this.body('GET', '/reports/sms', { query: filters });
  }
  async delivery(filters: Json = {}): Promise<Json> {
    return this.body('GET', '/reports/delivery', { query: filters });
  }
  async summary(filters: Json = {}): Promise<Json> {
    return this.body('GET', '/reports/summary', { query: filters });
  }
  async byStatus(filters: Json = {}): Promise<Json> {
    return this.body('GET', '/reports/by-status', { query: filters });
  }
  async byGateway(filters: Json = {}): Promise<Json> {
    return this.body('GET', '/reports/by-gateway', { query: filters });
  }
  async costs(filters: Json = {}): Promise<Json> {
    return this.body('GET', '/reports/costs', { query: filters });
  }
}

export class Dashboard extends Resource {
  async stats(): Promise<Json> {
    return this.item('GET', '/dashboard/stats');
  }
  async recentMessages(filters: Json = {}): Promise<Json> {
    return this.body('GET', '/dashboard/recent-messages', { query: filters });
  }
}

/** Registo dos seus próprios pedidos à API (depurar integrações). */
export class ApiLogs extends Resource {
  async list(filters: Json = {}): Promise<Json> {
    return this.body('GET', '/api-logs', { query: filters });
  }
  async get(id: number): Promise<Json> {
    return this.item('GET', `/api-logs/${this.v.positiveInt(id)}`);
  }
}

export class Notifications extends Resource {
  async list(filters: Json = {}): Promise<Json> {
    return this.body('GET', '/notifications', { query: filters });
  }
  async markRead(id: number): Promise<Json> {
    return this.body('POST', `/notifications/${this.v.positiveInt(id)}/read`);
  }
  async readAll(): Promise<Json> {
    return this.body('POST', '/notifications/read-all');
  }
}
