import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizePhone } from '../phone';
import { MozeSMSRequestError } from './browser';
import { useMozeSMS } from './context';

function useMounted() {
  const ref = useRef(true);
  useEffect(() => {
    ref.current = true; // StrictMode corre o efeito duas vezes
    return () => {
      ref.current = false;
    };
  }, []);
  return ref;
}

function toRequestError(e: unknown): MozeSMSRequestError {
  return e instanceof MozeSMSRequestError ? e : new MozeSMSRequestError((e as Error)?.message || 'Erro desconhecido.', 'UNKNOWN', 0);
}

// ---------------------------------------------------------------------------------------------------------------------

export interface ActionState<T> {
  data: T | null;
  error: MozeSMSRequestError | null;
  loading: boolean;
}

/**
 * Hook genérico para qualquer ação permitida no handler. `run` nunca lança: o erro fica em `error`
 * e `run` devolve `undefined`. Se chamar `run` duas vezes seguidas, só o resultado da última conta.
 */
export function useMozeSMSAction<T = any, P extends Record<string, unknown> = Record<string, unknown>>(action: string) {
  const client = useMozeSMS();
  const mounted = useMounted();
  const latest = useRef(0);
  const [state, setState] = useState<ActionState<T>>({ data: null, error: null, loading: false });

  const run = useCallback(
    async (params?: P): Promise<T | undefined> => {
      const id = ++latest.current;
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const data = await client.call<T>(action, params);
        if (mounted.current && id === latest.current) setState({ data, error: null, loading: false });
        return data;
      } catch (e) {
        if (mounted.current && id === latest.current) setState((s) => ({ data: s.data, error: toRequestError(e), loading: false }));
        return undefined;
      }
    },
    [client, action, mounted],
  );

  const reset = useCallback(() => {
    latest.current++;
    setState({ data: null, error: null, loading: false });
  }, []);

  return { ...state, run, reset };
}

// ---------------------------------------------------------------------------------------------------------------------

export type OtpStatus = 'idle' | 'sending' | 'sent' | 'verifying' | 'verified' | 'expired';

export interface UseOtpOptions {
  /** Segundos até permitir reenviar. Por omissão 30. */
  resendCooldown?: number;
}

const FATAL_VERIFY_CODES = new Set(['EXPIRED', 'MAX_ATTEMPTS', 'SESSION_NOT_FOUND']);

/**
 * Fluxo completo de verificação por OTP. O backend (createHandler) decide remetente, nº de dígitos e validade.
 *
 *     const otp = useOtp();
 *     await otp.send('+258 84 600 0000');       // → status 'sent'
 *     const ok = await otp.verify('123456');    // true | false  (erro em otp.error)
 */
