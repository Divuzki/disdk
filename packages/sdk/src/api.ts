import {
  DisdkError,
  type CompleteResponse,
  type ConnectResponse,
  type DisdkErrorBody,
  type SessionPublic,
  type SettlementCompleteResponse,
  type SettlementConnectResponse,
} from '@disdk/protocol';

/** Thin client over the disdk server. All state lives server-side. */
export class DisdkApi {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
  }

  getSession(sessionId: string): Promise<SessionPublic> {
    return this.#request('GET', `/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  connect(sessionId: string, publicKey: string): Promise<ConnectResponse> {
    return this.#request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/connect`, {
      publicKey,
    });
  }

  submit(sessionId: string, signedTransaction: string): Promise<CompleteResponse> {
    return this.#request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/submit`, {
      signedTransaction,
    });
  }

  confirm(sessionId: string, signature: string): Promise<CompleteResponse> {
    return this.#request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/confirm`, {
      signature,
    });
  }

  connectSettlement(sessionId: string, publicKey: string): Promise<SettlementConnectResponse> {
    return this.#request(
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/settlement/connect`,
      { publicKey },
    );
  }

  submitSettlement(
    sessionId: string,
    signedTransaction: string,
  ): Promise<SettlementCompleteResponse> {
    return this.#request(
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/settlement/submit`,
      { signedTransaction },
    );
  }

  confirmSettlement(sessionId: string, signature: string): Promise<SettlementCompleteResponse> {
    return this.#request(
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/settlement/confirm`,
      { signature },
    );
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'omit',
      });
    } catch (error) {
      throw new DisdkError(
        'NETWORK_ERROR',
        `Could not reach the server: ${error instanceof Error ? error.message : 'unknown error'}`,
        true,
      );
    }

    if (!response.ok) {
      throw await toError(response);
    }

    return (await response.json()) as T;
  }
}

async function toError(response: Response): Promise<DisdkError> {
  let body: Partial<DisdkErrorBody> = {};
  try {
    body = (await response.json()) as Partial<DisdkErrorBody>;
  } catch {
    // Non-JSON error page (a proxy, most likely); fall through to the default.
  }

  if (body.error && body.message) {
    return new DisdkError(body.error, body.message, body.retryable ?? false);
  }
  return new DisdkError(
    'NETWORK_ERROR',
    `Server responded with ${response.status}.`,
    response.status >= 500,
  );
}
