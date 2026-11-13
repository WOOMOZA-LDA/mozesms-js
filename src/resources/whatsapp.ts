import { InvalidRequestError } from '../errors';
import type { FileInput, HttpClient, Json } from '../http';
import { MAX_BULK_PHONES } from '../validate';
import { Resource } from './base';

const nonEmpty = (fields: unknown, what = 'Nada para atualizar') => {
  if (!fields || typeof fields !== 'object' || Object.keys(fields as object).length === 0) throw new InvalidRequestError(what);
};

export const WHATSAPP_MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'pdf'] as const;
export const AUTOMATION_TYPES = ['chatbot', 'keyword', 'welcome', 'schedule'] as const;

/** Modelos de mensagem WhatsApp. */
export class WhatsAppTemplates extends Resource {
  async list(filters: { session_id?: string; categoria?: string; search?: string } = {}): Promise<Json> {
    return this.body('GET', '/whatsapp/templates', { query: filters });
  }
  /** Extra: categoria, session_id, variables, buttons, footer, media_type, media_url, is_active. */
  async create(name: string, message: string, extra: Json = {}): Promise<Json> {
    return this.item('POST', '/whatsapp/templates', { json: { nome: this.v.required(name, 'nome'), mensagem: this.v.required(message, 'mensagem'), ...extra } });
  }
  async get(id: number): Promise<Json> {
    return this.item('GET', `/whatsapp/templates/${this.v.positiveInt(id)}`);
  }
  async update(id: number, fields: Json): Promise<Json> {
    this.v.positiveInt(id);
    nonEmpty(fields);
    return this.item('PUT', `/whatsapp/templates/${id}`, { json: fields });
  }
  async toggle(id: number): Promise<Json> {
    return this.body('POST', `/whatsapp/templates/${this.v.positiveInt(id)}/toggle`);
  }
  /** Envia o modelo (COBRA a mensagem). `variables` substitui as variáveis do texto. */
  async send(id: number, sessionId: string, to: string, variables: Record<string, string> = {}): Promise<Json> {
    this.v.positiveInt(id);
    const json: Json = { session_id: this.v.required(sessionId, 'session_id'), to: this.v.phone(to, 'to') };
    if (Object.keys(variables).length) json.variables = variables;
    return this.body('POST', `/whatsapp/templates/${id}/send`, { json });
  }
}

/** Etiquetas de contactos WhatsApp. */
export class WhatsAppLabels extends Resource {
  async list(): Promise<Json> {
    return this.body('GET', '/whatsapp/labels');
  }
  async create(name: string, color?: string, description?: string): Promise<Json> {
    const json: Json = { name: this.v.required(name, 'name') };
    if (color !== undefined) json.color = color;
    if (description !== undefined) json.description = description;
    return this.item('POST', '/whatsapp/labels', { json });
  }
  async update(id: number, fields: { name?: string; color?: string; description?: string }): Promise<Json> {
    this.v.positiveInt(id);
    nonEmpty(fields);
    return this.body('PUT', `/whatsapp/labels/${id}`, { json: fields });
  }
  async contacts(labelId: number): Promise<Json> {
    return this.body('GET', `/whatsapp/labels/${this.v.positiveInt(labelId, 'labelId')}/contacts`);
  }
  async ofContact(contactId: number): Promise<Json> {
    return this.body('GET', `/whatsapp/contacts/${this.v.positiveInt(contactId, 'contactId')}/labels`);
  }
  async addToContact(contactId: number, labelIds: number[]): Promise<Json> {
    this.v.positiveInt(contactId, 'contactId');
    return this.body('POST', `/whatsapp/contacts/${contactId}/labels`, { json: { label_ids: this.v.intList(labelIds, 'label_ids') } });
  }
}

