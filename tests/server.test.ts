import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { MozeSMS } from '../src';
import { MemoryRateStore, createHandler, toNodeHandler, type HandlerOptions } from '../src/server';
import { fake, ok } from './helpers';

const post = (body: unknown, headers: Record<string, string> = {}, raw?: string) =>
  new Request('http://app.test/api/mozesms', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw ?? JSON.stringify(body),
  });

const setup = (replies: Parameters<typeof fake>[0] = [ok({ session_id: 'sess_1', expires_in: 300 })], opts: Partial<HandlerOptions> = {}) => {
  const f = fake(replies);
  const handler = createHandler({ client: f.moze, ...opts });
  return { ...f, handler };
};

const j = async (r: Response) => ({ status: r.status, body: await r.json() });

describe('createHandler: configuração segura', () => {
  it('exige um MozeSMS', () => {
    expect(() => createHandler({ client: {} as never })).toThrow(/client/);
  });
  it('recusa ações desconhecidas em allow', () => {
    expect(() => createHandler({ client: fake().moze, allow: ['nao.existe'] })).toThrow(/desconhecidas/);
  });
  it('ações que gastam saldo exigem authorize', () => {
    expect(() => createHandler({ client: fake().moze, allow: ['otp.send', 'sms.send'] })).toThrow(/authorize/);
    expect(() => createHandler({ client: fake().moze, allow: ['account.balance'] })).toThrow(/authorize/);
    expect(() => createHandler({ client: fake().moze, allow: ['sms.send'], authorize: () => true })).not.toThrow();
  });
});

