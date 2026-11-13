// app/api/mozesms/route.ts — o ÚNICO sítio que conhece o secret. O browser só fala com esta rota.
//
// .env.local:
//   MOZESMS_KEY=mk_...
//   MOZESMS_SECRET=sk_...
import { MozeSMS } from '@woomoza/mozesms';
import { createHandler } from '@woomoza/mozesms/server';

const client = new MozeSMS({
  apiKey: process.env.MOZESMS_KEY!,
  apiSecret: process.env.MOZESMS_SECRET!,
  // Enquanto a API só envia SMS para Moçambique, deixe isto ligado.
  allowedCountries: ['258'],
});

// Por omissão só expõe otp.send e otp.verify, com limites por número e por IP.
export const POST = createHandler({
  client,
  otp: { sender_id: 'MINHALOJA', digits: 6, expiry: 300 }, // fixos: o browser não os pode mudar
  trustProxy: true, // na Vercel/atrás de um proxy seu, para o limite por IP funcionar
  onError: (error, { action }) => console.error('[mozesms]', action, error), // saldo, credenciais, 5xx
});

// Para expor mais ações (gasta saldo!), liste-as E diga quem pode usá-las:
//
// export const POST = createHandler({
//   client,
//   allow: ['otp.send', 'otp.verify', 'sms.send', 'account.balance'],
//   authorize: async ({ request, action }) => {
//     const session = await getSession(request);        // a sua autenticação
//     return action.startsWith('otp.') || session?.role === 'admin';
//   },
// });
