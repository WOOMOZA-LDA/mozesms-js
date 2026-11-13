// Servidor Node sem framework (serve igual com Express: app.post('/api/mozesms', toNodeHandler(handler))).
//   MOZESMS_KEY=mk_... MOZESMS_SECRET=sk_... npx tsx examples/node/server.ts
import { createServer } from 'node:http';
import { MozeSMS } from '@woomoza/mozesms';
import { createHandler, toNodeHandler } from '@woomoza/mozesms/server';

const handler = createHandler({
  client: new MozeSMS({ apiKey: process.env.MOZESMS_KEY!, apiSecret: process.env.MOZESMS_SECRET! }),
  otp: { sender_id: process.env.MOZESMS_SENDER_ID ?? 'MozeSMS' },
  // Se estiver atrás de um proxy seu, diga como obter o IP real (para o limite por IP):
  getClientIp: (request) => request.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
  allowedOrigins: ['http://localhost:5173'], // o seu frontend (Vite)
});

const api = toNodeHandler(handler);

createServer((req, res) => {
  if (req.url === '/api/mozesms') {
    // CORS só se o frontend estiver noutra origem (ex.: Vite em :5173)
    res.setHeader('access-control-allow-origin', 'http://localhost:5173');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return void res.end();
    }
    return void api(req as never, res as never);
  }
  res.statusCode = 404;
  res.end();
}).listen(3000, () => console.log('MozeSMS handler em http://localhost:3000/api/mozesms'));
