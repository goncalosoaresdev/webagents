export const stableVersion = (value: string): boolean =>
  /^\d+\.\d+\.\d+$/.test(value);
export function isNewerVersion(installed: string, latest: string): boolean {
  if (!stableVersion(installed) || !stableVersion(latest)) return false;
  const a = installed.split('.').map(Number),
    b = latest.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return b[i]! > a[i]!;
  }
  return false;
}
export interface InstallationDriver {
  inspect(): Promise<{
    version?: string;
    canUpdate: boolean;
    message?: string;
  }>;
  latest(): Promise<string>;
  update(version: string): Promise<void>;
}
