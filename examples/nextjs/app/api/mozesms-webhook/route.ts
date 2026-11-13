// app/api/mozesms-webhook/route.ts — recebe o estado das mensagens (entregue, falhou...).
//
// 1) .env.local:  MOZESMS_WEBHOOK_SECRET=whsec_...   (devolvido ao criar o webhook)
// 2) criar o webhook (uma vez, num script do servidor):
//      await moze.webhooks.create('O meu site', 'https://o-seu-site.co/api/mozesms-webhook', ['sms.delivered', 'sms.failed']);
import { SignatureVerificationError, constructWebhookEvent } from '@woomoza/mozesms';

export async function POST(request: Request) {
  // O corpo BRUTO: a assinatura cobre os bytes exatos. Não use request.json() antes.
  const raw = await request.text();
  try {
    const event = await constructWebhookEvent(raw, request.headers.get('x-mozesms-signature'), process.env.MOZESMS_WEBHOOK_SECRET!);
    const name = request.headers.get('x-mozesms-event') ?? 'unknown';

    // O mesmo evento pode chegar mais de uma vez: torne isto idempotente (p.ex. upsert por id da mensagem).
    console.log('[mozesms webhook]', name, event);

    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof SignatureVerificationError) return new Response('invalid signature', { status: 401 });
    return new Response('error', { status: 500 }); // a MozeSMS volta a tentar
  }
}
