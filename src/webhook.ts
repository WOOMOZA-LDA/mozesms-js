import { SignatureVerificationError } from './errors';
import type { Json } from './http';

/**
 * Verifica webhooks recebidos. A MozeSMS envia o cabeçalho X-MozeSMS-Signature com o HMAC-SHA256 (hex) do corpo EXATO
 * do pedido, usando o secret do webhook, e X-MozeSMS-Event com o evento. Funciona em Node 18+, edge e browsers (Web Crypto).
 *
 * Use o corpo BRUTO (texto), não o objeto já convertido pelo framework. Em Express: `express.raw({ type: '*\/*' })`;
 * em Next.js (App Router): `await request.text()`.
 */
export async function signWebhook(rawBody: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyWebhookSignature(rawBody: string, signature: string | null | undefined, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  const expected = await signWebhook(rawBody, secret);
  return timingSafeEqual(expected, signature.trim().toLowerCase());
}

/** Valida e decodifica; lança SignatureVerificationError se a assinatura não bater ou o corpo não for JSON. */
export async function constructWebhookEvent(rawBody: string, signature: string | null | undefined, secret: string): Promise<Json> {
  if (!(await verifyWebhookSignature(rawBody, signature, secret))) throw new SignatureVerificationError();
  let data: unknown;
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new SignatureVerificationError('Corpo do webhook não é JSON válido');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new SignatureVerificationError('Corpo do webhook não é JSON válido');
  return data as Json;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
