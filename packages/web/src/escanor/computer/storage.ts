import type { PairedComputer } from './lib/client';

const KEY = 'escanor.computers.v1';

/** The computers this phone is paired with. The device key in each entry is what authorises this phone, so it stays on this phone only. */
export function loadComputers(): PairedComputer[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((c) => c && typeof c.id === 'string' && typeof c.key === 'string') : [];
  } catch {
    return [];
  }
}

export function saveComputer(c: PairedComputer): PairedComputer[] {
  const rest = loadComputers().filter((x) => x.id !== c.id);
  const next = [c, ...rest];
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function removeComputer(id: string): PairedComputer[] {
  const next = loadComputers().filter((c) => c.id !== id);
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

/** Signing out of Escanor takes the paired computers with it, like the hosted hub's credentials. */
export function clearComputers(): void {
  localStorage.removeItem(KEY);
}
