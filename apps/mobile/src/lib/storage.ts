import * as SecureStore from 'expo-secure-store';
import Storage from 'expo-sqlite/kv-store';

/** Secrets (tokens) live in the OS keychain/keystore. */
export const secure = {
  get: (key: string) => SecureStore.getItemAsync(key),
  set: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  del: (key: string) => SecureStore.deleteItemAsync(key),
};

/** Everything else (catalog, outbox, settings) is JSON in an on-device SQLite key-value store. */
export const kv = {
  async get<T>(key: string, fallback: T): Promise<T> {
    const raw = await Storage.getItem(key);
    if (raw == null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  set: (key: string, value: unknown) => Storage.setItem(key, JSON.stringify(value)),
  del: (key: string) => Storage.removeItem(key),
};

export { KEYS } from './storageKeys';
