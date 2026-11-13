/** Erro base do SDK. */
export class MozeSMSError extends Error {
  /** Código curto, p.ex. WRONG_CODE, INSUFFICIENT_BALANCE, INVALID_REQUEST. */
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Recusado pelo SDK antes de qualquer pedido: nada foi enviado nem cobrado. */
export class InvalidRequestError extends MozeSMSError {
  /** Valores problemáticos, p.ex. os números inválidos. */
  problems: string[];

  constructor(message: string, problems: string[] = []) {
    super(message, 'INVALID_REQUEST');
    this.problems = problems;
  }
}

/**
 * Falha de rede ou timeout. Antes de repetir um POST de envio veja `mayHaveReachedServer`:
 * se for true, o pedido pode ter sido processado (e cobrado).
 */
export class ConnectionError extends MozeSMSError {
  mayHaveReachedServer: boolean;

  constructor(message: string, mayHaveReachedServer = true, options?: { cause?: unknown }) {
    super(message, 'CONNECTION_ERROR');
    this.mayHaveReachedServer = mayHaveReachedServer;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** O servidor não respondeu a tempo. O envio pode ter sido feito. */
export class TimeoutError extends ConnectionError {
  constructor(message: string) {
    super(message, true);
    this.code = 'TIMEOUT';
  }
}

/** A API respondeu com erro (HTTP >= 400 ou success=false). */
export class ApiError extends MozeSMSError {
  status: number;
  /** Corpo completo da resposta. */
  body: Record<string, any>;

  constructor(message: string, status: number, code?: string, body: Record<string, any> = {}) {
    super(message, code);
    this.status = status;
    this.body = body;
  }
}

export class AuthenticationError extends ApiError {}
export class InsufficientBalanceError extends ApiError {}
/** 400/422: dados inválidos (no OTP, código errado = code WRONG_CODE). */
export class ValidationError extends ApiError {}
export class NotFoundError extends ApiError {}
/** 409/410: OTP já verificado, expirado... */
export class ConflictError extends ApiError {}
export class ServerError extends ApiError {}
/** 2xx mas o corpo não é JSON (proxy, manutenção). */
export class InvalidResponseError extends ApiError {}

export class RateLimitError extends ApiError {
  /** Segundos a esperar (cabeçalho Retry-After), se a API o indicou. */
  retryAfter?: number;
}

/** Webhook com assinatura em falta/inválida ou corpo que não é JSON. Responda 401/400. */
export class SignatureVerificationError extends MozeSMSError {
  constructor(message = 'Assinatura de webhook inválida ou em falta') {
    super(message, 'INVALID_SIGNATURE');
  }
}
