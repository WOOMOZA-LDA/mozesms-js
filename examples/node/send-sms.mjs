// Script de servidor: enviar um SMS, ver o estado e o saldo. GASTA saldo.
//   MOZESMS_KEY=mk_... MOZESMS_SECRET=sk_... node examples/node/send-sms.mjs 846000000 "Olá!"
import { InsufficientBalanceError, InvalidRequestError, MozeSMS } from '@woomoza/mozesms';

const moze = new MozeSMS({ apiKey: process.env.MOZESMS_KEY, apiSecret: process.env.MOZESMS_SECRET, allowedCountries: ['258'] });
const [phone = '846000000', message = 'Olá da MozeSMS!'] = process.argv.slice(2);

try {
  console.log('Saldo:', (await moze.account.balance()).balance, 'MZN');
  const sms = await moze.sms.send(phone, message, 'MozeSMS');
  console.log(`Enviado: ${sms.id} (${sms.status}), custo ${sms.cost}`);
  console.log('Estado:', (await moze.sms.status(sms.id)).status);
} catch (e) {
  if (e instanceof InvalidRequestError) console.error('Dados inválidos (nada enviado nem cobrado):', e.message);
  else if (e instanceof InsufficientBalanceError) console.error('Sem saldo.');
  else console.error(`${e.name}: ${e.message}`);
  process.exitCode = 1;
}
