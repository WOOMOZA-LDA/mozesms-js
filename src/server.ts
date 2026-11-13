/**
 * Handler seguro para o SEU backend: é o que os hooks de React chamam. O browser nunca vê o secret da MozeSMS.
 *
 * Next.js (App Router), app/api/mozesms/route.ts:
 *
 *     import { MozeSMS } from '@woomoza/mozesms';
 *     import { createHandler } from '@woomoza/mozesms/server';
 *
 *     const handler = createHandler({
 *       client: new MozeSMS({ apiKey: process.env.MOZESMS_KEY!, apiSecret: process.env.MOZESMS_SECRET! }),
 *       otp: { sender_id: 'MINHALOJA' },
 *     });
 *     export const POST = handler;
 *
 * Por omissão só expõe `otp.send` e `otp.verify`, com limites por número e por IP. Qualquer outra ação (enviar SMS, ver
 * saldo, recarregar...) tem de ser listada em `allow` E exige `authorize`: sem isso, qualquer visitante gastaria o seu saldo.
 */
import { MozeSMS } from './client';
import {
  AuthenticationError,
  ConflictError,
  ConnectionError,
  InsufficientBalanceError,
  InvalidRequestError,
  InvalidResponseError,
  MozeSMSError,
  NotFoundError,
  RateLimitError,
  ServerError,
  ValidationError,
} from './errors';
import type { Json } from './http';
import { normalizePhone } from './phone';

export interface Limit {
  max: number;
  windowMs: number;
}

/** Contador partilhado (Redis, KV...). `hit` incrementa e devolve a contagem dentro da janela. */
export interface RateStore {
  hit(key: string, windowMs: number): number | Promise<number>;
}

export class MemoryRateStore implements RateStore {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = Date.now();

  hit(key: string, windowMs: number): number {
    const now = Date.now();
    if (now - this.lastSweep > 60_000) {
      this.lastSweep = now;
      for (const [k, v] of this.entries) if (v.resetAt <= now) this.entries.delete(k);
    }
    const cur = this.entries.get(key);
    if (!cur || cur.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + windowMs });
      return 1;
    }
    cur.count += 1;
    return cur.count;
  }
}

export interface ActionContext {
  request: Request;
  action: string;
  params: Json;
}

export interface HandlerOptions {
  client: MozeSMS;
  /** Ações expostas ao browser. Por omissão ['otp.send', 'otp.verify']. */
  allow?: string[];
  /** Obrigatório se `allow` tiver ações além de otp.send/otp.verify. Devolva true para deixar passar. Corre também nas ações OTP, se existir. */
  authorize?: (ctx: ActionContext) => boolean | Promise<boolean>;
  /** Opções FIXAS do OTP (o browser não as pode mudar): sender_id, digits, expiry, max_attempts, message. */
  otp?: { sender_id?: string; digits?: number; expiry?: number; max_attempts?: number; message?: string };
  /** Limites do OTP. Por omissão: 3 envios por número em 10 min, 20 por IP por hora, 10 verificações por sessão em 10 min. `false` desliga. */
  rateLimit?: false | { perPhone?: Limit; perIp?: Limit; perSession?: Limit; store?: RateStore };
  /** Origens permitidas (ex.: ['https://app.exemplo.co']). Sem isto, pedidos cross-site vindos de browsers são recusados. */
  allowedOrigins?: string[];
  /** Confia no X-Forwarded-For para obter o IP (só atrás de um proxy seu!). */
  trustProxy?: boolean;
  /** Alternativa a trustProxy: obtenha o IP como o seu host o fornece. */
  getClientIp?: (request: Request) => string | null | undefined;
  /** Tamanho máximo do corpo (bytes). Por omissão 16 KB. */
  maxBodyBytes?: number;
  /** Chamado para erros que o utilizador final não vê (saldo, credenciais, servidor). Registe-os aqui. */
  onError?: (error: unknown, ctx: { action?: string }) => void;
}

type Runner = (c: MozeSMS, p: Json, o: HandlerOptions) => Promise<unknown>;

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' && typeof v !== 'number') throw new InvalidRequestError(`'${name}' é obrigatório`);
  return String(v);
};

