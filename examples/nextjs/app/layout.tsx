// app/layout.tsx — o Provider só precisa do caminho da sua rota. Sem credenciais.
import { MozeSMSProvider } from '@woomoza/mozesms/react';
import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt">
      <body>
        <MozeSMSProvider endpoint="/api/mozesms">{children}</MozeSMSProvider>
      </body>
    </html>
  );
}
