import type { SpeechEvent } from '../../lib/speech/contracts.ts';
export interface SpeechSession {
  audio(data: Buffer): void;
  finish(): void;
  close(): void;
}
export interface SpeechProvider {
  id: string;
  name: string;
  configured: boolean;
  realtime: boolean;
  connect(emit: (event: SpeechEvent) => void): SpeechSession;
}
