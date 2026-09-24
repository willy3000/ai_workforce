/** SDK 0.1.0 ships no types. Declare only the pilot methods, with untrusted results. */
declare module '@kushbitx/sdk' {
  export class KushBitxClient {
    constructor(options: { baseUrl: string; fetchFn: typeof fetch });
    previewToken(address: string): Promise<unknown>;
    evaluateSpend(input: unknown): Promise<unknown>;
    getPaymentChallenge(service: 'token-risk', input: { chain: 'base'; address: string }): Promise<unknown>;
  }
}