/** Campanhas WhatsApp (envio em massa com fila). */
export class WhatsAppCampaigns extends Resource {
  async list(filters: { session_id?: string; status?: string } = {}): Promise<Json> {
    return this.body('GET', '/whatsapp/campaigns', { query: filters });
  }
  /** `fields`: message, phones/recipients, media... conforme o painel. `phones` é validado e normalizado. */
  async create(sessionId: string, name: string, fields: Json): Promise<Json> {
    const json: Json = { session_id: this.v.required(sessionId, 'session_id'), name: this.v.required(name, 'name'), ...fields };
    if (fields?.phones !== undefined) json.phones = this.v.phones(fields.phones, MAX_BULK_PHONES);
    return this.item('POST', '/whatsapp/campaigns', { json });
  }
  async get(id: number): Promise<Json> {
    return this.item('GET', `/whatsapp/campaigns/${this.v.positiveInt(id)}`);
  }
  /** Começa a enviar (COBRA cada mensagem). */
  async start(id: number): Promise<Json> {
    return this.body('POST', `/whatsapp/campaigns/${this.v.positiveInt(id)}/start`);
  }
  async pause(id: number): Promise<Json> {
    return this.body('POST', `/whatsapp/campaigns/${this.v.positiveInt(id)}/pause`);
  }
  async resume(id: number): Promise<Json> {
    return this.body('POST', `/whatsapp/campaigns/${this.v.positiveInt(id)}/resume`);
  }
  /** Para o envio; o que já foi enviado e o registo ficam. */
  async cancel(id: number): Promise<Json> {
    return this.body('POST', `/whatsapp/campaigns/${this.v.positiveInt(id)}/cancel`);
  }
  async report(id: number): Promise<Json> {
    return this.body('GET', `/whatsapp/campaigns/${this.v.positiveInt(id)}/report`);
  }
}

/** Automações: chatbot (fluxos com passos), keyword, welcome e schedule; mais definições de IA e registo. */
export class WhatsAppAutomations extends Resource {
  static readonly TYPES = AUTOMATION_TYPES;

  async list(type: (typeof AUTOMATION_TYPES)[number], filters: Json = {}): Promise<Json> {
    return this.body('GET', `/whatsapp/automations/${this.v.oneOf(type, AUTOMATION_TYPES, 'type')}`, { query: filters });
  }
  /** `fields` conforme o tipo (keywords, match_mode, response_message, schedule_type, run_at...). `name` e `session_id` são obrigatórios. */
  async create(type: (typeof AUTOMATION_TYPES)[number], fields: Json): Promise<Json> {
    this.v.oneOf(type, AUTOMATION_TYPES, 'type');
    this.v.required(fields?.name, 'name');
    this.v.required(fields?.session_id, 'session_id');
    return this.item('POST', `/whatsapp/automations/${type}`, { json: fields });
  }
  async get(type: (typeof AUTOMATION_TYPES)[number], id: number): Promise<Json> {
    return this.item('GET', `/whatsapp/automations/${this.v.oneOf(type, AUTOMATION_TYPES, 'type')}/${this.v.positiveInt(id)}`);
  }
  async update(type: (typeof AUTOMATION_TYPES)[number], id: number, fields: Json): Promise<Json> {
    this.v.oneOf(type, AUTOMATION_TYPES, 'type');
    this.v.positiveInt(id);
    nonEmpty(fields);
    return this.item('PUT', `/whatsapp/automations/${type}/${id}`, { json: fields });
  }
  async toggle(type: (typeof AUTOMATION_TYPES)[number], id: number): Promise<Json> {
    return this.body('POST', `/whatsapp/automations/${this.v.oneOf(type, AUTOMATION_TYPES, 'type')}/${this.v.positiveInt(id)}/toggle`);
  }
  /** Executa já uma automação agendada (COBRA as mensagens). */
  async runScheduleNow(id: number): Promise<Json> {
    return this.body('POST', `/whatsapp/automations/schedule/${this.v.positiveInt(id)}/run-now`);
  }
  async addStep(flowId: number, fields: Json): Promise<Json> {
    this.v.positiveInt(flowId, 'flowId');
    nonEmpty(fields, 'Passo vazio');
    return this.item('POST', `/whatsapp/automations/chatbot/${flowId}/steps`, { json: fields });
  }
  async updateStep(flowId: number, stepId: number, fields: Json): Promise<Json> {
    this.v.positiveInt(flowId, 'flowId');
    this.v.positiveInt(stepId, 'stepId');
    nonEmpty(fields);
    return this.item('PUT', `/whatsapp/automations/chatbot/${flowId}/steps/${stepId}`, { json: fields });
  }
  async aiSettings(): Promise<Json> {
    return this.item('GET', '/whatsapp/automations/ai/settings');
  }
  async saveAiSettings(settings: Json): Promise<Json> {
    nonEmpty(settings, 'Definições vazias');
    return this.body('PUT', '/whatsapp/automations/ai/settings', { json: settings });
  }
  async aiConversations(filters: Json = {}): Promise<Json> {
    return this.body('GET', '/whatsapp/automations/ai/conversations', { query: filters });
  }
  /** Testa a resposta da IA sem enviar nada. */
  async testAi(message: string, sessionId?: string): Promise<Json> {
    const json: Json = { message: this.v.required(message, 'message') };
    if (sessionId !== undefined) json.session_id = sessionId;
    return this.body('POST', '/whatsapp/automations/ai/test', { json });
  }
  async log(filters: Json = {}): Promise<Json> {
    return this.body('GET', '/whatsapp/automation/log', { query: filters });
  }
}

