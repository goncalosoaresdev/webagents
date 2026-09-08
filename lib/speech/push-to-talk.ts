export interface PushToTalkBinding {
  key: string;
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface PushToTalkConfig {
  enabled: boolean;
  mode: 'hold' | 'toggle';
  binding: PushToTalkBinding | null;
}

const STORAGE_KEY = 'webcode.push-to-talk.v1';

export const defaultPushToTalk: PushToTalkConfig = {
  enabled: false,
  mode: 'hold',
  binding: null,
};

export function loadPushToTalk(): PushToTalkConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPushToTalk;
    const parsed = JSON.parse(raw) as Partial<PushToTalkConfig>;
    if (!parsed || typeof parsed !== 'object') return defaultPushToTalk;
    const binding = parsed.binding;
    return {
      enabled: parsed.enabled === true,
      mode: parsed.mode === 'toggle' ? 'toggle' : 'hold',
      binding:
        binding && typeof binding.code === 'string' && binding.code
          ? {
              key: typeof binding.key === 'string' ? binding.key : binding.code,
              code: binding.code,
              ctrl: binding.ctrl === true,
              alt: binding.alt === true,
              shift: binding.shift === true,
              meta: binding.meta === true,
            }
          : null,
    };
  } catch {
    return defaultPushToTalk;
  }
}

export function savePushToTalk(config: PushToTalkConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* Browser storage is optional. */
  }
}

const MODIFIER_KEYS = new Set([
  'Control',
  'Shift',
  'Alt',
  'Meta',
  'AltGraph',
]);

export function bindingFromEvent(event: KeyboardEvent): PushToTalkBinding | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  return {
    key: event.key,
    code: event.code,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
}

function keyLabel(key: string, code: string): string {
  if (key === ' ') return 'Space';
  if (key.length === 1) return key.toUpperCase();
  if (key.startsWith('Arrow')) return key.slice(5);
  if (code.startsWith('F') && /^F\d+$/.test(code)) return code;
  return key;
}

export function bindingLabel(binding: PushToTalkBinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push('Ctrl');
  if (binding.alt) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  if (binding.meta) parts.push('⌘');
  parts.push(keyLabel(binding.key, binding.code));
  return parts.join(' + ');
}

export function bindingMatches(
  binding: PushToTalkBinding,
  event: KeyboardEvent,
): boolean {
  return (
    event.code === binding.code &&
    event.ctrlKey === binding.ctrl &&
    event.altKey === binding.alt &&
    event.shiftKey === binding.shift &&
    event.metaKey === binding.meta
  );
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
