// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MozeSMSProvider, MozeSMSRequestError, createBrowserClient, useBalance, useMozeSMS, useOtp, useSendSms } from '../src/react';
import { MozeSMS } from '../src';

type Reply = { status?: number; body: unknown } | (() => Promise<Response>);

function server(replies: Reply[], strict = true) {
  const calls: Array<{ url: string; action: string; params: any; headers: Record<string, string> }> = [];
  const f = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push({ url, action: body.action, params: body.params, headers: init.headers as Record<string, string> });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (typeof r === 'function') return r();
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  const wrapper = ({ children }: { children: ReactNode }) => {
    const tree = (
      <MozeSMSProvider endpoint="/api/mozesms" fetch={f as unknown as typeof fetch}>
        {children}
      </MozeSMSProvider>
    );
    return strict ? <StrictMode>{tree}</StrictMode> : tree;
  };
  return { f, calls, wrapper };
}

const okData = (data: unknown): Reply => ({ body: { ok: true, data } });
const err = (status: number, code: string, message = code, extra: object = {}): Reply => ({ status, body: { ok: false, error: { code, message, status, ...extra } } });

beforeEach(() => vi.useRealTimers());
afterEach(() => cleanup());

describe('browser client', () => {
  it('chama o endpoint com {action, params} e devolve data', async () => {
    const s = server([okData({ x: 1 })]);
    const c = createBrowserClient({ endpoint: '/api/m', fetch: s.f as unknown as typeof fetch, headers: { 'x-csrf': 't' } });
    expect(await c.call('otp.send', { phone: '1' })).toEqual({ x: 1 });
    expect(s.calls[0]).toMatchObject({ url: '/api/m', action: 'otp.send', params: { phone: '1' } });
    expect(s.calls[0].headers['x-csrf']).toBe('t');
  });

  it('erros do backend → MozeSMSRequestError com code/status/retryAfter', async () => {
    const s = server([err(429, 'RATE_LIMITED', 'calma', { retryAfter: 30 })]);
    const c = createBrowserClient({ endpoint: '/api/m', fetch: s.f as unknown as typeof fetch });
    const e = await c.call('otp.send').catch((x) => x);
    expect(e).toBeInstanceOf(MozeSMSRequestError);
    expect(e).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryAfter: 30, message: 'calma' });
  });

  it('rede, 404 sem JSON e timeout', async () => {
    const net = createBrowserClient({ endpoint: '/x', fetch: (async () => { throw new TypeError('x'); }) as unknown as typeof fetch });
    expect(await net.call('a').catch((x) => x)).toMatchObject({ code: 'NETWORK_ERROR' });
    const nf = createBrowserClient({ endpoint: '/x', fetch: (async () => new Response('<html>', { status: 404 })) as unknown as typeof fetch });
    expect(await nf.call('a').catch((x) => x)).toMatchObject({ code: 'ENDPOINT_NOT_FOUND', status: 404 });
    const slow = createBrowserClient({ endpoint: '/x', timeout: 20, fetch: ((_: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))))) as unknown as typeof fetch });
    expect(await slow.call('a').catch((x) => x)).toMatchObject({ code: 'TIMEOUT' });
  });

  it('cabeçalhos podem ser uma função assíncrona e AbortSignal cancela', async () => {
    const s = server([okData({})]);
    const c = createBrowserClient({ endpoint: '/x', fetch: s.f as unknown as typeof fetch, headers: async () => ({ authorization: 'Bearer abc' }) });
    await c.call('a');
    expect(s.calls[0].headers.authorization).toBe('Bearer abc');
    const ctrl = new AbortController();
    const hang = createBrowserClient({ endpoint: '/x', fetch: ((_: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))))) as unknown as typeof fetch });
    const p = hang.call('a', {}, { signal: ctrl.signal });
    ctrl.abort();
    expect(await p.catch((x) => x)).toMatchObject({ code: 'ABORTED' });
  });
});

describe('Provider', () => {
  it('useMozeSMS sem Provider lança uma mensagem clara', () => {
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {}); // o React regista o erro esperado
    expect(() => renderHook(() => useMozeSMS())).toThrow(/MozeSMSProvider/);
    silence.mockRestore();
  });
  it('cabeçalhos novos a cada render são usados sem recriar o cliente', async () => {
    const s = server([okData({})]);
    let token = 'a';
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <MozeSMSProvider endpoint="/api/mozesms" fetch={s.f as unknown as typeof fetch} headers={{ authorization: token }}>
        {children}
      </MozeSMSProvider>
    );
    const { result, rerender } = renderHook(() => useMozeSMS(), { wrapper: Wrapper });
    await result.current.call('x');
    token = 'b';
    rerender();
    await result.current.call('x');
    expect(s.calls.map((c) => c.headers.authorization)).toEqual(['a', 'b']);
  });
});

