# @woomoza/mozesms — SDK MozeSMS para JavaScript / React

Cliente da API MozeSMS (`https://api.mozesms.com`) para **Node, Next.js e React**, em TypeScript, sem dependências
(só o `fetch` do Node 18+). Tem três partes:

| Import | Corre em | Para quê |
|---|---|---|
| `@woomoza/mozesms` | **servidor** | cliente completo da API (SMS, OTP, sender IDs, recargas, contactos, campanhas, WhatsApp, webhooks) |
| `@woomoza/mozesms/server` | **servidor** | `createHandler`: o endpoint seguro que os hooks de React chamam |
| `@woomoza/mozesms/react` | **browser** | `MozeSMSProvider` e hooks (`useOtp`, `useSendSms`, `useBalance`) |

## ⚠️ O secret nunca vai para o browser

A API usa uma chave e um **secret**. Num site React, tudo o que corre no browser é visível por qualquer pessoa, por isso o
secret **não pode** estar lá. A arquitetura é esta:

```
React (browser)  ──useOtp()──▶  a SUA rota /api/mozesms  ──(chave + secret)──▶  api.mozesms.com
 sem credenciais                 createHandler: só ações permitidas,
                                 limites, anti-CSRF
```

O SDK **recusa-se a correr num browser** (lança erro) se tentar `new MozeSMS(...)` lá. O bundle de React não contém código
de credenciais.

## Instalar

```bash
npm install @woomoza/mozesms
```

Requisitos: Node 18+ no servidor; React 17+ só se usar os hooks (peer dependency opcional).

## Início rápido (Next.js, App Router)

**1.** Chaves no `.env.local` (painel MozeSMS → API). Nunca com prefixo `NEXT_PUBLIC_`:

```
MOZESMS_KEY=mk_...
MOZESMS_SECRET=sk_...
```

**2.** A rota do servidor, `app/api/mozesms/route.ts`:

```ts
import { MozeSMS } from '@woomoza/mozesms';
import { createHandler } from '@woomoza/mozesms/server';

export const POST = createHandler({
  client: new MozeSMS({ apiKey: process.env.MOZESMS_KEY!, apiSecret: process.env.MOZESMS_SECRET!, allowedCountries: ['258'] }),
  otp: { sender_id: 'MINHALOJA', digits: 6, expiry: 300 },   // fixos: o browser não os pode mudar
  trustProxy: true,                                          // atrás da Vercel/proxy seu
  onError: (error, { action }) => console.error('[mozesms]', action, error),
});
```

**3.** O Provider, uma vez, no `app/layout.tsx`:

```tsx
import { MozeSMSProvider } from '@woomoza/mozesms/react';

<MozeSMSProvider endpoint="/api/mozesms">{children}</MozeSMSProvider>
```

**4.** Um componente de verificação por OTP (`'use client'`):

```tsx
const otp = useOtp();

await otp.send('+258 84 600 0000');     // status: 'sent'
const ok = await otp.verify('123456');  // true | false; o erro fica em otp.error
```

Exemplo completo (formulário com reenvio, contagem decrescente e erros) em
[`examples/nextjs/components/OtpForm.tsx`](examples/nextjs/components/OtpForm.tsx).

## Hooks

### `useOtp({ resendCooldown = 30 })`

| | |
|---|---|
| `status` | `'idle'` → `'sending'` → `'sent'` → `'verifying'` → `'verified'` ou `'expired'` (também quando o tempo acaba) |
| `send(phone)` | normaliza e valida o número no browser; devolve `true/false` |
| `verify(code)` | `true` certo, `false` errado (a sessão mantém-se e pode tentar de novo) |
| `resend()` / `canResend` / `resendIn` | reenvio com cooldown (segundos) |
| `secondsLeft` | segundos até o código expirar |
| `error` | `MozeSMSRequestError` com `code`: `WRONG_CODE`, `EXPIRED`, `MAX_ATTEMPTS`, `SESSION_NOT_FOUND`, `RATE_LIMITED` (com `retryAfter`), `INVALID_REQUEST`, `SERVICE_UNAVAILABLE`, `NETWORK_ERROR` |
| `phone`, `sessionId`, `isSending`, `isVerifying`, `isVerified`, `reset()` | |

Já trata: cliques duplos (ignora o 2.º pedido), respostas que chegam depois de desmontar o componente, `StrictMode`, e
`RATE_LIMITED` (bloqueia o reenvio durante `retryAfter`).

### `useSendSms()` e `useBalance()`

```tsx
const { send, data, error, loading } = useSendSms();   // exige a ação 'sms.send' no handler + authorize
const { balance, refresh } = useBalance();             // exige 'account.balance' + authorize
```

