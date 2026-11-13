import { ConfigurationError } from './config';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function safeDiagnostic(error: unknown): Record<string, string> {
  if (error instanceof ConfigurationError) {
    return { category: 'configuration', field: error.field, message: error.message };
  }
  if (error instanceof ApiError) return { category: 'request', code: error.code };
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return {
    category: 'dependency',
    code: typeof code === 'string' && /^(?:[0-9A-Z]{5}|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|ECONNRESET)$/.test(code)
      ? code : 'INTERNAL_ERROR',
  };
}

export const loggerOptions = {
  redact: {
    paths: ['req.headers', 'req.body', 'res.headers', 'password', 'password_hash', 'token', 'token_hash',
      'csrf', 'csrf_hash', 'databaseUrl', 'connectionString'],
    censor: '[REDACTED]',
  },
  serializers: {
    err: (error: unknown) => ({
      type: 'Error', message: 'Redacted; see diagnostic fields', stack: '[REDACTED]', ...safeDiagnostic(error),
    }),
    req: (request: { id: string; method: string }) => ({ id: request.id, method: request.method }),
    res: (response: { statusCode: number }) => ({ statusCode: response.statusCode }),
  },
};
