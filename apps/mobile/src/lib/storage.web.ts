// Web version of storage.ts, used when the phone app runs in a browser (served by the PC at /app).
// Browsers have no keychain and expo-sqlite's web build needs special server headers, so both
// tokens and data live in the browser's localStorage for this site.

const PREFIX = 'gifts:';

const read = (key: string) => {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
};

export const secure = {
  get: async (key: string) => read(key),
  set: async (key: string, value: string) => localStorage.setItem(PREFIX + key, value),
  del: async (key: string) => localStorage.removeItem(PREFIX + key),
};

export const kv = {
  async get<T>(key: string, fallback: T): Promise<T> {
    const raw = read(key);
    if (raw == null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  set: async (key: string, value: unknown) => localStorage.setItem(PREFIX + key, JSON.stringify(value)),
  del: async (key: string) => localStorage.removeItem(PREFIX + key),
};

export { KEYS } from './storageKeys';
