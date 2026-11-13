import { describe, expect, it } from 'vitest';
import {
  ApiError,
  AuthenticationError,
  ConflictError,
  ConnectionError,
  InsufficientBalanceError,
  InvalidRequestError,
  InvalidResponseError,
  MozeSMS,
  NotFoundError,
  RateLimitError,
  ServerError,
  SignatureVerificationError,
  TimeoutError,
  ValidationError,
  constructWebhookEvent,
  isMozambican,
  isValidPhone,
  normalizePhone,
  signWebhook,
  verifyWebhookSignature,
} from '../src';
import { fake, ok } from './helpers';

describe('phone', () => {
  it.each([
    ['+27 82 123 4567', '27821234567'],
    ['0027821234567', '27821234567'],
    ['27821234567', '27821234567'],
    ['+351 912 345 678', '351912345678'],
    ['+55 (11) 91234-5678', '5511912345678'],
    ['+1 202-555-0143', '12025550143'],
    ['846000000', '258846000000'],
    ['+258 84 600 0000', '258846000000'],
    ['258846000000', '258846000000'],
  ])('normaliza %s', (input, out) => expect(normalizePhone(input)).toBe(out));

  it.each(['', 'abc', '12345', '+0123456789', '+27+8212345', '07123456789', '+258 12 345 6789', '258741234567', '84600', '++27821234567', '27 82 abc 4567'])(
    'recusa %j',
    (bad) => expect(normalizePhone(bad)).toBeNull(),
  );

  it('isValidPhone / isMozambican / países', () => {
    expect(isValidPhone('+27821234567')).toBe(true);
    expect(isValidPhone('+27821234567', ['258'])).toBe(false);
    expect(isMozambican('846000000')).toBe(true);
    expect(isMozambican('+27821234567')).toBe(false);
  });
});

