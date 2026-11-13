import {
  ApiError,
  AuthenticationError,
  ConflictError,
  ConnectionError,
  InsufficientBalanceError,
  InvalidRequestError,
  InvalidResponseError,
  NotFoundError,
  RateLimitError,
  ServerError,
  TimeoutError,
  ValidationError,
} from './errors';
import { Validator } from './validate';

export type Json = Record<string, any>;

export const VERSION = '0.1.0';
export const DEFAULT_BASE_URL = 'https://api.mozesms.com';

export type LogLevel = 'debug' | 'warning';

export interface ClientOptions {
  apiKey: string;
  apiSecret: string;
  /** Por omissão https://api.mozesms.com. `http://` só é aceite em localhost. */
  baseUrl?: string;
  /** Milissegundos (30000). */
  timeout?: number;
  /** Repetições só para GET (falha de rede e 5xx). 0 a 5, por omissão 2. */
  maxRetries?: number;
  /** Códigos de país aceites, p.ex. ['258', '27']. Omitido = qualquer país. */
  allowedCountries?: string[];
  /** Recusa números inválidos antes do pedido (a API cobra-os sem os enviar). Por omissão true. */
  validatePhones?: boolean;
  /** `fetch` personalizado (testes, proxies). */
  fetch?: typeof fetch;
  /** Nunca inclui credenciais. Erros do logger são ignorados. */
  logger?: (level: LogLevel, message: string, context: Json) => void;
  /**
   * O secret NUNCA deve ir para o browser (qualquer utilizador o vê). O SDK recusa-se a correr num browser a menos que
   * isto seja true. Para React use `@woomoza/mozesms/react` com um endpoint do seu backend.
   */
  dangerouslyAllowBrowser?: boolean;
}

export type FileInput = Blob | { data: Blob; filename: string };

interface RawResponse {
  status: number;
  text: string;
  json: Json | null;
  headers: Headers;
}

interface RequestInitLite {
  query?: Json;
  json?: Json;
  form?: FormData;
}

const NOT_SENT_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH']);

export class HttpClient {
  readonly validator: Validator;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: ClientOptions['logger'];

