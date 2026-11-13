import Fastify, { FastifyServerOptions } from 'fastify';
import { Pool } from 'pg';
import { transaction } from './database';
import { ApiError, loggerOptions, safeDiagnostic } from './errors';
import { Migration, assertSchemaReady } from './migrations';
import { AuthConfig, readAuthConfig, registerAuth } from './auth';
import { registerAccount } from './account';
import { registerBoards } from './boards';
import { registerHistory } from './history';
import { registerAttachments } from './attachments';
import { ObjectStorage } from './object-storage';
import { registerUploads } from './uploads';

export function buildApp(pool: Pool, migrations: readonly Migration[], options: FastifyServerOptions = {}, authConfig: AuthConfig = readAuthConfig(), storage?: ObjectStorage) {
  const app = Fastify({ logger: loggerOptions, bodyLimit: 2 * 1024 * 1024, ...options });
  const auth = registerAuth(app, pool, authConfig);
  registerAccount(app, pool, auth);
  registerBoards(app, pool, auth, storage);
  registerHistory(app, pool, auth, storage);
  if (storage) {
    registerAttachments(app, pool, auth, storage);
    registerUploads(app, pool, auth, storage);
  }
  const onPoolError = (error: Error) => app.log.error({ diagnostic: safeDiagnostic(error) }, 'database_pool_error');
  pool.on('error', onPoolError);
  app.addHook('onClose', async () => { pool.off('error', onPoolError); });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    return payload;
  });
  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof ApiError;
    const rawStatus = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const status = known ? error.status
      : typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus < 500 ? rawStatus : 500;
    request.log.error({ diagnostic: safeDiagnostic(error) }, 'request_failed');
    return reply.code(status).send({
      error: {
        code: known ? error.code : status < 500 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR',
        message: known ? error.message : status < 500 ? 'The request is invalid.' : 'The request could not be completed.',
        requestId: request.id,
      },
    });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({
    error: { code: 'NOT_FOUND', message: 'The requested resource was not found.', requestId: _request.id },
  }));
  app.get('/api/health/live', async () => ({ status: 'ok' }));
  app.get('/api/health/ready', async (request, reply) => {
    try {
      await transaction(pool, (client) => assertSchemaReady(client, migrations));
      if (storage) await storage.ready();
      return { status: 'ready' };
    } catch (error) {
      request.log.error({ diagnostic: safeDiagnostic(error) }, 'readiness_failed');
      return reply.code(503).send({
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'A required dependency is unavailable or the database schema is not current.',
          requestId: request.id,
        },
      });
    }
  });
  return app;
}