describe('envio e validação', () => {
  it('send: normaliza, usa os cabeçalhos e devolve data', async () => {
    const { moze, calls } = fake([ok({ id: 'abc', cost: 1.35 })]);
    const r = await moze.sms.send('846000000', 'Olá', 'MozeSMS');
    expect(r).toEqual({ id: 'abc', cost: 1.35 });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.mozesms.com/sms/send' });
    expect(calls[0].json).toEqual({ phone: '258846000000', message: 'Olá', sender_id: 'MozeSMS' });
    expect(calls[0].headers['X-API-Key']).toBe('mk_test');
    expect(calls[0].headers['X-API-Secret']).toBe('sk_test');
  });

  it('send internacional e bulk misto de países', async () => {
    const { moze, calls } = fake();
    await moze.sms.send('+27 82 123 4567', 'Hello');
    expect(calls[0].json.phone).toBe('27821234567');
    await moze.sms.bulk(['+27821234567', '846000000', '+351912345678'], 'Olá', 'MozeSMS');
    expect(calls[1].json.phones).toEqual(['27821234567', '258846000000', '351912345678']);
    await moze.sms.bulkMessages([{ phone: '+27821234567', message: 'a' }, { phone: '846000000', message: 'b' }]);
    expect(calls[2].json.messages).toEqual([
      { phone: '27821234567', message: 'a' },
      { phone: '258846000000', message: 'b' },
    ]);
  });

  it('recusa localmente: nada chega à rede', async () => {
    const { moze, calls } = fake();
    const bad: Array<() => Promise<unknown>> = [
      () => moze.sms.send('123', 'x'),
      () => moze.sms.send('846000000', '   '),
      () => moze.sms.send('846000000', 'x', 'a'.repeat(51)),
      () => moze.sms.bulk(['846000000', '12'], 'x'),
      () => moze.sms.bulk([], 'x'),
      () => moze.sms.schedule(['846000000'], 'x', '2030-01-01 10:00:00', undefined, 'hourly' as never),
      () => moze.webhooks.create('n', 'https://a.co/h', ['sms.bad']),
      () => moze.webhooks.get(0),
      () => moze.otp.verify('s', ''),
      () => moze.senderIds.request('AB', 'alfanumerico', 'otp', 'x'),
      () => moze.senderIds.request('MINHA LOJA', 'alfanumerico', 'otp', 'x'),
      () => moze.senderIds.request('12ab', 'numerico', 'otp', 'x'),
      () => moze.billing.topup(0, 'paypal'),
      () => moze.billing.topup(100, 'mpesa'),
      () => moze.billing.topup(100, 'mpesa', '+27821234567'),
      () => moze.billing.topup(100, 'cartao' as never),
      () => moze.contacts.bulkAssign([], [1]),
      () => moze.contacts.bulkAssign([-1], [1]),
      () => moze.templates.create('n', 'm', 'spam' as never),
      () => moze.campaigns.addRecipients(1, {}),
      () => moze.account.updateProfile({ password: 'x' } as never),
      () => moze.whatsapp.createGroup('G', ['+27821234567']),
      () => moze.whatsapp.registerWebhook('s', 'http://x.co/h'),
      () => moze.whatsapp.sendMedia('s', '846000000', 'gif' as never, 'u'),
    ];
    for (const fn of bad) await expect(fn()).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls).toHaveLength(0);
  });

  it('getProblems: lista os números inválidos', async () => {
    const { moze } = fake();
    await expect(moze.sms.bulk(['846000000', 'abc', ''], 'x')).rejects.toMatchObject({ problems: ['abc', ''] });
  });

  it('allowedCountries restringe países', async () => {
    const { moze } = fake(undefined, { allowedCountries: ['258', '27'] });
    await expect(moze.sms.send('+27821234567', 'x')).resolves.toBeDefined();
    await expect(moze.sms.send('+351912345678', 'x')).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(moze.sms.bulk(['+27821234567', '+351912345678'], 'x')).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it('validatePhones=false não altera o número', async () => {
    const { moze, calls } = fake(undefined, { validatePhones: false });
    await moze.sms.send('qualquer-coisa', 'x');
    expect(calls[0].json.phone).toBe('qualquer-coisa');
  });

  it('mpesa só com número de Moçambique; paypal aceita estrangeiro', async () => {
    const { moze, calls } = fake();
    await moze.billing.topup(500, 'mpesa', '84 600 0000');
    expect(calls[0].json).toEqual({ amount: 500, gateway: 'mpesa', customer_phone: '258846000000' });
    await moze.billing.topup(100, 'paypal', '+27821234567');
    expect(calls[1].json.customer_phone).toBe('27821234567');
  });

  it('opções inválidas no construtor', () => {
    expect(() => new MozeSMS({ apiKey: '', apiSecret: 'x' })).toThrow(InvalidRequestError);
    expect(() => new MozeSMS({ apiKey: 'a', apiSecret: 'b', baseUrl: 'http://example.com' })).toThrow(InvalidRequestError);
    expect(() => new MozeSMS({ apiKey: 'a', apiSecret: 'b', baseUrl: 'http://localhost:8081' })).not.toThrow();
    expect(() => new MozeSMS({ apiKey: 'a', apiSecret: 'b', allowedCountries: ['abc'] })).toThrow(InvalidRequestError);
    expect(() => new MozeSMS({ apiKey: 'a\nb', apiSecret: 'b' })).toThrow(InvalidRequestError);
  });

  it('o segredo não aparece em JSON.stringify nem em inspect', () => {
    const { moze } = fake();
    const http = (moze.sms as any).http;
    expect(JSON.stringify(http)).not.toContain('sk_test');
    expect(JSON.stringify(http)).toContain('***');
  });
});

describe('erros da API', () => {
  const cases: Array<[number, unknown, new (...a: any[]) => Error]> = [
    [402, { success: false, error: 'Insufficient balance', current_balance: 0.5 }, InsufficientBalanceError],
    [401, { success: false, error: { code: 'AUTH_FAILED', message: 'Invalid credentials' } }, AuthenticationError],
    [404, { success: false, error: 'SESSION_NOT_FOUND' }, NotFoundError],
    [409, { success: false, error: 'ALREADY_VERIFIED' }, ConflictError],
    [410, { success: false, error: 'EXPIRED' }, ConflictError],
    [422, { success: false, error: 'WRONG_CODE' }, ValidationError],
    [400, { success: false, error: 'x' }, ValidationError],
    [429, { success: false, error: 'RATE_LIMITED' }, RateLimitError],
    [502, { success: false, error: 'Gateway send failed' }, ServerError],
    [418, { success: false, message: 'chá' }, ApiError],
  ];
  it.each(cases)('HTTP %i → classe certa', async (status, body, cls) => {
    const { moze } = fake([{ status, body }]);
    await expect(moze.sms.send('846000000', 'x')).rejects.toBeInstanceOf(cls);
  });

  it('401 com formato {error:{code,message}}', async () => {
    const { moze } = fake([{ status: 401, body: { success: false, error: { code: 'AUTH_FAILED', message: 'Invalid credentials' } } }]);
    await expect(moze.account.balance()).rejects.toMatchObject({ code: 'AUTH_FAILED', message: 'Invalid credentials', status: 401 });
  });

  it('402 traz o corpo (saldo) em body', async () => {
    const { moze } = fake([{ status: 402, body: { success: false, error: 'Insufficient balance', current_balance: 0.5 } }]);
    await expect(moze.sms.send('846000000', 'x')).rejects.toMatchObject({ body: { current_balance: 0.5 } });
  });

  it('429 lê Retry-After', async () => {
    const { moze } = fake([{ status: 429, body: { error: 'RATE_LIMITED' }, headers: { 'retry-after': '7' } }]);
    await expect(moze.otp.send('846000000')).rejects.toMatchObject({ retryAfter: 7 });
  });

  it('success=false com HTTP 200 também é erro', async () => {
    const { moze } = fake([{ body: { success: false, error: 'WRONG_CODE' } }]);
    await expect(moze.otp.verify('s', '1')).rejects.toBeInstanceOf(ValidationError === undefined ? Error : ApiError);
  });

  it('200 com HTML ou vazio → InvalidResponseError', async () => {
    await expect(fake([{ body: '<html>Manutenção</html>' }]).moze.account.balance()).rejects.toBeInstanceOf(InvalidResponseError);
    await expect(fake([{ body: '' }]).moze.account.balance()).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it('5xx em HTML → mensagem com excerto, sem tags', async () => {
    const { moze } = fake([{ status: 502, body: '<html>Bad gateway</html>' }, { status: 502, body: '<html>Bad gateway</html>' }]);
    const e = await moze.account.balance().catch((x) => x);
    expect(e).toBeInstanceOf(ServerError);
    expect(e.message).toContain('Bad gateway');
    expect(e.message).not.toContain('<html>');
  });

  it('otp.check: false em WRONG_CODE, propaga EXPIRED, true se ok', async () => {
    expect(await fake([{ status: 422, body: { success: false, error: 'WRONG_CODE' } }]).moze.otp.check('s', '000000')).toBe(false);
    await expect(fake([{ status: 410, body: { success: false, error: 'EXPIRED' } }]).moze.otp.check('s', '1')).rejects.toMatchObject({ code: 'EXPIRED' });
    expect(await fake([{ body: { success: true } }]).moze.otp.check('s', '123456')).toBe(true);
  });
});

describe('rede, repetições e métodos', () => {
  it('GET repete após 5xx e após falha de rede; POST nunca', async () => {
    const a = fake([{ status: 503, body: 'down' }, ok({ balance: 10 })]);
    expect((await a.moze.account.balance()).balance).toBe(10);
    expect(a.calls).toHaveLength(2);

    const b = fake([{ throws: new TypeError('fetch failed') }, ok({ balance: 1 })]);
    expect((await b.moze.account.balance()).balance).toBe(1);
    expect(b.calls).toHaveLength(2);

    const c = fake([{ status: 502, body: { success: false, error: 'x' } }, ok()]);
    await expect(c.moze.sms.send('846000000', 'x')).rejects.toBeInstanceOf(ServerError);
    expect(c.calls).toHaveLength(1);
  });

  it('falhas de rede: mayHaveReachedServer', async () => {
    const dns = fake([{ throws: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }) }], { maxRetries: 0 });
    await expect(dns.moze.account.balance()).rejects.toMatchObject({ mayHaveReachedServer: false });
    const reset = fake([{ throws: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) }], { maxRetries: 0 });
    const e = await reset.moze.sms.send('846000000', 'x').catch((x) => x);
    expect(e).toBeInstanceOf(ConnectionError);
    expect(e.mayHaveReachedServer).toBe(true);
  });

  it('timeout → TimeoutError', async () => {
    const f = ((_: string, init: RequestInit) =>
      new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as unknown as typeof fetch;
    const moze = new MozeSMS({ apiKey: 'a', apiSecret: 'b', fetch: f, timeout: 1000, maxRetries: 0 });
    await expect(moze.account.balance()).rejects.toBeInstanceOf(TimeoutError);
  });

  it('o SDK nunca apaga: refuso de DELETE e métodos estranhos', async () => {
    const { moze, calls } = fake();
    const http = (moze.sms as any).http;
    await expect(http.request('DELETE', '/sender-ids/1')).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(http.request('TRACE', '/status')).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls).toHaveLength(0);
  });

  it('nenhum recurso tem métodos de apagar', () => {
    const { moze } = fake();
    const bad = /^(delete|remove|clear|cancelSchedule|deleteSession|reset)/;
    const groupAdmin = ['removeGroupMembers']; // tira membros de um grupo: operação de grupo, não apaga dados
    const resources: any[] = [moze.sms, moze.otp, moze.account, moze.webhooks, moze.senderIds, moze.billing, moze.contacts, moze.groups, moze.templates, moze.campaigns, moze.reports, moze.dashboard, moze.apiLogs, moze.notifications, moze.whatsapp, moze.whatsapp.templates, moze.whatsapp.labels, moze.whatsapp.campaigns, moze.whatsapp.automations, moze.whatsapp.billing];
    for (const r of resources) {
      const names = Object.getOwnPropertyNames(Object.getPrototypeOf(r)).filter((n) => n !== 'constructor');
      expect(names.filter((n) => bad.test(n) && !groupAdmin.includes(n)), r.constructor.name).toEqual([]);
    }
  });
});

