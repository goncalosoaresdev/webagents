import WebSocket from 'ws';
import type { SpeechProvider, SpeechSession } from './provider.ts';
import type { SpeechEvent } from '../../lib/speech/contracts.ts';

export class MuseSpeechProvider implements SpeechProvider {
  id = 'muse';
  name = 'Muse Voice Transcribe';
  realtime = true;
  get configured() {
    return Boolean(this.key);
  }
  constructor(
    private readonly key?: string,
    private readonly url = 'wss://api.meta.ai/v1/asr/realtime',
  ) {}
  connect(emit: (event: SpeechEvent) => void): SpeechSession {
    if (!this.key)
      throw new Error('Muse voice requires MODEL_API_KEY on the server.');
    const ws = new WebSocket(this.url, {
      maxPayload: 256 * 1024,
      handshakeTimeout: 10_000,
    });
    let ready = false,
      ended = false,
      closed = false;
    let timer = setTimeout(
      () => fail('Muse voice connection timed out.'),
      10_000,
    );
    const close = () => {
      closed = true;
      clearTimeout(timer);
      ws.terminate();
    };
    const fail = (message: string) => {
      if (!closed) emit({ type: 'error', message });
      close();
    };
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          authorization: { accessToken: this.key },
          model: 'muse-voice-transcribe-1.0',
          mode: 'PUSH_TO_TALK',
          audioEncoding: 'PCM_24KHZ',
          partialMode: 'CUMULATIVE',
          emitAudioProgress: false,
        }),
      ),
    );
    ws.on('message', (raw) => {
      if (closed) return;
      try {
        const event = JSON.parse(
          (Buffer.isBuffer(raw)
            ? raw
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw)
              : Buffer.concat(raw)
          ).toString('utf8'),
        );
        if (typeof event.sessionId === 'string' && !ready) {
          ready = true;
          clearTimeout(timer);
          emit({ type: 'ready' });
        } else if (
          event.type === 'transcript' &&
          typeof event.transcript === 'string'
        ) {
          emit({
            type: 'transcript',
            text: event.transcript,
            final: event.final === true,
          });
          if (ended && event.final === true) {
            emit({ type: 'done' });
            close();
          }
        } else if (event.type === 'error') {
          fail(
            'Muse voice rejected the request. Check your API key, model access, and usage limits.',
          );
        }
      } catch {
        fail('Muse voice sent an invalid response.');
      }
    });
    ws.on('error', () =>
      fail(
        'Unable to connect to Muse voice. Check your connection and API access.',
      ),
    );
    ws.on('close', () => {
      if (!closed)
        fail(
          'Muse voice disconnected before the final transcript. Your draft is preserved.',
        );
    });
    return {
      audio(data) {
        if (!ready || ended || closed)
          throw new Error('Speech session is not recording.');
        if (ws.bufferedAmount > 240_000) {
          fail('Audio upload fell behind. Please retry.');
          return;
        }
        ws.send(data);
      },
      finish() {
        if (closed || ended) return;
        ended = true;
        timer = setTimeout(
          () => fail('Muse voice did not finish transcription in time.'),
          15_000,
        );
        ws.send(JSON.stringify({ type: 'endStream' }));
      },
      close,
    };
  }
}
