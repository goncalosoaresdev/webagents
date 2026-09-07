export interface LimitWindow {
  id: string;
  label: string;
  remainingPercent: number | null;
  durationMinutes: number | null;
  resetsAt: number | null;
}
export interface ProviderLimits {
  providerId: string;
  checkedAt: string;
  windows: LimitWindow[];
  accountLabel?: string;
  status: 'available' | 'unavailable';
}
export function windowLabel(minutes: number | null, fallback: string): string {
  if (!minutes) return fallback;
  if (minutes % 10080 === 0)
    return minutes === 10080 ? 'Weekly' : `${minutes / 10080}-week window`;
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}
export function resetLabel(timestamp: number | null, now: number): string {
  if (timestamp === null) return 'Reset time unavailable';
  const minutes = Math.ceil((timestamp * 1000 - now) / 60000);
  if (minutes <= 0) return 'Reset due · refresh to update';
  const days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60),
    rest = minutes % 60;
  return `Resets in ${days ? `${days}d ${hours}h` : hours ? `${hours}h ${rest}m` : `${rest}m`}`;
}
export function tightestRemaining(
  limits: ProviderLimits | undefined,
  now: number,
): number | null {
  if (
    !limits ||
    limits.status !== 'available' ||
    now - Date.parse(limits.checkedAt) > 120000
  )
    return null;
  const values = limits.windows
    .filter(
      (w) =>
        w.remainingPercent !== null &&
        (w.resetsAt === null || w.resetsAt * 1000 > now),
    )
    .map((w) => w.remainingPercent!);
  return values.length ? Math.min(...values) : null;
}