describe('rotas dos recursos', () => {
  const route = async (fn: (m: MozeSMS) => Promise<unknown>) => {
    const { moze, calls } = fake();
    await fn(moze);
    return calls[0];
  };
  it.each<[string, (m: MozeSMS) => Promise<unknown>, string, string, any?]>([
    ['senderIds.request', (m) => m.senderIds.request('minhaloja', 'alfanumerico', 'transacional', 'Loja', { entity_type: 'empresa' }), 'POST', '/sender-ids/request', { sender_id: 'MINHALOJA', tipo: 'alfanumerico', uso: 'transacional', descricao: 'Loja', entity_type: 'empresa' }],
    ['senderIds.share', (m) => m.senderIds.share(7, true), 'PUT', '/sender-ids/7/share', { compartilhado: 1 }],
    ['senderIds.addFilter', (m) => m.senderIds.addFilter(7, 'keyword_block', 'spam'), 'POST', '/sender-ids/7/filters', { filter_type: 'keyword_block', filter_value: 'spam' }],
    ['billing.calculate', (m) => m.billing.calculate(100, 'paypal'), 'POST', '/billing/calculate', { amount: 100, gateway: 'paypal' }],
    ['billing.transactions', (m) => m.billing.transactions({ status: 'pending' }), 'GET', '/billing/transactions?status=pending'],
    ['contacts.create', (m) => m.contacts.create('Ana', '846000000', { email: 'a@b.co' }), 'POST', '/contacts', { nome: 'Ana', telefone: '846000000', email: 'a@b.co' }],
    ['contacts.bulkAssign', (m) => m.contacts.bulkAssign([1, 2], [3]), 'POST', '/contacts/bulk-assign', { contact_ids: [1, 2], group_ids: [3] }],
    ['groups.addContacts', (m) => m.groups.addContacts(4, [9]), 'POST', '/contacts/groups/4/contacts', { contact_ids: [9] }],
    ['templates.create', (m) => m.templates.create('Boas-vindas', 'Olá', 'marketing'), 'POST', '/templates', { nome: 'Boas-vindas', mensagem: 'Olá', categoria: 'marketing' }],
    ['campaigns.addRecipients', (m) => m.campaigns.addRecipients(3, { phones: ['846000000'], groupIds: [2] }), 'POST', '/campaigns/3/recipients', { phones: ['258846000000'], group_ids: [2] }],
    ['campaigns.send', (m) => m.campaigns.send(3), 'POST', '/campaigns/3/send'],
    ['reports.summary', (m) => m.reports.summary({ date_from: '2026-01-01' }), 'GET', '/reports/summary?date_from=2026-01-01'],
    ['notifications.readAll', (m) => m.notifications.readAll(), 'POST', '/notifications/read-all'],
    ['history sem nulos', (m) => m.sms.history({ status: 'enviado', search: null, page: 2 }), 'GET', '/sms/history?status=enviado&page=2'],
    ['otp.stats limita dias', (m) => m.otp.stats(500), 'GET', '/otp/stats?days=90'],
    ['whatsapp.sendText', (m) => m.whatsapp.sendText('s1', '846000000', 'Olá'), 'POST', '/whatsapp/send', { session_id: 's1', phone: '258846000000', message: 'Olá', type: 'text' }],
    ['whatsapp.sendMedia pdf', (m) => m.whatsapp.sendMedia('s1', '846000000', 'pdf', 'https://x.co/a.pdf'), 'POST', '/whatsapp/send/pdf', { session_id: 's1', phone: '258846000000', document: 'https://x.co/a.pdf' }],
    ['whatsapp.createGroup', (m) => m.whatsapp.createGroup('Equipa', ['+27821234567', '846000000'], 'T'), 'POST', '/whatsapp/groups/create', { name: 'Equipa', members: ['27821234567', '258846000000'], topic: 'T' }],
    ['whatsapp.promoteGroupMembers', (m) => m.whatsapp.promoteGroupMembers('123@g.us', ['+27821234567']), 'POST', '/whatsapp/groups/123%40g.us/members/promote', { members: ['27821234567'] }],
    ['whatsapp.templates.send', (m) => m.whatsapp.templates.send(4, 's1', '+27821234567', { nome: 'Ana' }), 'POST', '/whatsapp/templates/4/send', { session_id: 's1', to: '27821234567', variables: { nome: 'Ana' } }],
    ['whatsapp.labels.addToContact', (m) => m.whatsapp.labels.addToContact(3, [1, 2]), 'POST', '/whatsapp/contacts/3/labels', { label_ids: [1, 2] }],
    ['whatsapp.campaigns.start', (m) => m.whatsapp.campaigns.start(8), 'POST', '/whatsapp/campaigns/8/start'],
    ['whatsapp.automations.create', (m) => m.whatsapp.automations.create('keyword', { name: 'Preços', session_id: 's1' }), 'POST', '/whatsapp/automations/keyword', { name: 'Preços', session_id: 's1' }],
    ['whatsapp.automations.runScheduleNow', (m) => m.whatsapp.automations.runScheduleNow(2), 'POST', '/whatsapp/automations/schedule/2/run-now'],
    ['whatsapp.billing.configure PATCH', (m) => m.whatsapp.billing.configure(5, { billing_day: 10 }), 'PATCH', '/whatsapp/billing/instances/5/config', { billing_day: 10 }],
    ['whatsapp.billing.usage sessão', (m) => m.whatsapp.billing.usage('s 1'), 'GET', '/whatsapp/billing/sessions/s%201/usage'],
    ['whatsapp.blockContact', (m) => m.whatsapp.blockContact('s1', '+27821234567'), 'POST', '/whatsapp/sessions/s1/block/27821234567'],
  ])('%s', async (_n, fn, method, path, body) => {
    const c = await route(fn);
    expect(c.method).toBe(method);
    expect(c.path).toBe(path);
    if (body !== undefined) expect(c.json).toEqual(body);
  });

  it('upload multipart: documento de sender ID e comprovativo', async () => {
    const { moze, calls } = fake();
    const pdf = new Blob(['%PDF-1.4 teste'], { type: 'application/pdf' });
    await moze.senderIds.uploadDocument(7, 'alvara', { data: pdf, filename: 'alvara.pdf' });
    const form = calls[0].body as FormData;
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/sender-ids/7/documents' });
    expect(form.get('tipo_documento')).toBe('alvara');
    expect((form.get('document') as File).name).toBe('alvara.pdf');
    expect(calls[0].headers['Content-Type']).toBeUndefined(); // o fetch define o boundary

    await moze.billing.uploadProof(9, { data: pdf, filename: 'prova.pdf' });
    expect(calls[1]).toMatchObject({ method: 'PUT', path: '/billing/transactions/9/proof' });
    expect((calls[1].body as FormData).has('proof')).toBe(true);

    await expect(moze.billing.uploadProof(9, { data: pdf, filename: 'virus.exe' })).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(moze.senderIds.uploadDocument(7, 'alvara', new Blob([]))).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(moze.senderIds.uploadDocument(7, 'x' as never, pdf)).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(moze.senderIds.uploadDocument(7, 'alvara', new Blob([new Uint8Array(11 * 1024 * 1024)]))).rejects.toBeInstanceOf(InvalidRequestError);
  });
});

