/** Errors the editor can say in the user's language. Its own module: the browser demo replaces api.ts. */

/**
 * A failed request: the server's message in English, and a code with its
 * params that the editor says in the user's language (`errorText`).
 */
export class ApiError extends Error {
  readonly code: string | undefined;
  readonly params: Record<string, string | number>;
  constructor(message: string, code?: string, params: Record<string, string | number> = {}) {
    super(message);
    this.code = code;
    this.params = params;
  }
}