### `useMozeSMSAction(action)` — qualquer ação permitida

`run(params)` **nunca lança**: devolve `undefined` e põe o erro em `error`. Se chamar `run` duas vezes seguidas, só conta a última resposta.

## O handler (`createHandler`)

Por omissão expõe **só** `otp.send` e `otp.verify`. Para expor outras ações tem de as listar em `allow` **e** definir
`authorize`; sem isso o `createHandler` lança erro ao arrancar (senão qualquer visitante gastaria o seu saldo):

```ts
createHandler({
  client,
  allow: ['otp.send', 'otp.verify', 'sms.send'],
  authorize: async ({ request, action, params }) => {
    const session = await getSession(request);      // a sua autenticação
    return action.startsWith('otp.') || !!session;
  },
});
```

Ações disponíveis (`AVAILABLE_ACTIONS`): `otp.send`, `otp.verify`, `otp.status`, `otp.cancel`, `sms.send`, `sms.bulk`, `sms.status`,
`sms.history`, `account.balance`, `billing.gateways`, `billing.calculate`, `billing.topup`, `billing.transactionStatus`,
`senderIds.list`, `whatsapp.sendText`.

**Proteções incluídas**

- **Limites no OTP** (anti-abuso de SMS e força bruta): 3 envios por número em 10 min, 20 por IP por hora, 10 verificações por sessão em 10 min. Configuráveis em `rateLimit`; use `rateLimit: { store }` com Redis/KV em produção (a memória por omissão não é partilhada entre instâncias serverless).
- **Opções do OTP fixas no servidor** (`otp: {...}`): o browser só indica o telefone; não pode mudar o texto, o remetente nem a validade (evita usar o seu remetente para phishing).
- **Anti-CSRF**: só `application/json`, e pedidos *cross-site* de browsers são recusados; `allowedOrigins` para permitir o seu frontend noutra origem.
- **Erros sem fugas**: saldo, credenciais e 5xx nunca chegam ao browser; recebe `503 SERVICE_UNAVAILABLE` genérico e os detalhes vão para `onError`.
- Ações não permitidas respondem `404` (não revela quais existem); respostas com `cache-control: no-store`; corpo limitado a 16 KB.
- O IP para o limite só é lido do `X-Forwarded-For` com `trustProxy: true` ou via `getClientIp` (senão um cliente poderia forjá-lo).

**Express / Node:** `app.post('/api/mozesms', toNodeHandler(handler))` (funciona com ou sem `express.json()`). Exemplo em
[`examples/node/server.ts`](examples/node/server.ts), com CORS para um frontend Vite noutra porta.

## Cliente de servidor

```ts
import { MozeSMS } from '@woomoza/mozesms';

const moze = new MozeSMS({ apiKey: process.env.MOZESMS_KEY!, apiSecret: process.env.MOZESMS_SECRET! });

await moze.account.balance();
const sms = await moze.sms.send('846000000', 'Olá!', 'MozeSMS');
await moze.sms.status(sms.id);
await moze.sms.bulk(['846000000', '+27821234567'], 'Olá {{nome}}', 'MozeSMS');
await moze.sms.schedule(['846000000'], 'Lembrete', '2026-12-01 09:00:00', 'MozeSMS');

const s = await moze.otp.send('846000000');
await moze.otp.check(s.session_id, codigo);                // true | false

await moze.senderIds.request('MINHALOJA', 'alfanumerico', 'transacional', 'Notificações da loja');  // DEBITA o saldo
await moze.billing.topup(500, 'mpesa', '846000000');       // recarga PENDENTE; saldo sobe quando o pagamento é confirmado
```

| Propriedade | Operações |
|---|---|
| `sms` | send, bulk, bulkMessages, status, history, exportHistory, schedule, schedules |
| `otp` | send, verify, check, status, cancel, sessions, stats |
| `account` | balance, profile, updateProfile, plan, tenantPlans, tenantInfo, pricing, apiStatus |
| `senderIds` | request, list, all, withFilters, get, share, setDefault, history, activity, filters/addFilter/updateFilter/filterStats, documents/uploadDocument/downloadDocument/documentRequests |
| `billing` | gateways, calculate, topup (purchase), paypalCapture, transactions, transaction, transactionStatus, uploadProof, reactivate, invoices, downloadInvoice |
| `contacts` / `groups` | list, create, get, update, import (CSV), bulkAssign / list, create, get, update, contacts, addContacts |
| `templates` | list, create, get, update |
| `campaigns` | list, export, create, get, update, recipients, addRecipients, send, cancel, report, duplicate |
| `reports`, `dashboard`, `apiLogs`, `notifications` | só leitura (e markRead/readAll) |
| `webhooks` | list, create, get, update, toggle, test, logs |
| `whatsapp` | sessões, envio (texto, média, ficheiro, localização, grupo), grupos, contactos, webhooks da sessão, mais `templates`, `labels`, `campaigns`, `automations` e `billing` |

