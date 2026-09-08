import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.ts';
import type { SpeechSession } from './provider.ts';
import { SpeechService, speechPreferences } from './service.ts';
export function speechApi(app: FastifyInstance, service: SpeechService) {
  app.get('/speech/settings', async () => ({ data: service.read() }));
  app.post('/speech/settings', async (request, reply) => {
    const parsed = speechPreferences.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: { message: 'Invalid speech settings.' } });
    try {
      return { data: service.update(parsed.data) };
    } catch {
      return reply
        .code(400)
        .send({
          error: {
            message:
              'Unable to save speech settings. Select an enabled provider.',
          },
        });
    }
  });
  app.post(
    '/speech/ticket',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      try {
        service.active();
        return { data: service.tickets.issue() };
      } catch {
        return reply
          .code(409)
          .send({
            error: {
              message: 'Enable a configured speech provider in Settings first.',
            },
          });
      }
    },
  );
}
export function speechSocket(
  app: FastifyInstance,
  service: SpeechService,
  config: Pick<ServerConfig, 'allowedOrigins'>,
) {
  const sessions = new Set<() => void>();
  app.addHook('onClose', async () => {
    for (const close of sessions) close();
  });
  app.get<{ Querystring: { ticket?: string } }>(
    '/speech-ws',
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (
          !request.headers.origin ||
          !config.allowedOrigins.has(request.headers.origin) ||
          !service.tickets.consume(request.query.ticket ?? '')
        )
          return reply
            .code(401)
            .send({ error: { message: 'Speech connection not authorized.' } });
        if (sessions.size >= 4)
          return reply
            .code(429)
            .send({ error: { message: 'Too many speech sessions.' } });
      },
    },
    (socket) => {
      let session: SpeechSession | undefined;
      let stopped = false;
      let ready = false;
      let bytes = 0;
      const started = Date.now();
      const send = (event: object) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(event));
      };
      const cleanup = () => {
        clearTimeout(limit);
        clearTimeout(idle);
        session?.close();
        sessions.delete(close);
      };
      const close = () => {
        cleanup();
        socket.close();
      };
      const fail = (message: string) => {
        send({ type: 'error', message });
        close();
      };
      const limit = setTimeout(
        () =>
          fail(
            'Recording reached the 10-minute limit. Stop and start a new recording.',
          ),
        10 * 60_000,
      );
      let idle = setTimeout(
        () => fail('No microphone audio received.'),
        15_000,
      );
      sessions.add(close);
      socket.on('close', cleanup);
      socket.on('error', cleanup);
      socket.on('message', (raw, binary) => {
        try {
          if (binary) {
            const data = Buffer.isBuffer(raw)
              ? raw
              : Buffer.from(raw as ArrayBuffer);
            if (!ready || stopped || data.length > 24_000 || data.length % 2)
              throw new Error('Invalid audio frame.');
            bytes += data.length;
            if (bytes > ((Date.now() - started) / 1000 + 5) * 48_000)
              throw new Error('Audio arrived faster than real time.');
            clearTimeout(idle);
            idle = setTimeout(
              () => fail('Microphone audio stopped arriving. Please retry.'),
              10_000,
            );
            session!.audio(data);
          } else {
            const event = JSON.parse(
              (Buffer.isBuffer(raw)
                ? raw
                : raw instanceof ArrayBuffer
                  ? Buffer.from(raw)
                  : Buffer.concat(raw)
              ).toString('utf8'),
            );
            if (event.type === 'cancel') close();
            else if (event.type === 'stop' && ready && !stopped) {
              stopped = true;
              clearTimeout(idle);
              session!.finish();
            } else throw new Error('Invalid speech command.');
          }
        } catch {
          fail('Speech recording could not continue. Please retry.');
        }
      });
      try {
        session = service.active().connect((event) => {
          if (event.type === 'ready') ready = true;
          send(event);
          if (event.type === 'error' || event.type === 'done') close();
        });
      } catch {
        fail('Speech provider is unavailable. Check Settings.');
      }
    },
  );
}
