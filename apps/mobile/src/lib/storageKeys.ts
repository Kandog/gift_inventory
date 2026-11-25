export const KEYS = {
  servers: 'servers', // secure: JSON string[]
  deviceToken: 'deviceToken', // secure
  sessionToken: 'sessionToken', // secure
  user: 'user',
  catalog: 'catalog',
  outbox: 'outbox',
  history: 'history',
  problems: 'problems',
  prefs: 'prefs',
  lastSyncAt: 'lastSyncAt',
} as const;