Operações sobre um item devolvem o conteúdo de `data`; listagens devolvem o corpo completo (`data` + `pagination`).
Uploads (`uploadDocument`, `uploadProof`, `contacts.import`, `whatsapp.sendFile`) aceitam `Blob`/`File` ou `{ data, filename }`:

```ts
import { openAsBlob } from 'node:fs';
await moze.senderIds.uploadDocument(7, 'alvara', { data: await openAsBlob('alvara.pdf'), filename: 'alvara.pdf' });
```

**Fora do SDK de propósito:** chaves de API, login/registo, administração, white-label, afiliados, helpdesk, IPs permitidos
do WhatsApp e confirmação manual de pagamentos.

### Opções do cliente

`baseUrl`, `timeout` (ms, 30000), `maxRetries` (2, só GET), `allowedCountries`, `validatePhones` (true), `fetch`, `logger`
(nunca recebe credenciais) e `dangerouslyAllowBrowser` (**não use**).

## Números de qualquer país

Formato internacional: `+27 82 123 4567`, `0027821234567` ou `27821234567`. O SDK normaliza para dígitos E.164 (`normalizePhone`,
`isValidPhone`). Atalho: 9 dígitos começados por 8 ou 9 são Moçambique (`846000000` → `258846000000`). Moçambique é validado a
fundo; os outros países só quanto ao formato E.164. `allowedCountries: ['258', '27']` restringe países.

> **Atenção:** a API de SMS atual **só envia para Moçambique**. Para outros países o SDK aceita o número, mas o servidor trata-o
> como inválido e **cobra-o sem enviar**, até o envio internacional estar ativo. Enquanto isso use `allowedCountries: ['258']`.
> O WhatsApp já aceita números internacionais.

## O SDK nunca apaga

Não há nenhum método que apague ou cancele dados (sender IDs, contactos, campanhas, agendamentos, webhooks, sessões WhatsApp...)
e o cliente recusa qualquer pedido que não seja GET, POST, PUT ou PATCH. A API também recusa `DELETE` com chaves de integração
(`403 DELETE_NOT_ALLOWED`). Para apagar algo, use o painel.

## Erros

Todos estendem `MozeSMSError` e todos os métodos são `async` (um erro de validação é sempre uma promessa rejeitada, nunca uma exceção síncrona).

| Classe | Quando |
|---|---|
| `InvalidRequestError` | validação **local**: nada foi enviado nem cobrado (`problems` lista p.ex. os números inválidos) |
| `AuthenticationError` | 401/403 |
| `InsufficientBalanceError` | 402 (`body` traz `current_balance` e `required_amount`) |
| `ValidationError` | 400/422 (no OTP, código errado = `code: 'WRONG_CODE'`) |
| `NotFoundError` / `ConflictError` | 404 / 409 e 410 (OTP já verificado, expirado) |
| `RateLimitError` | 429 (`retryAfter`) |
| `ServerError` | 5xx (num envio o SMS pode já estar registado: confirme em `sms.history()` antes de repetir) |
| `InvalidResponseError` | 2xx mas o corpo não é JSON |
| `ConnectionError` / `TimeoutError` | rede/timeout; `mayHaveReachedServer` diz se repetir é seguro |
| `SignatureVerificationError` | webhook com assinatura inválida |

**Repetições:** só os pedidos GET se repetem (falha de rede e 5xx). Os POST **nunca**: um envio repetido seria cobrado duas vezes.

## Webhooks

A MozeSMS assina o corpo com HMAC-SHA256 (hex) no cabeçalho `X-MozeSMS-Signature`. Valide **sobre o corpo bruto**:

```ts
const event = await constructWebhookEvent(await request.text(), request.headers.get('x-mozesms-signature'), process.env.MOZESMS_WEBHOOK_SECRET!);
```

Funciona em Node, edge e Next.js (Web Crypto). Exemplo em [`examples/nextjs/app/api/mozesms-webhook/route.ts`](examples/nextjs/app/api/mozesms-webhook/route.ts).
Eventos: `sms.sent`, `sms.delivered`, `sms.undelivered`, `sms.failed`, `sms.expired`, `sms.cancelled`, `sms.undeliverable`, `sms.rejected`, `sms.unknown`.

## Desenvolvimento

```bash
npm install
npm test            # 133 testes (núcleo, handler, hooks de React); nenhum pedido real
npm run typecheck   # inclui os exemplos
npm run build       # dist/ em ESM + CJS + .d.ts
```
