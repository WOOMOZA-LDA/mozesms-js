import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { createBrowserClient, type BrowserClient, type BrowserClientOptions } from './browser';

const Ctx = createContext<BrowserClient | null>(null);

export interface MozeSMSProviderProps extends BrowserClientOptions {
  children?: ReactNode;
}

/**
 * Indique uma vez o endpoint do seu backend; os hooks usam-no. Não leva credenciais da MozeSMS.
 *
 *     <MozeSMSProvider endpoint="/api/mozesms"> ... </MozeSMSProvider>
 */
export function MozeSMSProvider({ children, endpoint, headers, credentials, fetch: fetchImpl, timeout }: MozeSMSProviderProps) {
  // `headers` costuma ser um objeto novo a cada render: lê-se sempre o valor mais recente por ref, sem recriar o cliente.
  const headersRef = useRef(headers);
  headersRef.current = headers;
  const client = useMemo(
    () =>
      createBrowserClient({
        endpoint,
        credentials,
        fetch: fetchImpl,
        timeout,
        headers: async () => {
          const h = headersRef.current;
          return typeof h === 'function' ? await h() : h ?? {};
        },
      }),
    [endpoint, credentials, fetchImpl, timeout],
  );
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>;
}

/** O cliente do browser (call). Lança se faltar o MozeSMSProvider. */
export function useMozeSMS(): BrowserClient {
  const c = useContext(Ctx);
  if (!c) throw new Error('useMozeSMS: envolva a sua app em <MozeSMSProvider endpoint="/api/mozesms">.');
  return c;
}