const ACTIONS: Record<string, { open: boolean; run: Runner }> = {
  // Públicas por omissão (verificação de telefone): as opções vêm do servidor, nunca do browser.
  'otp.send': { open: true, run: (c, p, o) => c.otp.send(str(p.phone, 'phone'), { ...o.otp }) },
  'otp.verify': { open: true, run: async (c, p) => ({ verified: await c.otp.check(str(p.sessionId, 'sessionId'), str(p.code, 'code')) }) },
  // Exigem authorize
  'otp.status': { open: false, run: (c, p) => c.otp.status(str(p.sessionId, 'sessionId')) },
  'otp.cancel': { open: false, run: (c, p) => c.otp.cancel(str(p.sessionId, 'sessionId')) },
  'sms.send': { open: false, run: (c, p) => c.sms.send(str(p.phone, 'phone'), str(p.message, 'message'), typeof p.sender_id === 'string' ? p.sender_id : undefined) },
  'sms.bulk': { open: false, run: (c, p) => c.sms.bulk(p.phones as string[], str(p.message, 'message'), typeof p.sender_id === 'string' ? p.sender_id : undefined) },
  'sms.status': { open: false, run: (c, p) => c.sms.status(str(p.id, 'id')) },
  'sms.history': { open: false, run: (c, p) => c.sms.history((p.filters as Json) ?? {}) },
  'account.balance': { open: false, run: (c) => c.account.balance() },
  'billing.gateways': { open: false, run: (c) => c.billing.gateways() },
  'billing.calculate': { open: false, run: (c, p) => c.billing.calculate(Number(p.amount), p.gateway as never) },
  'billing.topup': { open: false, run: (c, p) => c.billing.topup(Number(p.amount), p.gateway as never, typeof p.customerPhone === 'string' ? p.customerPhone : undefined) },
  'billing.transactionStatus': { open: false, run: (c, p) => c.billing.transactionStatus(Number(p.id)) },
  'senderIds.list': { open: false, run: (c, p) => c.senderIds.list((p.filters as Json) ?? {}) },
  'whatsapp.sendText': { open: false, run: (c, p) => c.whatsapp.sendText(str(p.sessionId, 'sessionId'), str(p.phone, 'phone'), str(p.message, 'message')) },
};

export const AVAILABLE_ACTIONS = Object.keys(ACTIONS);

const DEFAULT_ALLOW = ['otp.send', 'otp.verify'];
const DEFAULT_LIMITS = {
  perPhone: { max: 3, windowMs: 10 * 60_000 },
  perIp: { max: 20, windowMs: 60 * 60_000 },
  perSession: { max: 10, windowMs: 10 * 60_000 },
};

const json = (status: number, body: Json, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });

const fail = (status: number, code: string, message: string, extra: Json = {}, headers: Record<string, string> = {}) =>
  json(status, { ok: false, error: { code, message, status, ...extra } }, headers);

export function createHandler(options: HandlerOptions): (request: Request) => Promise<Response> {
  if (!(options?.client instanceof MozeSMS)) throw new Error('createHandler: indique `client` (uma instância de MozeSMS).');
  const allow = options.allow ?? DEFAULT_ALLOW;
  const unknown = allow.filter((a) => !ACTIONS[a]);
  if (unknown.length) throw new Error(`createHandler: ações desconhecidas em allow: ${unknown.join(', ')}. Disponíveis: ${AVAILABLE_ACTIONS.join(', ')}`);
  const guarded = allow.filter((a) => !ACTIONS[a].open);
  if (guarded.length && !options.authorize) {
    throw new Error(
      `createHandler: as ações ${guarded.join(', ')} gastam saldo ou mostram dados da conta. Defina \`authorize\` ` +
        '(p.ex. verificar a sessão do utilizador), senão qualquer visitante as poderia chamar.',
    );
  }
  const maxBody = options.maxBodyBytes ?? 16 * 1024;
  const limits = options.rateLimit === false ? null : { ...DEFAULT_LIMITS, ...(options.rateLimit ?? {}) };
  const store: RateStore = (options.rateLimit && options.rateLimit.store) || new MemoryRateStore();
  const allowedOrigins = options.allowedOrigins?.map((o) => o.replace(/\/+$/, ''));

  const clientIp = (request: Request): string | null => {
    if (options.getClientIp) return options.getClientIp(request) ?? null;
    if (options.trustProxy) return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || null;
    return null;
  };

  const over = async (key: string, limit: Limit): Promise<boolean> => (await store.hit(key, limit.windowMs)) > limit.max;

  return async function handler(request: Request): Promise<Response> {
    let action: string | undefined;
    try {
      if (request.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'Use POST.', {}, { allow: 'POST' });

      // Anti-CSRF: só JSON (um <form> não o consegue enviar) e nada de pedidos cross-site de browsers.
      if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type tem de ser application/json.');
      const origin = request.headers.get('origin');
      if (allowedOrigins) {
        if (origin && !allowedOrigins.includes(origin.replace(/\/+$/, ''))) return fail(403, 'FORBIDDEN', 'Origem não permitida.');
      } else if (request.headers.get('sec-fetch-site') === 'cross-site') {
        return fail(403, 'FORBIDDEN', 'Pedidos cross-site não são permitidos.');
      }

      const declared = Number(request.headers.get('content-length') ?? 0);
      if (declared > maxBody) return fail(413, 'PAYLOAD_TOO_LARGE', 'Pedido demasiado grande.');
      const text = await request.text();
      if (text.length > maxBody) return fail(413, 'PAYLOAD_TOO_LARGE', 'Pedido demasiado grande.');
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        return fail(400, 'INVALID_JSON', 'Corpo não é JSON válido.');
      }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return fail(400, 'INVALID_JSON', 'Corpo tem de ser um objeto.');
      const body = payload as Json;
      action = typeof body.action === 'string' ? body.action : undefined;
      const params: Json = body.params !== null && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {};

      if (!action || !allow.includes(action)) return fail(404, 'UNKNOWN_ACTION', 'Ação desconhecida.');

      if (options.authorize) {
        let ok = false;
        try {
          ok = !!(await options.authorize({ request, action, params }));
        } catch (e) {
          options.onError?.(e, { action });
        }
        if (!ok) return fail(403, 'FORBIDDEN', 'Não autorizado.');
      }

      if (limits) {
        const ip = clientIp(request);
        if (action === 'otp.send') {
          const phone = normalizePhone(String(params.phone ?? ''));
          if (phone && (await over(`otp.send:phone:${phone}`, limits.perPhone))) return rateLimited(limits.perPhone);
          if (ip && (await over(`otp.send:ip:${ip}`, limits.perIp))) return rateLimited(limits.perIp);
        } else if (action === 'otp.verify') {
          const sid = String(params.sessionId ?? '');
          if (sid && (await over(`otp.verify:session:${sid}`, limits.perSession))) return rateLimited(limits.perSession);
          if (ip && (await over(`otp.verify:ip:${ip}`, { max: limits.perIp.max * 5, windowMs: limits.perIp.windowMs }))) return rateLimited(limits.perIp);
        }
      }

      const data = await ACTIONS[action].run(options.client, params, options);
      return json(200, { ok: true, data: data ?? null });
    } catch (e) {
      return errorResponse(e, action, options);
    }
  };
}

