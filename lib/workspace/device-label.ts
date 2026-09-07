/** Browser-visible device family; personal computer names are not exposed. */
export function deviceLabel(
  userAgent: string,
  platform = '',
  touchPoints = 0,
): string {
  if (/iPad/i.test(userAgent) || (/Mac/i.test(platform) && touchPoints > 1))
    return 'iPad';
  if (/iPhone|iPod/i.test(userAgent)) return 'iPhone';
  if (/Android/i.test(userAgent))
    return /Mobile/i.test(userAgent) ? 'Android phone' : 'Android tablet';
  if (/Mac/i.test(platform + userAgent)) return 'Mac';
  if (/Windows|Win32/i.test(platform + userAgent)) return 'Windows PC';
  if (/CrOS/i.test(userAgent)) return 'Chromebook';
  if (/Linux/i.test(platform + userAgent)) return 'Linux PC';
  return 'This device';
}
