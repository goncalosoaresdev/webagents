import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export function isValidBearerAuthorization(
  header: string | undefined,
  expectedToken: string,
): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

export function createBearerAuthHook(expectedToken: string) {
  return async function bearerAuth(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (
      isValidBearerAuthorization(request.headers.authorization, expectedToken)
    )
      return;
    reply.header('WWW-Authenticate', 'Bearer');
    await reply.code(401).send({
      error: {
        code: 'unauthorized',
        message: 'A valid bearer token is required.',
      },
    });
  };
}