/** Planos e faturação do WhatsApp. Cancelar uma subscrição faz-se no painel. */
export class WhatsAppBilling extends Resource {
  async plans(): Promise<Json> {
    return this.body('GET', '/whatsapp/billing/plans');
  }
  async instances(): Promise<Json> {
    return this.body('GET', '/whatsapp/billing/instances');
  }
  /** Subscreve um plano para uma sessão (DEBITA o saldo). */
  async subscribe(sessionId: string, planId: number, billingDay = 1): Promise<Json> {
    if (!Number.isInteger(billingDay) || billingDay < 1 || billingDay > 28) throw new InvalidRequestError("'billingDay' tem de estar entre 1 e 28");
    return this.body('POST', '/whatsapp/billing/subscribe', {
      json: { session_id: this.v.required(sessionId, 'session_id'), plan_id: this.v.positiveInt(planId, 'planId'), billing_day: billingDay },
    });
  }
  async changePlan(instanceId: number, planId: number): Promise<Json> {
    return this.body('POST', `/whatsapp/billing/instances/${this.v.positiveInt(instanceId, 'instanceId')}/change-plan`, { json: { plan_id: this.v.positiveInt(planId, 'planId') } });
  }
  async configure(instanceId: number, config: Json): Promise<Json> {
    this.v.positiveInt(instanceId, 'instanceId');
    nonEmpty(config, 'Configuração vazia');
    return this.body('PATCH', `/whatsapp/billing/instances/${instanceId}/config`, { json: config });
  }
  async usage(sessionId?: string): Promise<Json> {
    return this.body('GET', sessionId === undefined ? '/whatsapp/billing/usage' : `/whatsapp/billing/sessions/${this.enc(sessionId)}/usage`);
  }
  async invoices(sessionId?: string): Promise<Json> {
    return this.body('GET', sessionId === undefined ? '/whatsapp/billing/invoices' : `/whatsapp/billing/sessions/${this.enc(sessionId)}/invoices`);
  }
  async charges(sessionId?: string): Promise<Json> {
    return this.body('GET', sessionId === undefined ? '/whatsapp/billing/charges' : `/whatsapp/billing/sessions/${this.enc(sessionId)}/charges`);
  }
}

/**
 * WhatsApp: sessões, envio (texto, média, ficheiros, localização, grupos), grupos, contactos e webhooks da sessão.
 * Sub-recursos: templates, labels, campaigns, automations, billing. Números de qualquer país.
 * Não há métodos de apagar (sessões, webhooks, ficheiros): faça-o no painel.
 */
export class WhatsApp extends Resource {
  readonly templates: WhatsAppTemplates;
  readonly labels: WhatsAppLabels;
  readonly campaigns: WhatsAppCampaigns;
  readonly automations: WhatsAppAutomations;
  readonly billing: WhatsAppBilling;

  constructor(http: HttpClient) {
    super(http);
    this.templates = new WhatsAppTemplates(http);
    this.labels = new WhatsAppLabels(http);
    this.campaigns = new WhatsAppCampaigns(http);
    this.automations = new WhatsAppAutomations(http);
    this.billing = new WhatsAppBilling(http);
  }

  private s(sessionId: string): string {
    return `/whatsapp/sessions/${this.enc(this.v.required(sessionId, 'sessionId'))}`;
  }

