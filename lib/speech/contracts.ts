export interface SpeechPreferences {
  enabled: string[];
  activeProvider: string | null;
}
export interface SpeechSettings extends SpeechPreferences {
  providers: {
    id: string;
    name: string;
    configured: boolean;
    realtime: boolean;
  }[];
}
export type SpeechEvent =
  | { type: 'ready' }
  | { type: 'transcript'; text: string; final: boolean }
  | { type: 'done' }
  | { type: 'error'; message: string };
