'use client';
import { useEffect, useRef, useState } from 'react';
import { AudioLines, ChevronDown } from 'lucide-react';
import type { WebcodeApi } from '@/lib/api/client';
import type {
  SpeechSettings as Settings,
  SpeechPreferences,
} from '@/lib/speech/contracts';
import {
  bindingFromEvent,
  bindingLabel,
  loadPushToTalk,
  savePushToTalk,
  type PushToTalkConfig,
} from '@/lib/speech/push-to-talk';
export function SpeechSettings({ api }: { api: WebcodeApi }) {
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ptt, setPtt] = useState<PushToTalkConfig>(loadPushToTalk);
  const [capturing, setCapturing] = useState(false);
  const captureButtonRef = useRef<HTMLButtonElement | null>(null);
  function savePtt(next: PushToTalkConfig) {
    setPtt(next);
    savePushToTalk(next);
  }
  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setCapturing(false);
        return;
      }
      const binding = bindingFromEvent(event);
      if (!binding) return;
      setPtt((current) => {
        const next = { ...current, binding, enabled: true };
        savePushToTalk(next);
        return next;
      });
      setCapturing(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !captureButtonRef.current?.contains(event.target)
      )
        setCapturing(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [capturing]);
  useEffect(() => {
    let cancelled = false;
    api
      .speechSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch(() => {
        if (!cancelled) setError('Unable to load speech providers.');
      });
    return () => {
      cancelled = true;
    };
  }, [api]);
  async function save(next: SpeechPreferences) {
    setBusy(true);
    setError('');
    try {
      setSettings(await api.saveSpeechSettings(next));
    } catch {
      setError('Unable to save speech settings.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="speech-settings" aria-label="Speech providers">
      <header className="speech-settings-heading">
        <h3>Speech to text</h3>
        <p>Speak to compose a message.</p>
      </header>
      {error && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
      {settings?.providers.map((provider) => (
        <article className="settings-provider-card" key={provider.id}>
          <div className="speech-provider-row">
            <span className="settings-provider-logo">
              <AudioLines />
            </span>
            <div className="settings-provider-identity">
              <h3>{provider.name}</h3>
              <p>
                {provider.configured
                  ? 'Ready · Live transcription'
                  : 'API key required'}
              </p>
            </div>
            <label className="speech-toggle">
              <input
                type="checkbox"
                aria-label={`Enable ${provider.name}`}
                disabled={busy}
                checked={settings.enabled.includes(provider.id)}
                onChange={(event) => {
                  const enabled = event.target.checked
                    ? [...settings.enabled, provider.id]
                    : settings.enabled.filter((id) => id !== provider.id);
                  void save({
                    enabled,
                    activeProvider: enabled.includes(
                      settings.activeProvider ?? '',
                    )
                      ? settings.activeProvider
                      : (enabled[0] ?? null),
                  });
                }}
              />
              <span aria-hidden="true" />
            </label>
          </div>
          {!provider.configured && (
            <details className="speech-setup">
              <summary>Connection setup</summary>
              <p>
                Set <code>MODEL_API_KEY</code> on the server, then restart
                Webcode.
              </p>
            </details>
          )}
        </article>
      ))}
      {settings && (
        <label className="speech-provider-select">
          <span>Dictation provider</span>
          <span className="speech-select-control">
            <select
              aria-label="Dictation provider"
              disabled={busy}
              value={settings.activeProvider ?? ''}
              onChange={(event) =>
                void save({
                  enabled: settings.enabled,
                  activeProvider: event.target.value || null,
                })
              }
            >
              <option value="">Off</option>
              {settings.providers
                .filter((p) => settings.enabled.includes(p.id))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </span>
        </label>
      )}
      <div className="ptt-section">
        <div className="ptt-heading">
          <div>
            <h3>Push to talk</h3>
            <p>Dictate with a keyboard shortcut, no click needed.</p>
          </div>
          <label className="speech-toggle">
            <input
              type="checkbox"
              aria-label="Enable push to talk"
              checked={ptt.enabled}
              onChange={(event) =>
                savePtt({ ...ptt, enabled: event.target.checked })
              }
            />
            <span aria-hidden="true" />
          </label>
        </div>
        <div className="ptt-row">
          <button
            type="button"
            className="ptt-key"
            ref={captureButtonRef}
            onClick={() => setCapturing((value) => !value)}
          >
            {capturing
              ? 'Press keys… (Esc to cancel)'
              : ptt.binding
                ? bindingLabel(ptt.binding)
                : 'Set shortcut…'}
          </button>
          {ptt.binding && !capturing && (
            <button
              type="button"
              className="ptt-clear"
              onClick={() => savePtt({ ...ptt, binding: null })}
            >
              Clear
            </button>
          )}
        </div>
        <label className="speech-provider-select">
          <span>Shortcut behavior</span>
          <span className="speech-select-control">
            <select
              aria-label="Shortcut behavior"
              value={ptt.mode}
              onChange={(event) =>
                savePtt({
                  ...ptt,
                  mode: event.target.value === 'toggle' ? 'toggle' : 'hold',
                })
              }
            >
              <option value="hold">Hold to talk</option>
              <option value="toggle">Press to toggle</option>
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </span>
        </label>
        <p className="ptt-hint">
          {ptt.mode === 'hold'
            ? 'Hold the shortcut while speaking, release to transcribe.'
            : 'Press once to start, press again to transcribe.'}{' '}
          Shortcuts without Ctrl, Alt or ⌘ are ignored while typing.
        </p>
      </div>
      <p className="speech-privacy">
        Audio is processed by your selected provider. Webcode doesn’t save
        recordings.
      </p>
    </section>
  );
}