  // ---- sessões ----
  async plans(): Promise<Json> {
    return this.billing.plans();
  }
  async sessions(): Promise<Json> {
    return this.body('GET', '/whatsapp/sessions');
  }
  /** Cria uma sessão e subscreve o plano (pode debitar o saldo). */
  async createSession(name: string, planId: number, billingDay = 1): Promise<Json> {
    if (!Number.isInteger(billingDay) || billingDay < 1 || billingDay > 28) throw new InvalidRequestError("'billingDay' tem de estar entre 1 e 28");
    return this.item('POST', '/whatsapp/sessions', { json: { name: this.v.required(name, 'name'), plan_id: this.v.positiveInt(planId, 'planId'), billing_day: billingDay } });
  }
  async session(sessionId: string): Promise<Json> {
    return this.item('GET', this.s(sessionId));
  }
  async sessionDetails(sessionId: string): Promise<Json> {
    return this.item('GET', this.s(sessionId) + '/details');
  }
  async connect(sessionId: string): Promise<Json> {
    return this.body('POST', this.s(sessionId) + '/connect');
  }
  async connectWithCode(sessionId: string, phone: string): Promise<Json> {
    return this.body('POST', this.s(sessionId) + '/connect/code', { json: { phone: this.v.phone(phone) } });
  }
  async qr(sessionId: string): Promise<Json> {
    return this.body('GET', this.s(sessionId) + '/qr');
  }
  /** QR como imagem (bytes PNG). */
  async qrImage(sessionId: string): Promise<Uint8Array> {
    return this.http.download(this.s(sessionId) + '/qr/image');
  }
  /** Verifica se um número tem WhatsApp. */
  async lookup(sessionId: string, phone: string): Promise<Json> {
    return this.body('GET', `${this.s(sessionId)}/lookup/${this.enc(this.v.phone(phone))}`);
  }
  async settings(sessionId: string): Promise<Json> {
    return this.item('GET', this.s(sessionId) + '/settings');
  }
  async updateSettings(sessionId: string, settings: Json): Promise<Json> {
    nonEmpty(settings);
    return this.body('PUT', this.s(sessionId) + '/settings', { json: settings });
  }

  // ---- envio ----
  /** Envia texto. Cada mensagem é cobrada; não repita sem verificar messages(). */
  async sendText(sessionId: string, phone: string, message: string): Promise<Json> {
    return this.body('POST', '/whatsapp/send', {
      json: { session_id: this.v.required(sessionId, 'session_id'), phone: this.v.phone(phone), message: this.v.message(message), type: 'text' },
    });
  }
  /** Texto para vários números: os primeiros 5 saem já, os restantes vão para a fila. */
  async sendTextBulk(sessionId: string, phones: Array<string | number>, message: string): Promise<Json> {
    return this.body('POST', '/whatsapp/send', {
      json: { session_id: this.v.required(sessionId, 'session_id'), phones: this.v.phones(phones, MAX_BULK_PHONES), message: this.v.message(message), type: 'text' },
    });
  }
  /** Média por URL pública ou base64. type: image, video, audio, document, pdf. */
  async sendMedia(sessionId: string, phone: string, type: (typeof WHATSAPP_MEDIA_TYPES)[number], media: string, options: { caption?: string; filename?: string; ptt?: boolean } = {}): Promise<Json> {
    this.v.oneOf(type, WHATSAPP_MEDIA_TYPES, 'type');
    const field = type === 'pdf' ? 'document' : type;
    return this.body('POST', `/whatsapp/send/${type}`, {
      json: { session_id: this.v.required(sessionId, 'session_id'), phone: this.v.phone(phone), [field]: this.v.required(media, 'media'), ...options },
    });
  }
  /** Ficheiro diretamente (até 16 MB). */
  async sendFile(sessionId: string, phone: string, file: FileInput, caption?: string): Promise<Json> {
    const fields: Record<string, string> = { session_id: this.v.required(sessionId, 'session_id'), phone: this.v.phone(phone) };
    if (caption !== undefined) fields.caption = caption;
    return this.http.upload('POST', '/whatsapp/send/upload', fields, { file }, 16 * 1024 * 1024);
  }
  async uploadMedia(file: FileInput): Promise<Json> {
    const r = await this.http.upload('POST', '/whatsapp/upload', {}, { file }, 16 * 1024 * 1024);
    return r.data ?? r;
  }
  async media(id: string): Promise<Uint8Array> {
    return this.http.download(`/whatsapp/media/${this.enc(this.v.required(id, 'id'))}`);
  }
  async sendLocation(sessionId: string, phone: string, latitude: number, longitude: number, name?: string, address?: string): Promise<Json> {
    if (!(latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180)) throw new InvalidRequestError('Coordenadas fora do intervalo válido');
    const json: Json = { session_id: this.v.required(sessionId, 'session_id'), phone: this.v.phone(phone), latitude, longitude };
    if (name !== undefined) json.name = name;
    if (address !== undefined) json.address = address;
    return this.body('POST', '/whatsapp/send/location', { json });
  }
  async sendGroup(sessionId: string, groupJid: string, message: string): Promise<Json> {
    return this.body('POST', '/whatsapp/send/group', { json: { session_id: this.v.required(sessionId, 'session_id'), group_jid: this.v.required(groupJid, 'group_jid'), message: this.v.message(message) } });
  }
  async messages(filters: Json = {}): Promise<Json> {
    return this.body('GET', '/whatsapp/messages', { query: filters });
  }
  async messageStatus(id: number): Promise<Json> {
    return this.body('GET', `/whatsapp/messages/${this.v.positiveInt(id)}/status`);
  }

