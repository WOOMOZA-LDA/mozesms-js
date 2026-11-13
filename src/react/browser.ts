import { MozeSMSError } from '../errors';

type HeaderValue = Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

export interface BrowserClientOptions {
  /** URL do SEU backend onde montou o handler de '@woomoza/mozesms/server', p.ex. '/api/mozesms'. */
  endpoint: string;
  /** Cabeçalhos extra (p.ex. token CSRF/autorização da sua app). Pode ser uma função (assíncrona). */
  headers?: HeaderValue;
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
  /** Milissegundos. Por omissão 30000. */
  timeout?: number;
}

/** Erro devolvido pelo seu backend. `code` p.ex. WRONG_CODE, EXPIRED, RATE_LIMITED, INVALID_REQUEST, SERVICE_UNAVAILABLE. */
export class MozeSMSRequestError extends MozeSMSError {
  status: number;
  /** Segundos até poder tentar de novo (RATE_LIMITED). */
  retryAfter?: number;

  constructor(message: string, code: string, status: number, retryAfter?: number) {
    super(message, code);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export interface BrowserClient {
  call<T = any>(action: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<T>;
}

export function createBrowserClient(options: BrowserClientOptions): BrowserClient {
  const f = options.fetch ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined);
  return {
    async call<T>(action: string, params: Record<string, unknown> = {}, opts: { signal?: AbortSignal } = {}): Promise<T> {
      if (!f) throw new MozeSMSRequestError('Este ambiente não tem fetch.', 'NO_FETCH', 0);
      const extra = typeof options.headers === 'function' ? await options.headers() : options.headers ?? {};
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), options.timeout ?? 30000);
      const onAbort = () => ctrl.abort();
      opts.signal?.addEventListener('abort', onAbort);
      try {
        const res = await f(options.endpoint, {
          method: 'POST',
          credentials: options.credentials ?? 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json', ...extra },
          body: JSON.stringify({ action, params }),
          signal: ctrl.signal,
        });
        let body: any = null;
        try {
          body = await res.json();
        } catch {
          /* corpo vazio ou não JSON */
        }
        if (res.ok && body?.ok === true) return body.data as T;
        const err = body?.error;
        throw new MozeSMSRequestError(
          typeof err?.message === 'string' ? err.message : `Erro HTTP ${res.status}`,
          typeof err?.code === 'string' ? err.code : res.status === 404 ? 'ENDPOINT_NOT_FOUND' : 'REQUEST_FAILED',
          res.status,
          typeof err?.retryAfter === 'number' ? err.retryAfter : undefined,
        );
      } catch (e) {
        if (e instanceof MozeSMSRequestError) throw e;
        if ((e as Error)?.name === 'AbortError') {
          throw new MozeSMSRequestError(opts.signal?.aborted ? 'Pedido cancelado.' : 'O servidor não respondeu a tempo.', opts.signal?.aborted ? 'ABORTED' : 'TIMEOUT', 0);
        }
        throw new MozeSMSRequestError('Sem ligação ao servidor.', 'NETWORK_ERROR', 0);
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
