# Speech to text

The composer microphone streams live dictation to the selected speech provider. Partial text appears above the microphone. Stop flushes the final audio, waits for the final transcript, and appends it to the current draft. Send remains explicit. Cancel discards the recording; connection errors retain partial text with a button to use it. Changing tasks or starting a task releases the microphone.

## Setup

Set `MODEL_API_KEY` (or `META_API_KEY`) in the backend environment and restart. Muse Code login alone does not configure the transcription API. In Settings → Speech to text, enable Muse Voice Transcribe and select it as the dictation provider. The browser needs HTTPS or localhost and microphone permission. Webcode does not retain recordings. Audio is relayed to Meta, with credentials confined to the backend.

Preferences are stored in `speech-settings.json` in `WEBCODE_DATA_DIR`. They apply across this Webcode installation. Configure your reverse proxy to forward WebSocket upgrades for `/speech-ws`, alongside `/ws` and `/terminal-ws`. Vite development and preview proxy it automatically.

## Adding a provider

Implement `SpeechProvider` in `server/speech/provider.ts` and register an instance in the `SpeechService` constructor in `server/index.ts`. Settings lists registered providers automatically. Adapters receive mono, little-endian PCM16 at 24 kHz and implement `audio`, `finish`, and `close`. They emit normalized `ready`, cumulative `transcript`, `done`, and `error` events. `finish` must drain the final transcript before `done`; `close` must release all resources. Provider credentials must never be included in public settings or errors.

Muse uses `muse-voice-transcribe-1.0`, `PUSH_TO_TALK`, and `CUMULATIVE` partials over `wss://api.meta.ai/v1/asr/realtime`. Push-to-talk still streams text while speaking; the user controls Stop. Audio is captured in an AudioWorklet in 80 ms frames. Bounded connection, audio-ingress, upload-buffer, finalization and ten-minute recording limits surface errors rather than silently waiting. There is no automatic audio replay.

Protocol reference: https://github.com/meta-models/meta-model-cookbook/tree/main/06_muse_voice/01_voice_api_fundamentals

## Verification

Automated tests cover saved provider selection, switching to another registered provider, missing configuration, invalid origins/tickets, PCM conversion and flushing, cumulative streaming, finalization and disconnect errors. Browser and live microphone testing are left to the user. A configured Meta API key is required for a live provider test.
