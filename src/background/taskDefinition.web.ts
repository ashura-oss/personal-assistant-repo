// Background refresh is unsupported on web. This platform entry is intentionally inert.
export function setMailRefreshTaskRunner(_next: (() => Promise<boolean>) | undefined): void {}
