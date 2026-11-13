import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { isLanguagePreference, isThemePreference } from '../../shared/preferences';
import { Authentication } from './auth';
import { transaction } from './database';
import { ApiError } from './errors';
import { activeAccount, objectBody, revision } from './guards';

export function registerAccount(app: FastifyInstance, pool: Pool, auth: Authentication): void {
  app.get('/api/account/configuration', async (request) => {
    const { account } = await auth.requireSession(request);
    return { configuration: account.configuration, revision: account.configuration_revision };
  });
  app.patch('/api/account/configuration', async (request) => {
    const session = await auth.requireSession(request, true);
    const body = objectBody(request.body);
    if (Object.keys(body).some((key) => !['expectedRevision', 'changes'].includes(key))) {
      throw new ApiError(400, 'INVALID_CONFIGURATION', 'Only configuration changes are allowed.');
    }
    const expectedRevision = revision(body['expectedRevision']);
    const changes = objectBody(body['changes']);
    if (Object.keys(changes).some((key) => !['theme', 'language'].includes(key)) ||
      ('theme' in changes && !isThemePreference(changes['theme'])) ||
      ('language' in changes && !isLanguagePreference(changes['language']))) {
      throw new ApiError(400, 'INVALID_CONFIGURATION', 'Unsupported appearance or language preference.');
    }
    return transaction(pool, async (client) => {
      const account = await activeAccount(client, session.account.id, true);
      if (account.configuration_revision !== expectedRevision) {
        throw new ApiError(409, 'REVISION_CONFLICT', 'Configuration changed elsewhere; reload and retry your changes.');
      }
      const next = { ...account.configuration, ...changes };
      if (Object.entries(changes).every(([key, value]) => account.configuration[key] === value)) {
        return { configuration: account.configuration, revision: account.configuration_revision };
      }
      const result = await client.query<{ configuration_revision: string }>(`
        UPDATE users SET configuration=$2::jsonb, configuration_revision=configuration_revision+1, updated_at=now()
        WHERE id=$1 RETURNING configuration_revision`, [account.id, JSON.stringify(next)]);
      return { configuration: next, revision: result.rows[0]?.configuration_revision };
    });
  });
}
