'use client';
import { useSyncExternalStore } from 'react';
import { Monitor, Smartphone, Tablet } from 'lucide-react';
import { deviceLabel } from '@/lib/workspace/device-label';
const subscribe = () => () => {};
const serverLabel = () => 'This device';
const browserLabel = () =>
  deviceLabel(
    navigator.userAgent,
    navigator.platform,
    navigator.maxTouchPoints,
  );
export function DeviceIndicator() {
  const label = useSyncExternalStore(subscribe, browserLabel, serverLabel);
  const Icon = /phone/i.test(label)
    ? Smartphone
    : /pad|tablet/i.test(label)
      ? Tablet
      : Monitor;
  return (
    <span className="composer-device" title="Device you’re sending from">
      <Icon size={13} />
      <span>{label}</span>
    </span>
  );
}
