import type { HttpClient, Json } from '../http';

/**
 * Convenção do SDK: operações sobre um item (get/create/update...) devolvem o conteúdo de `data`;
 * listagens devolvem o corpo completo (`data` + `pagination`/`total`...), para não perder a paginação.
 */
export abstract class Resource {
  constructor(protected readonly http: HttpClient) {}

  protected get v() {
    return this.http.validator;
  }

  protected async item(method: string, path: string, init: { query?: Json; json?: Json } = {}): Promise<Json> {
    const r = await this.http.request(method, path, init);
    return r.data !== null && typeof r.data === 'object' && !Array.isArray(r.data) ? (r.data as Json) : r;
  }

  protected body(method: string, path: string, init: { query?: Json; json?: Json } = {}): Promise<Json> {
    return this.http.request(method, path, init);
  }

  protected enc(value: string | number): string {
    return encodeURIComponent(String(value));
  }
}