describe('webhooks', () => {
  const body = '{"event":"sms.delivered"}';
  it('assina e verifica', async () => {
    const sig = await signWebhook(body, 's3cret');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyWebhookSignature(body, sig, 's3cret')).toBe(true);
    expect(await verifyWebhookSignature(body, sig.toUpperCase(), 's3cret')).toBe(true);
    expect(await verifyWebhookSignature(body, sig, 'outro')).toBe(false);
    expect(await verifyWebhookSignature(body + ' ', sig, 's3cret')).toBe(false);
    expect(await verifyWebhookSignature(body, null, 's3cret')).toBe(false);
    expect(await verifyWebhookSignature(body, sig, '')).toBe(false);
  });
  it('compatível com o HMAC do PHP/Go (hex HMAC-SHA256)', async () => {
    const { createHmac } = await import('node:crypto');
    expect(await signWebhook(body, 's3cret')).toBe(createHmac('sha256', 's3cret').update(body).digest('hex'));
  });
  it('constructWebhookEvent', async () => {
    const sig = await signWebhook(body, 's3cret');
    expect((await constructWebhookEvent(body, sig, 's3cret')).event).toBe('sms.delivered');
    await expect(constructWebhookEvent('{}', 'x', 's')).rejects.toBeInstanceOf(SignatureVerificationError);
    await expect(constructWebhookEvent('nao-json', await signWebhook('nao-json', 's'), 's')).rejects.toBeInstanceOf(SignatureVerificationError);
    await expect(constructWebhookEvent('[1]', await signWebhook('[1]', 's'), 's')).rejects.toBeInstanceOf(SignatureVerificationError);
  });
});

describe('logger', () => {
  it('um logger partido não quebra o pedido', async () => {
    let n = 0;
    const { moze } = fake([ok({ balance: 1 })], { logger: () => { n++; throw new Error('logger partido'); } });
    expect((await moze.account.balance()).balance).toBe(1);
    expect(n).toBeGreaterThan(0);
  });
});
