import type { ConsoleState } from './types';

/** 读取控制台状态；失败时抛出，由调用方决定提示与重试。 */
export async function fetchState(): Promise<ConsoleState> {
  const response = await fetch('/api/state', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as ConsoleState;
}