export function useOtp(options: UseOtpOptions = {}) {
  const client = useMozeSMS();
  const mounted = useMounted();
  const cooldown = options.resendCooldown ?? 30;

  const [status, setStatus] = useState<OtpStatus>('idle');
  const [phone, setPhone] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const [error, setError] = useState<MozeSMSRequestError | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const busy = useRef(false);

  // Relógio de 1 s só enquanto há algo a contar.
  const counting = (expiresAt !== null && status === 'sent') || (resendAt !== null && resendAt > now);
  useEffect(() => {
    if (!counting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    setNow(Date.now());
    return () => clearInterval(t);
  }, [counting]);

  const secondsLeft = expiresAt === null ? 0 : Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const resendIn = resendAt === null ? 0 : Math.max(0, Math.ceil((resendAt - now) / 1000));
  const effectiveStatus: OtpStatus = status === 'sent' && expiresAt !== null && now >= expiresAt ? 'expired' : status;

  const send = useCallback(
    async (rawPhone: string): Promise<boolean> => {
      if (busy.current) return false;
      const normalized = normalizePhone(rawPhone);
      if (!normalized) {
        setError(new MozeSMSRequestError('Número de telefone inválido.', 'INVALID_REQUEST', 400));
        return false;
      }
      busy.current = true;
      setStatus('sending');
      setError(null);
      try {
        const data = await client.call<{ session_id: string; expires_in?: number }>('otp.send', { phone: normalized });
        if (!mounted.current) return true;
        const t = Date.now();
        setPhone(normalized);
        setSessionId(data.session_id);
        setExpiresAt(t + (data.expires_in ?? 300) * 1000);
        setResendAt(t + cooldown * 1000);
        setNow(t);
        setStatus('sent');
        return true;
      } catch (e) {
        if (mounted.current) {
          const err = toRequestError(e);
          setError(err);
          setStatus(sessionId ? 'sent' : 'idle'); // um reenvio falhado não perde a sessão anterior
          if (err.code === 'RATE_LIMITED' && err.retryAfter) setResendAt(Date.now() + err.retryAfter * 1000);
        }
        return false;
      } finally {
        busy.current = false;
      }
    },
    [client, mounted, cooldown, sessionId],
  );

  const resend = useCallback(async (): Promise<boolean> => {
    if (!phone || resendIn > 0) return false;
    return send(phone);
  }, [phone, resendIn, send]);

  const verify = useCallback(
    async (code: string): Promise<boolean> => {
      const clean = String(code ?? '').trim();
      if (busy.current || !sessionId) return false;
      if (!clean) {
        setError(new MozeSMSRequestError('Indique o código.', 'INVALID_REQUEST', 400));
        return false;
      }
      busy.current = true;
      setStatus('verifying');
      setError(null);
      try {
        const data = await client.call<{ verified: boolean }>('otp.verify', { sessionId, code: clean });
        if (!mounted.current) return !!data?.verified;
        if (data?.verified) {
          setStatus('verified');
          return true;
        }
        setStatus('sent');
        setError(new MozeSMSRequestError('Código incorreto.', 'WRONG_CODE', 422));
        return false;
      } catch (e) {
        if (mounted.current) {
          const err = toRequestError(e);
          setError(err);
          setStatus(err.code && FATAL_VERIFY_CODES.has(err.code) ? 'expired' : 'sent');
        }
        return false;
      } finally {
        busy.current = false;
      }
    },
    [client, mounted, sessionId],
  );

  const reset = useCallback(() => {
    busy.current = false;
    setStatus('idle');
    setPhone(null);
    setSessionId(null);
    setExpiresAt(null);
    setResendAt(null);
    setError(null);
  }, []);

  return {
    /** idle → sending → sent → verifying → verified | expired */
    status: effectiveStatus,
    isSending: status === 'sending',
    isVerifying: status === 'verifying',
    isVerified: status === 'verified',
    /** Número normalizado (E.164, só dígitos) do último envio. */
    phone,
    sessionId,
    /** Segundos até o código expirar. */
    secondsLeft,
    /** Segundos até poder reenviar. */
    resendIn,
    canResend: !!phone && resendIn === 0 && status !== 'sending' && status !== 'verifying',
    error,
    send,
    resend,
    verify,
    reset,
  };
}

// ---------------------------------------------------------------------------------------------------------------------

export interface SmsResult {
  id: string;
  status: string;
  phone?: string;
  cost?: number;
  remaining_balance?: number;
  [k: string]: unknown;
}

/** Envia um SMS (ação 'sms.send': tem de estar em `allow` e exige `authorize` no handler). */
export function useSendSms() {
  const a = useMozeSMSAction<SmsResult>('sms.send');
  const send = useCallback((phone: string, message: string, senderId?: string) => a.run({ phone, message, ...(senderId ? { sender_id: senderId } : {}) }), [a.run]);
  return { send, data: a.data, error: a.error, loading: a.loading, reset: a.reset };
}

export interface BalanceData {
  balance: number;
  currency: string;
  sms_price: number;
  estimated_sms: number;
  [k: string]: unknown;
}

/** Saldo da conta (ação 'account.balance': só para áreas autenticadas, com `authorize`). */
export function useBalance(options: { auto?: boolean } = {}) {
  const a = useMozeSMSAction<BalanceData>('account.balance');
  const auto = options.auto ?? true;
  const run = a.run;
  useEffect(() => {
    if (auto) void run();
  }, [auto, run]);
  return { balance: a.data, error: a.error, loading: a.loading, refresh: () => run() };
}