  constructor(options: ClientOptions) {
    const apiKey = String(options?.apiKey ?? '').trim();
    const apiSecret = String(options?.apiSecret ?? '').trim();
    if (!apiKey || !apiSecret) throw new InvalidRequestError('apiKey e apiSecret são obrigatórios');
    if (/[\r\n]/.test(apiKey + apiSecret)) throw new InvalidRequestError('apiKey/apiSecret contêm quebras de linha (cabeçalho inválido)');

    if (typeof window !== 'undefined' && typeof (globalThis as any).document !== 'undefined' && !options.dangerouslyAllowBrowser) {
      throw new InvalidRequestError(
        'Não use o secret da MozeSMS no browser: qualquer pessoa o veria. Chame a API a partir do seu servidor ' +
          "(use o handler de '@woomoza/mozesms/server' e os hooks de '@woomoza/mozesms/react').",
      );
    }

    const baseUrl = String(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new InvalidRequestError(`baseUrl inválida: '${baseUrl}'`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new InvalidRequestError(`baseUrl inválida: '${baseUrl}'`);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol === 'http:' && !local) throw new InvalidRequestError('baseUrl tem de ser https (as credenciais iriam em texto simples)');

    const countries = options.allowedCountries;
    if (countries !== undefined && (!Array.isArray(countries) || countries.length === 0 || countries.some((c) => !/^[1-9][0-9]{0,3}$/.test(String(c))))) {
      throw new InvalidRequestError("allowedCountries tem de ser uma lista de códigos de país, ex.: ['258', '27']");
    }

    const f = options.fetch ?? (globalThis as any).fetch;
    if (typeof f !== 'function') throw new InvalidRequestError('Este ambiente não tem fetch; use Node 18+ ou passe a opção fetch.');

    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = baseUrl;
    this.timeout = Math.max(1000, Number(options.timeout ?? 30000));
    this.maxRetries = Math.max(0, Math.min(5, Number(options.maxRetries ?? 2)));
    this.fetchImpl = (f as typeof fetch).bind(globalThis);
    this.logger = options.logger;
    this.validator = new Validator(options.validatePhones !== false, countries ?? null);
  }

  /** Esconde o segredo de console.log/util.inspect. */
  toJSON(): Json {
    return { baseUrl: this.baseUrl, apiKey: this.apiKey.slice(0, 6) + '…', apiSecret: '***' };
  }
  [Symbol.for('nodejs.util.inspect.custom')](): Json {
    return this.toJSON();
  }

  /** Devolve o corpo JSON decodificado; lança um erro tipado em qualquer falha. */
  async request(method: string, path: string, init: RequestInitLite = {}): Promise<Json> {
    const res = await this.raw(method, path, init);
    if (res.status >= 400) throw this.toError(res);
    if (res.json === null) {
      throw new InvalidResponseError(
        `Resposta inesperada da API (HTTP ${res.status}, corpo não é JSON): ${excerpt(res.text)}`,
        res.status,
        'INVALID_RESPONSE',
      );
    }
    if (res.json.success === false) throw this.toError(res);
    return res.json;
  }

  /** Pedido GET cujo corpo não é JSON (exportações CSV, PDF, imagens). */
  async download(path: string, query: Json = {}): Promise<Uint8Array> {
    const res = await this.rawBytes('GET', path, { query });
    if (res.status >= 400) throw this.toError({ status: res.status, text: new TextDecoder().decode(res.bytes), json: tryJson(new TextDecoder().decode(res.bytes)), headers: res.headers });
    return res.bytes;
  }

  /** multipart/form-data. `files` é campo → Blob (ou { data, filename }). */
  async upload(method: string, path: string, fields: Record<string, string | number | boolean>, files: Record<string, FileInput>, maxBytes = 5 * 1024 * 1024): Promise<Json> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
    for (const [name, file] of Object.entries(files)) {
      const blob = file instanceof Blob ? file : file?.data;
      const filename = file instanceof Blob ? ((file as File).name || 'ficheiro') : file?.filename || 'ficheiro';
      if (!(blob instanceof Blob)) throw new InvalidRequestError(`'${name}' tem de ser um Blob/File (ou { data, filename })`);
      if (blob.size === 0) throw new InvalidRequestError(`Ficheiro vazio: '${filename}'`);
      if (blob.size > maxBytes) throw new InvalidRequestError(`Ficheiro '${filename}' excede ${Math.floor(maxBytes / 1048576)} MB`);
      form.append(name, blob, filename);
    }
    return this.request(method, path, { form });
  }

  // ---------------------------------------------------------------------------------------------------------------

  private async raw(method: string, path: string, init: RequestInitLite): Promise<RawResponse> {
    const r = await this.rawBytes(method, path, init);
    const text = new TextDecoder().decode(r.bytes);
    return { status: r.status, text, json: tryJson(text), headers: r.headers };
  }

  private async rawBytes(method: string, path: string, init: RequestInitLite): Promise<{ status: number; bytes: Uint8Array; headers: Headers }> {
    const m = method.toUpperCase();
    if (!ALLOWED_METHODS.has(m)) {
      // O SDK nunca apaga nada (e a API recusa DELETE com chaves de integração).
      throw new InvalidRequestError(`Método ${m} não é permitido pelo SDK: só GET, POST, PUT e PATCH. Para apagar, use o painel MozeSMS.`);
    }
    let url = this.baseUrl + '/' + path.replace(/^\/+/, '');
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined && v !== null && v !== '') qs.append(k, String(v));
    if ([...qs].length) url += '?' + qs.toString();

