'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Square, X } from 'lucide-react';
import type { WebcodeApi } from '@/lib/api/client';
import type { SpeechEvent } from '@/lib/speech/contracts';
import {
  bindingMatches,
  isEditableTarget,
  loadPushToTalk,
} from '@/lib/speech/push-to-talk';

function DictationWaveform({
  getAnalyser,
}: {
  getAnalyser: () => AnalyserNode | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0;
    const slots = 96;
    const history = Array.from({ length: slots }, () => 0);
    const shown = Array.from({ length: slots }, () => 0);
    let data: Float32Array<ArrayBuffer> | null = null;
    let level = 0;
    const calm =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height) return;
      if (
        canvas.width !== Math.round(width * dpr) ||
        canvas.height !== Math.round(height * dpr)
      ) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (!calm) {
        const analyser = getAnalyser();
        if (analyser) {
          if (!data || data.length !== analyser.fftSize)
            data = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
          const instant = Math.min(1, Math.sqrt(sum / data.length) * 5);
          level += (instant - level) * (instant > level ? 0.6 : 0.15);
        } else {
          level *= 0.9;
        }
      }
      history.push(level);
      history.shift();
      const mid = height / 2;
      const step = width / slots;
      const barWidth = Math.min(3, step * 0.45);
      for (let i = 0; i < slots; i++) {
        shown[i] += (history[i] - shown[i]) * 0.4;
        const v = Math.max(0, Math.min(1, shown[i]));
        const x = i * step + step / 2;
        if (v < 0.06) {
          ctx.fillStyle = 'rgba(255,255,255,0.28)';
          ctx.beginPath();
          ctx.arc(x, mid, 1.4, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const barHeight = Math.max(4, v * (height - 6));
          const y = mid - barHeight / 2;
          ctx.fillStyle = '#ededf0';
          if (typeof ctx.roundRect === 'function') {
            ctx.beginPath();
            ctx.roundRect(
              x - barWidth / 2,
              y,
              barWidth,
              barHeight,
              Math.min(barWidth / 2, 2),
            );
            ctx.fill();
          } else {
            ctx.fillRect(x - barWidth / 2, y, barWidth, barHeight);
          }
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [getAnalyser]);
  return <canvas ref={canvasRef} className="dictation-waveform" aria-hidden="true" />;
}

export function SpeechInput({
  api,
  disabled,
  onInsert,
  onLiveTranscript,
  onActiveChange,
}: {
  api: WebcodeApi;
  disabled: boolean;
  onInsert: (text: string) => void;
  onLiveTranscript?: (next: string, prev: string) => void;
  onActiveChange?: (active: boolean) => void;
}) {
  const [state, setState] = useState<
    'idle' | 'connecting' | 'recording' | 'finishing'
  >('idle');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(0);
  const generation = useRef(0);
  const dispose = useRef<() => void>(() => {});
  const finish = useRef<() => void>(() => {});
  const latest = useRef(onInsert);
  const liveLatest = useRef(onLiveTranscript);
  const activeLatest = useRef(onActiveChange);
  const liveSent = useRef('');
  const analyserRef = useRef<AnalyserNode | null>(null);
  const getAnalyser = useCallback(() => analyserRef.current, []);
  useEffect(() => {
    latest.current = onInsert;
    liveLatest.current = onLiveTranscript;
    activeLatest.current = onActiveChange;
  }, [onInsert, onLiveTranscript, onActiveChange]);
  useEffect(() => {
    activeLatest.current?.(state !== 'idle');
  }, [state]);
  const stateRef = useRef(state);
  const disabledRef = useRef(disabled);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);
  const [ptt, setPtt] = useState(loadPushToTalk);
  useEffect(() => {
    const sync = () => setPtt(loadPushToTalk());
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  useEffect(
    () => () => {
      generation.current++;
      dispose.current();
    },
    [],
  );
  useEffect(() => {
    if (state !== 'recording') return;
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [state]);
  const start = async (): Promise<void> => {
    const id = ++generation.current;
    dispose.current();
    setError('');
    setText('');
    setSeconds(0);
    liveSent.current = '';
    analyserRef.current = null;
    setState('connecting');
    let stream: MediaStream | undefined,
      context: AudioContext | undefined,
      socket: WebSocket | undefined;
    let node: AudioWorkletNode | undefined;
    let transcript = '',
      completed = false;
    const current = () => id === generation.current;
    let timeout: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timeout);
      stream?.getTracks().forEach((t) => t.stop());
      node?.disconnect();
      analyserRef.current = null;
      void context?.close().catch(() => {});
      socket?.close();
    };
    dispose.current = cleanup;
    const fail = (message: string) => {
      if (!current()) return;
      generation.current++;
      cleanup();
      const streamed = liveSent.current;
      liveSent.current = '';
      setError(
        streamed
          ? message.replace(' below', ' in the prompt')
          : message,
      );
      setState('idle');
    };
    timeout = setTimeout(
      () => fail('Microphone or speech connection timed out. Please retry.'),
      20_000,
    );
    try {
      const settings = await api.speechSettings();
      if (!current()) return;
      const provider = settings.providers.find(
        (p) =>
          p.id === settings.activeProvider && settings.enabled.includes(p.id),
      );
      if (!provider)
        throw new Error('Select an enabled speech provider in Settings first.');
      if (!provider.configured)
        throw new Error(
          'The server has not loaded the speech API key. Set MODEL_API_KEY in .env and restart the backend.',
        );
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error(
          'Microphone recording requires HTTPS and a supported browser.',
        );
      // The mic, the audio pipeline, and the ticket are independent: start
      // them together so a keypress reaches recording faster.
      const mic = navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      const audio = (async () => {
        const ctx = new AudioContext({ sampleRate: 24000 });
        await ctx.resume();
        await ctx.audioWorklet.addModule('/speech-worklet.js');
        if (ctx.sampleRate !== 24000)
          throw new Error(
            'This browser cannot record at the required audio sample rate.',
          );
        return ctx;
      })();
      const ticketRequest = api.speechTicket();
      const [micResult, audioResult, ticketResult] = await Promise.allSettled([
        mic,
        audio,
        ticketRequest,
      ]);
      if (micResult.status === 'fulfilled') stream = micResult.value;
      if (audioResult.status === 'fulfilled') context = audioResult.value;
      if (
        micResult.status !== 'fulfilled' ||
        audioResult.status !== 'fulfilled' ||
        ticketResult.status !== 'fulfilled'
      ) {
        cleanup();
        const firstRejection = [micResult, audioResult, ticketResult].find(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        );
        throw (
          firstRejection?.reason ?? new Error('Unable to start recording.')
        );
      }
      const ticket = ticketResult.value;
      if (!current()) {
        cleanup();
        return;
      }
      const url = new URL(api.baseUrl, location.href);
      url.pathname = '/speech-ws';
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.search = '';
      url.searchParams.set('ticket', ticket.token);
      socket = new WebSocket(url);
      socket.onmessage = ({ data }) => {
        if (!current()) return;
        try {
          const event = JSON.parse(data) as SpeechEvent;
          if (event.type === 'ready') {
            clearTimeout(timeout);
            setState('recording');
            node = new AudioWorkletNode(context!, 'speech-capture');
            node.port.onmessage = ({ data: frame }) => {
              if (!current() || socket?.readyState !== WebSocket.OPEN) return;
              if (frame === 'stopped') {
                stream?.getTracks().forEach((t) => t.stop());
                socket.send(JSON.stringify({ type: 'stop' }));
                return;
              }
              if (socket.bufferedAmount > 240_000) {
                fail(
                  'Audio upload is too slow. Your transcript is preserved below.',
                );
                return;
              }
              socket.send(frame);
            };
            const source = context!.createMediaStreamSource(stream!);
            const analyser = context!.createAnalyser();
            analyser.fftSize = 2048;
            source.connect(analyser);
            analyserRef.current = analyser;
            source.connect(node);
            const mute = context!.createGain();
            mute.gain.value = 0;
            node.connect(mute).connect(context!.destination);
            finish.current = () => {
              setState('finishing');
              node!.port.postMessage('stop');
              timeout = setTimeout(
                () =>
                  fail(
                    'Transcription did not finish in time. You can use the partial text below.',
                  ),
                20_000,
              );
            };
          } else if (event.type === 'transcript') {
            transcript = event.text;
            const live = liveLatest.current;
            if (live) {
              const next = transcript.trim();
              const prev = liveSent.current;
              if (next !== prev) {
                liveSent.current = next;
                live(next, prev);
              }
            } else {
              setText(transcript);
            }
          } else if (event.type === 'error') fail(event.message);
          else if (event.type === 'done') {
            completed = true;
            const live = liveLatest.current;
            if (live) {
              const finalText = transcript.trim();
              if (finalText && finalText !== liveSent.current) {
                const prev = liveSent.current;
                liveSent.current = finalText;
                live(finalText, prev);
              } else if (!finalText && !liveSent.current) {
                setError('No speech was detected. Please try again.');
              }
              liveSent.current = '';
            } else {
              if (transcript.trim()) latest.current(transcript.trim());
              else setError('No speech was detected. Please try again.');
            }
            generation.current++;
            cleanup();
            setText('');
            setState('idle');
          }
        } catch {
          fail('The speech service sent an invalid response.');
        }
      };
      socket.onerror = () =>
        fail('Speech connection failed. Check Settings and your connection.');
      socket.onclose = () => {
        if (!completed)
          fail('Speech connection closed. You can use the partial text below.');
      };
    } catch (cause) {
      fail(
        cause instanceof Error ? cause.message : 'Unable to start recording.',
      );
    }
  };
  const cancel = () => {
    const sent = liveSent.current;
    liveSent.current = '';
    if (sent) liveLatest.current?.('', sent);
    generation.current++;
    dispose.current();
    setState('idle');
    setText('');
    setError('');
  };
  const startRef = useRef(start);
  useEffect(() => {
    startRef.current = start;
  });
  useEffect(() => {
    if (!ptt.enabled || !ptt.binding) return;
    const binding = ptt.binding;
    const mode = ptt.mode;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || !bindingMatches(binding, event)) return;
      if (disabledRef.current) return;
      if (
        !binding.ctrl &&
        !binding.alt &&
        !binding.meta &&
        isEditableTarget(event.target)
      )
        return;
      event.preventDefault();
      if (mode === 'toggle') {
        if (stateRef.current === 'idle') void startRef.current();
        else if (stateRef.current === 'recording') finish.current();
      } else if (stateRef.current === 'idle') {
        void startRef.current();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (mode !== 'hold' || event.code !== binding.code) return;
      if (stateRef.current === 'recording') finish.current();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [ptt]);
  return (
    <div className={state === 'idle' ? 'speech-input' : 'speech-input is-active'}>
      {state === 'idle' ? (
        <button
          type="button"
          className="settings-refresh"
          aria-label="Dictate message"
          title="Dictate message (configure in Settings)"
          disabled={disabled}
          onClick={() => void start()}
        >
          <Mic size={17} />
        </button>
      ) : (
        <>
          {state === 'connecting' ? (
            <output className="dictation-hint">Connecting microphone…</output>
          ) : (
            <DictationWaveform getAnalyser={getAnalyser} />
          )}
          {state === 'recording' && (
            <button
              type="button"
              className="dictation-stop"
              aria-label={`Stop recording (${seconds}s)`}
              title="Stop recording"
              onClick={() => finish.current()}
            >
              <Square size={13} fill="currentColor" />
            </button>
          )}
          {state === 'finishing' && (
            <output className="dictation-hint">Finishing…</output>
          )}
          <button
            type="button"
            className="dictation-cancel"
            aria-label="Cancel recording"
            title="Cancel recording"
            onClick={cancel}
          >
            <X size={16} />
          </button>
        </>
      )}
      {(text || error) && (
        <div className="speech-preview">
          {text && <p aria-live="polite">{text}</p>}
          {error && <p role="alert">{error}</p>}
          {state === 'idle' && text && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                latest.current(text);
                setText('');
                setError('');
              }}
            >
              Use partial transcript
            </button>
          )}
        </div>
      )}
    </div>
  );
}
