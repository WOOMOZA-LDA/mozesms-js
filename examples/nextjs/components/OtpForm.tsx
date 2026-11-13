'use client';

// Verificação de telefone por OTP, com reenvio, contagem decrescente e erros tratados.
import { useOtp } from '@woomoza/mozesms/react';
import { useState, type FormEvent } from 'react';

const messages: Record<string, string> = {
  INVALID_REQUEST: 'Verifique o número ou o código.',
  WRONG_CODE: 'Código incorreto. Tente de novo.',
  EXPIRED: 'O código expirou. Peça um novo.',
  MAX_ATTEMPTS: 'Demasiadas tentativas. Peça um novo código.',
  SESSION_NOT_FOUND: 'Sessão inválida. Peça um novo código.',
  RATE_LIMITED: 'Demasiados pedidos. Aguarde um pouco.',
  SERVICE_UNAVAILABLE: 'Serviço indisponível de momento. Tente mais tarde.',
  NETWORK_ERROR: 'Sem ligação. Verifique a internet.',
};

export function OtpForm({ onVerified }: { onVerified: (phone: string) => void }) {
  const otp = useOtp({ resendCooldown: 30 });
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');

  const errorText = otp.error ? messages[otp.error.code ?? ''] ?? otp.error.message : null;

  async function submitPhone(e: FormEvent) {
    e.preventDefault();
    await otp.send(phone);
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (await otp.verify(code)) onVerified(otp.phone!);
  }

  if (otp.isVerified) return <p>Telefone verificado ✓</p>;

  if (otp.status === 'idle' || otp.status === 'sending' || otp.status === 'expired') {
    return (
      <form onSubmit={submitPhone}>
        <label>
          Telefone
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+258 84 600 0000" inputMode="tel" autoComplete="tel" />
        </label>
        <button disabled={otp.isSending || !phone.trim()}>{otp.isSending ? 'A enviar…' : 'Enviar código'}</button>
        {errorText && <p role="alert">{errorText}</p>}
      </form>
    );
  }

  return (
    <form onSubmit={submitCode}>
      <p>Enviámos um código para +{otp.phone}. Expira em {otp.secondsLeft}s.</p>
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Código" inputMode="numeric" autoComplete="one-time-code" maxLength={10} />
      <button disabled={otp.isVerifying || !code.trim()}>{otp.isVerifying ? 'A verificar…' : 'Verificar'}</button>
      <button type="button" disabled={!otp.canResend} onClick={() => otp.resend()}>
        {otp.resendIn > 0 ? `Reenviar em ${otp.resendIn}s` : 'Reenviar código'}
      </button>
      <button type="button" onClick={otp.reset}>Mudar número</button>
      {errorText && <p role="alert">{errorText}</p>}
    </form>
  );
}