describe('useOtp', () => {
  it('fluxo feliz: idle → sent → verified', async () => {
    const s = server([okData({ session_id: 'sess_1', expires_in: 300 }), okData({ verified: true })]);
    const { result } = renderHook(() => useOtp(), { wrapper: s.wrapper });
    expect(result.current.status).toBe('idle');

    let ok = false;
    await act(async () => { ok = await result.current.send('+258 84 600 0000'); });
    expect(ok).toBe(true);
    expect(s.calls[0]).toMatchObject({ action: 'otp.send', params: { phone: '258846000000' } });
    expect(result.current).toMatchObject({ status: 'sent', sessionId: 'sess_1', phone: '258846000000', error: null });
    expect(result.current.secondsLeft).toBeGreaterThan(295);

    await act(async () => { ok = await result.current.verify(' 123456 '); });
    expect(ok).toBe(true);
    expect(s.calls[1]).toMatchObject({ action: 'otp.verify', params: { sessionId: 'sess_1', code: '123456' } });
    expect(result.current).toMatchObject({ status: 'verified', isVerified: true });
  });

  it('número inválido: erro local, nenhum pedido', async () => {
    const s = server([okData({})]);
    const { result } = renderHook(() => useOtp(), { wrapper: s.wrapper });
    await act(async () => { await result.current.send('123'); });
    expect(result.current.error).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(result.current.status).toBe('idle');
    expect(s.calls).toHaveLength(0);
  });

  it('código errado mantém a sessão e permite tentar de novo', async () => {
    const s = server([okData({ session_id: 'sess_1', expires_in: 300 }), okData({ verified: false }), okData({ verified: true })]);
    const { result } = renderHook(() => useOtp(), { wrapper: s.wrapper });
    await act(async () => { await result.current.send('846000000'); });
    let ok = true;
    await act(async () => { ok = await result.current.verify('000000'); });
    expect(ok).toBe(false);
    expect(result.current.status).toBe('sent');
    expect(result.current.error).toMatchObject({ code: 'WRONG_CODE' });
    await act(async () => { ok = await result.current.verify('123456'); });
    expect(ok).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it.each(['EXPIRED', 'MAX_ATTEMPTS', 'SESSION_NOT_FOUND'])('%s → status expired', async (code) => {
    const s = server([okData({ session_id: 'sess_1', expires_in: 300 }), err(410, code)]);
    const { result } = renderHook(() => useOtp(), { wrapper: s.wrapper });
    await act(async () => { await result.current.send('846000000'); });
    await act(async () => { await result.current.verify('1'); });
    expect(result.current.status).toBe('expired');
    expect(result.current.error?.code).toBe(code);
  });

  it('verify sem sessão ou com código vazio não faz pedidos', async () => {
    const s = server([okData({ session_id: 'sess_1', expires_in: 300 })]);
    const { result } = renderHook(() => useOtp(), { wrapper: s.wrapper });
    await act(async () => { expect(await result.current.verify('123456')).toBe(false); });
    await act(async () => { await result.current.send('846000000'); });
    await act(async () => { expect(await result.current.verify('  ')).toBe(false); });
    expect(result.current.error?.code).toBe('INVALID_REQUEST');
    expect(s.calls).toHaveLength(1);
  });

  it('erro de envio (limite): fica idle com o erro e respeita retryAfter no reenvio', async () => {
    const s = server([err(429, 'RATE_LIMITED', 'calma', { retryAfter: 120 })]);
    const { result } = renderHook(() => useOtp(), { wrapper: s.wrapper });
    await act(async () => { expect(await result.current.send('846000000')).toBe(false); });
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toMatchObject({ code: 'RATE_LIMITED', retryAfter: 120 });
    expect(result.current.resendIn).toBeGreaterThan(115);
  });

  it('503 genérico do servidor não revela detalhes', async () => {
    const s = server([err(503, 'SERVICE_UNAVAILABLE', 'Serviço indisponível de momento. Tente mais tarde.')]);
    const { result } = renderHook(() => useOtp(), { wrapper: s.wrapper });
    await act(async () => { await result.current.send('846000000'); });
    expect(result.current.error?.message).toMatch(/indisponível/);
  });

  it('cooldown de reenvio e contagem decrescente', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const s = server([okData({ session_id: 'sess_1', expires_in: 100 }), okData({ session_id: 'sess_2', expires_in: 100 })]);
    const { result } = renderHook(() => useOtp({ resendCooldown: 10 }), { wrapper: s.wrapper });
    await act(async () => { await result.current.send('846000000'); });
    expect(result.current.resendIn).toBe(10);
    expect(result.current.canResend).toBe(false);
    await act(async () => { expect(await result.current.resend()).toBe(false); }); // ainda em cooldown
    expect(s.calls).toHaveLength(1);

    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(result.current.resendIn).toBe(0);
    expect(result.current.secondsLeft).toBe(90);
    expect(result.current.canResend).toBe(true);
    await act(async () => { await result.current.resend(); });
    expect(result.current.sessionId).toBe('sess_2');

    await act(async () => { vi.advanceTimersByTime(101_000); });
    expect(result.current.status).toBe('expired'); // expira sozinho
    expect(result.current.secondsLeft).toBe(0);
  });

  it('impede cliques duplos e ignora respostas depois de desmontar', async () => {
    let release!: (r: Response) => void;
    const pending = () => new Promise<Response>((r) => { release = r; });
    const s = server([pending]);
    const { result, unmount } = renderHook(() => useOtp(), { wrapper: s.wrapper });
    let first!: Promise<boolean>;
    act(() => { first = result.current.send('846000000'); });
    await act(async () => { expect(await result.current.send('846000000')).toBe(false); }); // 2.º clique ignorado
    expect(s.calls).toHaveLength(1);
    unmount();
    release(new Response(JSON.stringify({ ok: true, data: { session_id: 'x', expires_in: 5 } })));
    await expect(first).resolves.toBe(true); // sem avisos de setState após unmount
  });

  it('reset volta ao início', async () => {
    const s = server([okData({ session_id: 'sess_1', expires_in: 300 })]);
    const { result } = renderHook(() => useOtp(), { wrapper: s.wrapper });
    await act(async () => { await result.current.send('846000000'); });
    act(() => result.current.reset());
    expect(result.current).toMatchObject({ status: 'idle', sessionId: null, phone: null, error: null, secondsLeft: 0 });
  });
});

describe('useSendSms e useBalance', () => {
  it('useSendSms envia pela ação sms.send', async () => {
    const s = server([okData({ id: 'abc', status: 'enviado' })]);
    const { result } = renderHook(() => useSendSms(), { wrapper: s.wrapper });
    await act(async () => { await result.current.send('846000000', 'Olá', 'MozeSMS'); });
    expect(s.calls[0]).toMatchObject({ action: 'sms.send', params: { phone: '846000000', message: 'Olá', sender_id: 'MozeSMS' } });
    expect(result.current.data?.id).toBe('abc');
    expect(result.current.error).toBeNull();
  });

  it('useSendSms: erro fica em error e run não lança', async () => {
    const s = server([err(404, 'UNKNOWN_ACTION', 'Ação desconhecida.')]);
    const { result } = renderHook(() => useSendSms(), { wrapper: s.wrapper });
    let r: unknown = 'x';
    await act(async () => { r = await result.current.send('846000000', 'Olá'); });
    expect(r).toBeUndefined();
    expect(result.current.error?.code).toBe('UNKNOWN_ACTION');
  });

  it('useBalance carrega ao montar e refresca', async () => {
    const s = server([okData({ balance: 10, currency: 'MZN', sms_price: 1.35, estimated_sms: 7 }), okData({ balance: 8, currency: 'MZN', sms_price: 1.35, estimated_sms: 5 })], false); // sem StrictMode: este duplica os efeitos em dev
    const { result } = renderHook(() => useBalance(), { wrapper: s.wrapper });
    await waitFor(() => expect(result.current.balance?.balance).toBe(10));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.balance?.balance).toBe(8);
    expect(s.calls.map((c) => c.action)).toEqual(['account.balance', 'account.balance']);
  });

  it('useBalance({auto:false}) não chama sozinho', () => {
    const s = server([okData({})]);
    renderHook(() => useBalance({ auto: false }), { wrapper: s.wrapper });
    expect(s.calls).toHaveLength(0);
  });

  it('ordem de respostas: só a última chamada conta', async () => {
    let r1!: (r: Response) => void;
    const s = server([() => new Promise<Response>((r) => { r1 = r; }), okData({ id: 'segunda', status: 'enviado' })]);
    const { result } = renderHook(() => useSendSms(), { wrapper: s.wrapper });
    let p1!: Promise<unknown>;
    act(() => { p1 = result.current.send('846000000', 'um'); });
    await act(async () => { await result.current.send('846000000', 'dois'); });
    await act(async () => { r1(new Response(JSON.stringify({ ok: true, data: { id: 'primeira', status: 'enviado' } }))); await p1; });
    expect(result.current.data?.id).toBe('segunda');
  });
});

describe('segurança do pacote', () => {
  it('o cliente de servidor recusa-se a correr num browser (jsdom) sem a flag explícita', () => {
    expect(() => new MozeSMS({ apiKey: 'mk', apiSecret: 'sk' })).toThrow(/browser/i);
    expect(() => new MozeSMS({ apiKey: 'mk', apiSecret: 'sk', dangerouslyAllowBrowser: true })).not.toThrow();
  });
});