describe('createHandler: OTP', () => {
  it('otp.send: opções fixas do servidor, o browser não as muda', async () => {
    const { handler, calls } = setup(undefined, { otp: { sender_id: 'MINHALOJA', digits: 6 } });
    const r = await j(await handler(post({ action: 'otp.send', params: { phone: '+258 84 600 0000', sender_id: 'PHISHING', message: 'envie dinheiro', expiry: 999999 } })));
    expect(r).toEqual({ status: 200, body: { ok: true, data: { session_id: 'sess_1', expires_in: 300 } } });
    expect(calls[0].json).toEqual({ phone: '258846000000', sender_id: 'MINHALOJA', digits: 6 });
  });

  it('otp.verify devolve {verified}', async () => {
    const good = setup([{ body: { success: true } }]);
    expect(await j(await good.handler(post({ action: 'otp.verify', params: { sessionId: 's', code: '123456' } })))).toEqual({ status: 200, body: { ok: true, data: { verified: true } } });
    const wrong = setup([{ status: 422, body: { success: false, error: 'WRONG_CODE' } }]);
    expect(await j(await wrong.handler(post({ action: 'otp.verify', params: { sessionId: 's', code: '0' } })))).toEqual({ status: 200, body: { ok: true, data: { verified: false } } });
  });

  it('erros úteis passam (expirado/validação), detalhes internos não', async () => {
    const expired = setup([{ status: 410, body: { success: false, error: 'EXPIRED', message: 'expirou' } }]);
    const r = await j(await expired.handler(post({ action: 'otp.verify', params: { sessionId: 's', code: '1' } })));
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe('EXPIRED');

    const bad = setup();
    const inv = await j(await bad.handler(post({ action: 'otp.send', params: { phone: '123' } })));
    expect(inv.status).toBe(400);
    expect(inv.body.error.code).toBe('INVALID_REQUEST');
    expect(bad.calls).toHaveLength(0);
  });

  it('saldo, credenciais e 5xx NUNCA chegam ao browser: 503 genérico + onError', async () => {
    for (const [status, body] of [[402, { error: 'Insufficient balance', current_balance: 0.5 }], [401, { error: 'bad key sk_secret' }], [502, { error: 'Gateway send failed' }]] as const) {
      const onError = vi.fn();
      const { handler } = setup([{ status, body }], { onError });
      const r = await j(await handler(post({ action: 'otp.send', params: { phone: '846000000' } })));
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(JSON.stringify(r.body)).not.toMatch(/balance|sk_secret|Gateway|0\.5/i);
      expect(onError).toHaveBeenCalledOnce();
    }
  });

  it('upstream 429 → 429 com retryAfter', async () => {
    const { handler } = setup([{ status: 429, body: { error: 'RATE_LIMITED' }, headers: { 'retry-after': '9' } }]);
    const res = await handler(post({ action: 'otp.send', params: { phone: '846000000' } }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('9');
  });
});

describe('createHandler: limites', () => {
  it('3 envios por número em 10 min, depois 429 sem tocar na MozeSMS', async () => {
    const { handler, calls } = setup();
    const send = () => handler(post({ action: 'otp.send', params: { phone: '+258 84 600 0000' } }));
    for (let i = 0; i < 3; i++) expect((await send()).status).toBe(200);
    const blocked = await send();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('600');
    expect(calls).toHaveLength(3);
    // outro número não é afetado; o mesmo número escrito de outra forma conta como o mesmo
    expect((await handler(post({ action: 'otp.send', params: { phone: '847000000' } }))).status).toBe(200);
    expect((await handler(post({ action: 'otp.send', params: { phone: '846000000' } }))).status).toBe(429);
  });

  it('por IP (só com trustProxy)', async () => {
    const { handler } = setup(undefined, { trustProxy: true, rateLimit: { perPhone: { max: 100, windowMs: 60_000 }, perIp: { max: 2, windowMs: 60_000 } } });
    const send = (n: number, ip: string) => handler(post({ action: 'otp.send', params: { phone: `84600000${n}` } }, { 'x-forwarded-for': `${ip}, 10.0.0.1` }));
    expect((await send(1, '1.1.1.1')).status).toBe(200);
    expect((await send(2, '1.1.1.1')).status).toBe(200);
    expect((await send(3, '1.1.1.1')).status).toBe(429);
    expect((await send(4, '2.2.2.2')).status).toBe(200);
  });

  it('sem trustProxy o X-Forwarded-For forjado não serve para fugir nem para bloquear outros', async () => {
    const { handler } = setup(undefined, { rateLimit: { perPhone: { max: 100, windowMs: 60_000 }, perIp: { max: 1, windowMs: 60_000 } } });
    for (let i = 0; i < 3; i++) expect((await handler(post({ action: 'otp.send', params: { phone: `84600000${i}` } }, { 'x-forwarded-for': '9.9.9.9' }))).status).toBe(200);
  });

  it('verificação limitada por sessão (força bruta)', async () => {
    const { handler } = setup([{ status: 422, body: { error: 'WRONG_CODE' } }], { rateLimit: { perSession: { max: 3, windowMs: 60_000 } } });
    const v = () => handler(post({ action: 'otp.verify', params: { sessionId: 'abc', code: '000000' } }));
    for (let i = 0; i < 3; i++) expect((await v()).status).toBe(200);
    expect((await v()).status).toBe(429);
  });

  it('rateLimit:false desliga e a store é substituível', async () => {
    const off = setup(undefined, { rateLimit: false });
    for (let i = 0; i < 6; i++) expect((await off.handler(post({ action: 'otp.send', params: { phone: '846000000' } }))).status).toBe(200);
    const hit = vi.fn(() => 1);
    const custom = setup(undefined, { rateLimit: { store: { hit } } });
    await custom.handler(post({ action: 'otp.send', params: { phone: '846000000' } }));
    expect(hit).toHaveBeenCalled();
  });

  it('MemoryRateStore conta e expira', async () => {
    const s = new MemoryRateStore();
    expect(s.hit('k', 20)).toBe(1);
    expect(s.hit('k', 20)).toBe(2);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.hit('k', 20)).toBe(1);
  });
});

describe('createHandler: ações protegidas e pedidos hostis', () => {
  it('ações fora de allow dão 404 (não revela que existem)', async () => {
    const { handler, calls } = setup();
    for (const action of ['sms.send', 'account.balance', 'nao.existe', '__proto__']) {
      const r = await j(await handler(post({ action, params: { phone: '846000000', message: 'x' } })));
      expect(r.status).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  it('authorize decide; false → 403; erro dentro de authorize → 403 + onError', async () => {
    const f = fake([ok({ id: 'x', status: 'enviado' })]);
    let allowIt = false;
    const onError = vi.fn();
    const handler = createHandler({ client: f.moze, allow: ['sms.send'], authorize: ({ request }) => allowIt && request.headers.get('x-user') === 'ana', onError });
    const body = { action: 'sms.send', params: { phone: '846000000', message: 'Olá' } };
    expect((await handler(post(body, { 'x-user': 'ana' }))).status).toBe(403);
    allowIt = true;
    expect((await handler(post(body, { 'x-user': 'rui' }))).status).toBe(403);
    expect((await handler(post(body, { 'x-user': 'ana' }))).status).toBe(200);
    expect(f.calls).toHaveLength(1);

    const boom = createHandler({ client: f.moze, allow: ['sms.send'], authorize: () => { throw new Error('db down'); }, onError });
    expect((await boom(post(body))).status).toBe(403);
    expect(onError).toHaveBeenCalled();
  });

  it('authorize corre também no OTP quando existe (ex.: exigir sessão)', async () => {
    const { handler, calls } = setup(undefined, { authorize: () => false });
    expect((await handler(post({ action: 'otp.send', params: { phone: '846000000' } }))).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('método, tipo de conteúdo, JSON e tamanho', async () => {
    const { handler } = setup();
    expect((await handler(new Request('http://x/api', { method: 'GET' }))).status).toBe(405);
    expect((await handler(new Request('http://x/api', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }))).status).toBe(415);
    expect((await handler(new Request('http://x/api', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'action=otp.send' }))).status).toBe(415);
    expect((await handler(post(null, {}, 'não é json'))).status).toBe(400);
    expect((await handler(post(null, {}, '[1,2]'))).status).toBe(400);
    expect((await handler(post(null, {}, JSON.stringify({ action: 'otp.send', params: { phone: '8'.repeat(20000) } })))).status).toBe(413);
  });

  it('CSRF: cross-site recusado; allowedOrigins controla', async () => {
    const { handler } = setup();
    expect((await handler(post({ action: 'otp.send', params: { phone: '846000000' } }, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.co' }))).status).toBe(403);
    expect((await handler(post({ action: 'otp.send', params: { phone: '847000000' } }, { 'sec-fetch-site': 'same-origin' }))).status).toBe(200);

    const strict = setup(undefined, { allowedOrigins: ['https://app.exemplo.co/'] });
    expect((await strict.handler(post({ action: 'otp.send', params: { phone: '846000000' } }, { origin: 'https://evil.co' }))).status).toBe(403);
    expect((await strict.handler(post({ action: 'otp.send', params: { phone: '846000000' } }, { origin: 'https://app.exemplo.co' }))).status).toBe(200);
  });

  it('as respostas não são cacheáveis', async () => {
    const { handler } = setup();
    expect((await handler(post({ action: 'otp.send', params: { phone: '846000000' } }))).headers.get('cache-control')).toBe('no-store');
  });
});

describe('createHandler: ações disponíveis', () => {
  it('encaminha parâmetros certos', async () => {
    const f = fake([ok({})]);
    const handler = createHandler({
      client: f.moze,
      authorize: () => true,
      allow: ['sms.send', 'sms.status', 'account.balance', 'billing.calculate', 'billing.topup', 'billing.transactionStatus', 'whatsapp.sendText', 'senderIds.list'],
    });
    const run = (action: string, params: object) => handler(post({ action, params }));
    await run('sms.send', { phone: '+27821234567', message: 'Hi', sender_id: 'MozeSMS' });
    await run('sms.status', { id: 'abc' });
    await run('account.balance', {});
    await run('billing.calculate', { amount: 100, gateway: 'paypal' });
    await run('billing.topup', { amount: 500, gateway: 'mpesa', customerPhone: '846000000' });
    await run('billing.transactionStatus', { id: 7 });
    await run('whatsapp.sendText', { sessionId: 's1', phone: '846000000', message: 'Olá' });
    await run('senderIds.list', { filters: { status: 'aprovado' } });
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /sms/send', 'GET /sms/status/abc', 'GET /v1/account/balance', 'POST /billing/calculate', 'POST /billing/purchase',
      'GET /billing/transactions/7/status', 'POST /whatsapp/send', 'GET /sender-ids?status=aprovado',
    ]);
    expect(f.calls[0].json.phone).toBe('27821234567');
  });
});

describe('toNodeHandler (Express / http)', () => {
  const listen = async (handlerOpts: Partial<HandlerOptions> = {}, middleware?: (req: any) => void) => {
    const f = fake([ok({ session_id: 'sess_9', expires_in: 120 })]);
    const handler = toNodeHandler(createHandler({ client: f.moze, ...handlerOpts }));
    const server = createServer((req, res) => {
      middleware?.(req);
      void handler(req as never, res as never);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mozesms`;
    return { f, url, close: () => new Promise((r) => server.close(r)) };
  };

  it('lê o corpo do stream e responde JSON', async () => {
    const s = await listen();
    try {
      const res = await fetch(s.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'otp.send', params: { phone: '846000000' } }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, data: { session_id: 'sess_9', expires_in: 120 } });
      expect(s.f.calls[0].json.phone).toBe('258846000000');
    } finally {
      await s.close();
    }
  });

  it('aceita corpo já interpretado pelo express.json()', async () => {
    const s = await listen({}, (req) => { req.body = { action: 'otp.send', params: { phone: '847000000' } }; });
    try {
      const res = await fetch(s.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'ignorado' });
      expect(res.status).toBe(200);
      expect(s.f.calls[0].json.phone).toBe('258847000000');
    } finally {
      await s.close();
    }
  });

  it('erros e métodos errados', async () => {
    const s = await listen();
    try {
      expect((await fetch(s.url, { method: 'GET' })).status).toBe(405);
      const bad = await fetch(s.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nao json' });
      expect(bad.status).toBe(400);
    } finally {
      await s.close();
    }
  });
});

// garante que o handler não depende de uma instância "emprestada"
describe('MozeSMS real', () => {
  it('createHandler aceita uma instância MozeSMS verdadeira', () => {
    expect(() => createHandler({ client: new MozeSMS({ apiKey: 'a', apiSecret: 'b' }) })).not.toThrow();
  });
});
