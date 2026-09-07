import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TerminalService } from './service.ts';
import type { ServerConfig } from '../config.ts';
const id = z.uuid();
const create = z.object({ projectId: id, id });
const message = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(16384) }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(20).max(300),
    rows: z.number().int().min(5).max(100),
  }),
  z.object({
    type: z.literal('ack'),
    bytes: z.number().int().min(1).max(8_000_000),
  }),
]);
export async function terminalApi(
  app: FastifyInstance,
  terminals: TerminalService,
) {
  app.get('/terminals', async (request, reply) => {
    const query = z.object({ projectId: id }).safeParse(request.query);
    if (!query.success)
      return reply
        .code(400)
        .send({ error: { message: 'A project is required.' } });
    return { data: terminals.list(query.data.projectId) };
  });
  app.post(
    '/terminals',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = create.safeParse(request.body);
      if (!body.success)
        return reply
          .code(400)
          .send({ error: { message: 'Invalid terminal request.' } });
      return { data: terminals.create(body.data.projectId, body.data.id) };
    },
  );
  app.post<{ Params: { id: string } }>(
    '/terminals/:id/ticket',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => ({ data: terminals.ticket(request.params.id) }),
  );
  app.delete<{ Params: { id: string } }>('/terminals/:id', async (request) => {
    terminals.end(request.params.id);
    return { data: { ended: true } };
  });
}
export function terminalSocket(
  app: FastifyInstance,
  terminals: TerminalService,
  config: ServerConfig,
) {
  app.get<{ Querystring: { id: string; ticket: string } }>(
    '/terminal-ws',
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const query = z
          .object({ id, ticket: z.string().min(32).max(128) })
          .safeParse(request.query);
        if (
          !request.headers.origin ||
          !config.allowedOrigins.has(request.headers.origin) ||
          !query.success ||
          !terminals.consumeTicket(query.data.ticket, query.data.id)
        )
          return reply.code(401).send({
            error: { message: 'Terminal connection not authorized.' },
          });
      },
    },
    (socket, request) => {
      let detach = () => {};
      let replayAllowance = 0;
      let pending = 0,
        ready = false,
        inputBytes = 0;
      let alive = true;
      socket.on('pong', () => {
        alive = true;
      });
      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, 30000);
      heartbeat.unref();
      const reset = setInterval(() => {
        inputBytes = 0;
      }, 1000);
      reset.unref();
      try {
        detach = terminals.attach(request.query.id, (event) => {
          if (socket.readyState !== 1) return;
          if (
            pending > replayAllowance + 512000 ||
            socket.bufferedAmount > replayAllowance + 512000
          ) {
            socket.close(1013, 'Reconnect to restore terminal');
            return;
          }
          if (event.type === 'snapshot') replayAllowance = event.data.length;
          if (event.type === 'snapshot' || event.type === 'output')
            pending += event.data.length;
          socket.send(JSON.stringify(event));
          if (event.type === 'snapshot') ready = true;
        });
      } catch {
        socket.close(1008, 'Terminal unavailable');
      }
      socket.on('message', (raw) => {
        try {
          const text = Array.isArray(raw)
            ? Buffer.concat(raw).toString('utf8')
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw).toString('utf8')
              : raw.toString('utf8');
          const parsed = message.safeParse(JSON.parse(text));
          if (!parsed.success) {
            socket.close(1008, 'Invalid terminal message');
            return;
          }
          const data = parsed.data;
          if (data.type === 'ack') {
            pending = Math.max(0, pending - data.bytes);
            replayAllowance = Math.max(0, replayAllowance - data.bytes);
            return;
          }
          if (!ready) return;
          inputBytes += text.length;
          if (inputBytes > 65536) {
            socket.close(1008, 'Input limit reached');
            return;
          }
          if (data.type === 'input')
            terminals.write(request.query.id, data.data);
          else terminals.resize(request.query.id, data.cols, data.rows);
        } catch {
          socket.close(1008, 'Terminal unavailable');
        }
      });
      socket.on('close', () => {
        clearInterval(reset);
        clearInterval(heartbeat);
        detach();
      });
      socket.on('error', () => {
        clearInterval(reset);
        clearInterval(heartbeat);
        detach();
      });
    },
  );
}