function rateLimited(limit: Limit): Response {
  const retryAfter = Math.ceil(limit.windowMs / 1000);
  return fail(429, 'RATE_LIMITED', 'Demasiados pedidos. Tente mais tarde.', { retryAfter }, { 'retry-after': String(retryAfter) });
}

function errorResponse(e: unknown, action: string | undefined, options: HandlerOptions): Response {
  // Erros que o utilizador final pode e deve ver, sem detalhes internos.
  if (e instanceof InvalidRequestError) return fail(400, 'INVALID_REQUEST', e.message);
  if (e instanceof RateLimitError) return fail(429, 'RATE_LIMITED', 'Demasiados pedidos. Tente mais tarde.', e.retryAfter ? { retryAfter: e.retryAfter } : {}, e.retryAfter ? { 'retry-after': String(e.retryAfter) } : {});
  if (e instanceof ValidationError) return fail(422, e.code ?? 'VALIDATION_ERROR', e.message);
  if (e instanceof ConflictError) return fail(e.status === 410 ? 410 : 409, e.code ?? 'CONFLICT', e.message);
  if (e instanceof NotFoundError) return fail(404, e.code ?? 'NOT_FOUND', 'Não encontrado.');
  // Saldo, credenciais, 5xx, rede: nunca para o browser (revelariam o estado da conta). O dono do site regista-os em onError.
  if (e instanceof InsufficientBalanceError || e instanceof AuthenticationError || e instanceof ServerError || e instanceof InvalidResponseError || e instanceof ConnectionError) {
    options.onError?.(e, { action });
    return fail(503, 'SERVICE_UNAVAILABLE', 'Serviço indisponível de momento. Tente mais tarde.');
  }
  options.onError?.(e, { action });
  if (e instanceof MozeSMSError) return fail(502, 'SERVICE_UNAVAILABLE', 'Serviço indisponível de momento. Tente mais tarde.');
  return fail(500, 'INTERNAL_ERROR', 'Erro interno.');
}

// ---- adaptador para Express / http de Node ---------------------------------------------------------------------

interface NodeReq {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  socket?: { remoteAddress?: string };
  on(event: string, cb: (...a: any[]) => void): unknown;
}
interface NodeRes {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
}

/**
 * Express: `app.post('/api/mozesms', toNodeHandler(handler))`. Se já usa `express.json()`, funciona na mesma
 * (reconstrói o corpo); sem ele, lê o corpo do stream. `getClientIp` pode usar `req.ip`.
 */
export function toNodeHandler(handler: (request: Request) => Promise<Response>, maxBodyBytes = 16 * 1024) {
  return async (req: NodeReq, res: NodeRes): Promise<void> => {
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      let body: string | undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && !(req.body instanceof Uint8Array)) body = JSON.stringify(req.body);
        else if (typeof req.body === 'string') body = req.body;
        else if (req.body instanceof Uint8Array) body = new TextDecoder().decode(req.body);
        else body = await readStream(req, maxBodyBytes);
      }
      const host = String(req.headers.host ?? 'localhost');
      const request = new Request(`http://${host}${req.url ?? '/'}`, { method: req.method, headers, body });
      const response = await handler(request);
      res.statusCode = response.status;
      response.headers.forEach((value, name) => res.setHeader(name, value));
      res.end(await response.text());
    } catch (e) {
      const tooLarge = e instanceof Error && e.message === 'payload too large';
      res.statusCode = tooLarge ? 413 : 500;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          tooLarge
            ? { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Pedido demasiado grande.', status: 413 } }
            : { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Erro interno.', status: 500 } },
        ),
      );
    }
  };
}

function readStream(req: NodeReq, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    req.on('data', (c: Uint8Array) => {
      size += c.length;
      if (size > max) {
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(new TextDecoder().decode(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

export { MozeSMS };
export { verifyWebhookSignature, constructWebhookEvent, signWebhook } from './webhook';
