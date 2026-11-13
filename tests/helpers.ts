import { MozeSMS, type ClientOptions } from '../src';

export interface Call {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: string | FormData | undefined;
  json: any;
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; throws?: unknown };

/** Cliente com fetch falso: devolve as respostas por ordem (a última repete) e regista os pedidos. */
export function fake(replies: Reply[] = [{ body: { success: true, data: {} } }], options: Partial<ClientOptions> = {}) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const i = Math.min(calls.length, replies.length - 1);
    const r = replies[i];
    const u = new URL(url);
    calls.push({
      method: init.method!,
      url,
      path: u.pathname + u.search,
      headers: init.headers as Record<string, string>,
      body: init.body as any,
      json: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    if (r.throws) throw r.throws;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return new Response(text, { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  const moze = new MozeSMS({ apiKey: 'mk_test', apiSecret: 'sk_test', fetch: f, maxRetries: 1, ...options });
  return { moze, calls };
}

export const ok = (data: unknown = {}) => ({ body: { success: true, data } });
