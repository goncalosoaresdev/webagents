import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { MuseSpeechProvider } from './muse.ts';
import { SpeechService } from './service.ts';
import type { SpeechEvent } from '../../lib/speech/contracts.ts';

void test('speech preferences persist and support multiple registered providers without leaking keys', (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'speech-settings-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const muse = new MuseSpeechProvider('secret-key');
  const other = {
    id: 'other',
    name: 'Other',
    configured: true,
    realtime: true,
    connect: muse.connect.bind(muse),
  };
  const path = join(dir, 'settings.json');
  const service = new SpeechService([muse, other], path);
  assert.throws(() => service.active(), /Enable/);
  service.update({ enabled: ['muse', 'other'], activeProvider: 'other' });
  assert.equal(service.active().id, 'other');
  assert.equal(new SpeechService([muse, other], path).active().id, 'other');
  assert.ok(!JSON.stringify(service.read()).includes('secret-key'));
  assert.throws(() =>
    service.update({ enabled: ['muse'], activeProvider: 'other' }),
  );
  assert.throws(() =>
    service.update({ enabled: ['unknown'], activeProvider: 'unknown' }),
  );
  const ticket = service.tickets.issue();
  assert.equal(service.tickets.consume(ticket.token), true);
  assert.equal(service.tickets.consume(ticket.token), false);
});

void test(
  'Muse streams cumulative partials, sends PCM, and drains the final transcript on Stop',
  { timeout: 5000 },
  async (context) => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    context.after(() => {
      for (const socket of server.clients) socket.terminate();
      server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    let audio = 0;
    server.on('connection', (socket) =>
      socket.on('message', (raw, binary) => {
        if (binary) {
          audio += Buffer.isBuffer(raw)
            ? raw.length
            : raw instanceof ArrayBuffer
              ? raw.byteLength
              : Buffer.concat(raw).length;
          return;
        }
        const event = JSON.parse(
          (Buffer.isBuffer(raw)
            ? raw
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw)
              : Buffer.concat(raw)
          ).toString('utf8'),
        );
        if (event.type === 'endStream')
          socket.send(
            JSON.stringify({
              type: 'transcript',
              transcript: 'Hello world.',
              final: true,
            }),
          );
        else {
          assert.equal(event.authorization.accessToken, 'key');
          assert.equal(event.audioEncoding, 'PCM_24KHZ');
          assert.equal(event.mode, 'PUSH_TO_TALK');
          socket.send(JSON.stringify({ sessionId: 'session' }));
          socket.send(
            JSON.stringify({
              type: 'transcript',
              transcript: 'Hello',
              final: false,
            }),
          );
          socket.send(
            JSON.stringify({
              type: 'transcript',
              transcript: 'Hello world',
              final: false,
            }),
          );
        }
      }),
    );
    const provider = new MuseSpeechProvider(
      'key',
      `ws://127.0.0.1:${address.port}`,
    );
    const events: SpeechEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      const session = provider.connect((event) => {
        events.push(event);
        if (event.type === 'ready') session.audio(Buffer.alloc(3840));
        if (event.type === 'transcript' && event.text === 'Hello world')
          session.finish();
        if (event.type === 'done') resolve();
        if (event.type === 'error') reject(new Error(event.message));
      });
      context.after(() => session.close());
    });
    assert.equal(audio, 3840);
    assert.deepEqual(
      events.filter((e) => e.type === 'transcript').map((e) => e.text),
      ['Hello', 'Hello world', 'Hello world.'],
    );
  },
);

void test(
  'Muse surfaces abnormal closure without exposing upstream secrets',
  { timeout: 5000 },
  async (context) => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    context.after(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    server.on('connection', (socket) =>
      socket.on('message', () => socket.close(1008, 'secret-key')),
    );
    const event = await new Promise<SpeechEvent>((resolve) => {
      new MuseSpeechProvider(
        'secret-key',
        `ws://127.0.0.1:${address.port}`,
      ).connect(resolve);
    });
    assert.equal(event.type, 'error');
    assert.ok(!JSON.stringify(event).includes('secret-key'));
  },
);

void test('speech routes reject missing origins, reused tickets and unavailable providers', async (context) => {
  const { default: Fastify } = await import('fastify');
  const { default: websocket } = await import('@fastify/websocket');
  const { speechApi, speechSocket } = await import('./routes.ts');
  const app = Fastify();
  await app.register(websocket);
  const service = new SpeechService([new MuseSpeechProvider()]);
  speechApi(app, service);
  speechSocket(app, service, {
    allowedOrigins: new Set(['https://example.com']),
  });
  context.after(() => app.close());
  assert.equal(
    (await app.inject({ method: 'POST', url: '/speech/ticket' })).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/speech/settings',
        payload: { enabled: ['bad'], activeProvider: 'bad' },
      })
    ).statusCode,
    400,
  );
  const ticket = service.tickets.issue();
  assert.equal(
    (await app.inject({ url: `/speech-ws?ticket=${ticket.token}` })).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        url: '/speech-ws?ticket=invalid',
        headers: { origin: 'https://example.com' },
      })
    ).statusCode,
    401,
  );
  assert.equal(service.tickets.consume(ticket.token), true);
  assert.equal(service.tickets.consume(ticket.token), false);
});

void test('microphone worklet emits little-endian PCM frames and flushes before Stop', async () => {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  type Capture = {
    port: { onmessage(event: { data: string }): void };
    process(inputs: Float32Array[][]): boolean;
  };
  let Processor!: new () => Capture;
  const frames: unknown[] = [];
  class AudioWorkletProcessor {
    port = {
      postMessage: (value: unknown) => frames.push(value),
      onmessage: (_event: unknown) => {},
    };
  }
  runInNewContext(
    readFileSync(
      new URL('../../public/speech-worklet.js', import.meta.url),
      'utf8',
    ),
    {
      AudioWorkletProcessor,
      registerProcessor: (_name: string, ctor: unknown) => {
        Processor = ctor as new () => Capture;
      },
    },
  );
  const worklet = new Processor();
  worklet.process([[new Float32Array([1, -1, 0])]]);
  assert.equal(frames.length, 0);
  worklet.port.onmessage({ data: 'stop' });
  const pcm = new DataView(frames[0] as ArrayBuffer);
  assert.equal(pcm.getInt16(0, true), 32767);
  assert.equal(pcm.getInt16(2, true), -32768);
  assert.equal(pcm.getInt16(4, true), 0);
  assert.equal(frames[1], 'stopped');
  assert.equal(worklet.process([]), false);
});