    const headers: Record<string, string> = { Accept: 'application/json', 'X-API-Key': this.apiKey, 'X-API-Secret': this.apiSecret };
    if (typeof window === 'undefined') headers['User-Agent'] = `mozesms-js/${VERSION}`; // os browsers proíbem este cabeçalho
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      try {
        body = JSON.stringify(init.json);
      } catch (e) {
        throw new InvalidRequestError('Não foi possível codificar o pedido em JSON: ' + (e as Error).message);
      }
      headers['Content-Type'] = 'application/json';
    } else if (init.form) {
      body = init.form; // o fetch define o boundary
    }

    // Só se repete o que é seguro repetir: GET. Um POST de envio repetido cobraria duas vezes.
    const attempts = m === 'GET' ? this.maxRetries + 1 : 1;
    let lastError: ConnectionError | null = null;
    let last: { status: number; bytes: Uint8Array; headers: Headers } | null = null;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(200 * 2 ** (i - 1));
      try {
        last = await this.send(m, url, headers, body);
        lastError = null;
      } catch (e) {
        if (e instanceof ConnectionError) {
          this.log('warning', 'mozesms: falha de ligação', { method: m, path, attempt: i + 1, error: e.message });
          lastError = e;
          last = null;
          continue;
        }
        throw e;
      }
      if (last.status >= 500 && i < attempts - 1) continue;
      break;
    }
    if (lastError) throw lastError;
    if (!last) throw new ConnectionError('Sem resposta da API');
    this.log(last.status >= 400 ? 'warning' : 'debug', 'mozesms: resposta', { method: m, path, status: last.status });
    return last;
  }

  private async send(method: string, url: string, headers: Record<string, string>, body?: BodyInit) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    try {
      const res = await this.fetchImpl(url, { method, headers, body, signal: ctrl.signal, redirect: 'manual' }); // um redirect reenviaria as credenciais
      const buf = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, bytes: buf, headers: res.headers };
    } catch (e) {
      const err = e as { name?: string; cause?: { code?: string }; code?: string; message?: string };
      if (err?.name === 'AbortError') throw new TimeoutError(`A API não respondeu em ${this.timeout / 1000}s`);
      const code = err?.cause?.code ?? err?.code;
      throw new ConnectionError(`Falha de ligação à API: ${err?.message ?? String(e)}${code ? ` (${code})` : ''}`, !(code && NOT_SENT_CODES.has(code)), { cause: e });
    } finally {
      clearTimeout(timer);
    }
  }

  private toError(res: RawResponse): ApiError {
    const { status } = res;
    const data = res.json ?? {};
    let code: string | undefined;
    let message: string | undefined;
    // Formatos da API: {"error":"CODE|texto","message":"..."} ou {"error":{"code","message"}}.
    if (data.error && typeof data.error === 'object') {
      code = data.error.code !== undefined ? String(data.error.code) : undefined;
      message = data.error.message !== undefined ? String(data.error.message) : undefined;
    } else if (typeof data.error === 'string') {
      code = data.error;
      message = typeof data.message === 'string' ? data.message : data.error;
    } else if (typeof data.message === 'string') {
      message = data.message;
    }
    if (message === undefined) message = res.text !== '' && res.json === null ? `HTTP ${status}: ${excerpt(res.text)}` : `Erro HTTP ${status}`;

    if (status === 402 || code === 'INSUFFICIENT_BALANCE' || code === 'Insufficient balance') return new InsufficientBalanceError(message, status, code, data);
    if (status === 401 || status === 403) return new AuthenticationError(message, status, code, data);
    if (status === 404) return new NotFoundError(message, status, code, data);
    if (status === 409 || status === 410) return new ConflictError(message, status, code, data);
    if (status === 429) {
      const e = new RateLimitError(message, status, code, data);
      const ra = res.headers.get('retry-after');
      if (ra && /^\d+$/.test(ra)) e.retryAfter = Number(ra);
      return e;
    }
    if (status === 400 || status === 422) return new ValidationError(message, status, code, data);
    if (status >= 500) return new ServerError(message, status, code, data);
    return new ApiError(message, status, code, data);
  }

  private log(level: LogLevel, message: string, context: Json) {
    if (!this.logger) return;
    try {
      this.logger(level, message, context);
    } catch {
      // um logger com defeito nunca pode quebrar um envio
    }
  }
}

function tryJson(text: string): Json | null {
  if (text === '') return null;
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

function excerpt(text: string): string {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