  // ---- grupos ----
  async groups(sessionId: string, filters: Json = {}): Promise<Json> {
    return this.body('GET', this.s(sessionId) + '/groups', { query: filters });
  }
  async groupInfo(sessionId: string, groupJid: string): Promise<Json> {
    return this.body('GET', `${this.s(sessionId)}/groups/${this.enc(this.v.required(groupJid, 'groupJid'))}/info`);
  }
  async groupMembers(sessionId: string, groupJid: string): Promise<Json> {
    return this.body('GET', `${this.s(sessionId)}/groups/${this.enc(this.v.required(groupJid, 'groupJid'))}/members`);
  }
  /** Cria um grupo (mínimo 2 membros, números de qualquer país). */
  async createGroup(name: string, members: string[], topic?: string): Promise<Json> {
    if (!Array.isArray(members) || members.length < 2) throw new InvalidRequestError("'members' precisa de pelo menos 2 números");
    const json: Json = { name: this.v.required(name, 'name'), members: this.v.phones(members, 1024, 'members') };
    if (topic !== undefined) json.topic = topic;
    return this.item('POST', '/whatsapp/groups/create', { json });
  }
  async updateGroup(groupJid: string, fields: { name?: string; topic?: string; announce_only?: boolean }): Promise<Json> {
    nonEmpty(fields);
    return this.body('PUT', `/whatsapp/groups/${this.enc(this.v.required(groupJid, 'groupJid'))}`, { json: fields });
  }
  async addGroupMembers(groupJid: string, members: string[]): Promise<Json> {
    return this.groupOp(groupJid, 'add', members);
  }
  async removeGroupMembers(groupJid: string, members: string[]): Promise<Json> {
    return this.groupOp(groupJid, 'remove', members);
  }
  async promoteGroupMembers(groupJid: string, members: string[]): Promise<Json> {
    return this.groupOp(groupJid, 'promote', members);
  }
  async demoteGroupMembers(groupJid: string, members: string[]): Promise<Json> {
    return this.groupOp(groupJid, 'demote', members);
  }
  /** A sessão sai do grupo. */
  async leaveGroup(groupJid: string): Promise<Json> {
    return this.body('POST', `/whatsapp/groups/${this.enc(this.v.required(groupJid, 'groupJid'))}/leave`);
  }
  private groupOp(groupJid: string, op: string, members: string[]): Promise<Json> {
    return this.body('POST', `/whatsapp/groups/${this.enc(this.v.required(groupJid, 'groupJid'))}/members/${op}`, { json: { members: this.v.phones(members, 1024, 'members') } });
  }

  // ---- contactos ----
  async profile(phone: string): Promise<Json> {
    return this.body('GET', `/whatsapp/profile/${this.enc(this.v.phone(phone))}`);
  }
  async contacts(sessionId: string, filters: Json = {}): Promise<Json> {
    return this.body('GET', this.s(sessionId) + '/contacts', { query: filters });
  }
  async syncContacts(sessionId: string): Promise<Json> {
    return this.body('POST', this.s(sessionId) + '/sync/contacts');
  }
  async syncGroups(sessionId: string): Promise<Json> {
    return this.body('POST', this.s(sessionId) + '/sync/groups');
  }
  async blockContact(sessionId: string, phone: string): Promise<Json> {
    return this.body('POST', `${this.s(sessionId)}/block/${this.enc(this.v.phone(phone))}`);
  }
  async unblockContact(sessionId: string, phone: string): Promise<Json> {
    return this.body('POST', `${this.s(sessionId)}/unblock/${this.enc(this.v.phone(phone))}`);
  }

  // ---- webhooks da sessão ----
  async webhooks(sessionId: string): Promise<Json> {
    return this.body('GET', this.s(sessionId) + '/webhooks');
  }
  async registerWebhook(sessionId: string, url: string, events: string[] | string = '*', secret?: string): Promise<Json> {
    if (!/^https:\/\/[^\s/]+/i.test(String(url))) throw new InvalidRequestError("'url' tem de ser https");
    const json: Json = { url, events };
    if (secret !== undefined) json.secret = secret;
    return this.body('POST', this.s(sessionId) + '/webhooks', { json });
  }
  async testWebhook(sessionId: string, webhookId: string): Promise<Json> {
    return this.body('POST', `${this.s(sessionId)}/webhooks/${this.enc(this.v.required(webhookId, 'webhookId'))}/test`);
  }
}
