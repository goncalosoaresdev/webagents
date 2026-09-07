/** Layout measurements can be unavailable while a terminal dock animates in. */
export function terminalDimensions(
  size: { cols: number; rows: number } | undefined,
): { cols: number; rows: number } | undefined {
  if (
    !size ||
    !Number.isFinite(size.cols) ||
    !Number.isFinite(size.rows) ||
    size.cols <= 0 ||
    size.rows <= 0
  )
    return undefined;
  return {
    cols: Math.max(20, Math.min(300, Math.floor(size.cols))),
    rows: Math.max(5, Math.min(100, Math.floor(size.rows))),
  };
}
export function terminalCloseMessage(code: number): string | undefined {
  if (code === 1008)
    return 'Terminal connection rejected. Close and reopen the panel to retry.';
  if (code === 1009)
    return 'Terminal output exceeded the connection limit. Close and reopen to retry.';
  return undefined;
}
