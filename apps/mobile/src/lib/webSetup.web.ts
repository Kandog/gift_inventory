import { prepareZXingModule } from 'barcode-detector/ponyfill';

/** Where the PC serves the phone app (matches experiments.baseUrl in app.json). */
export const APP_BASE = '/app/';

/** On the web the app is served by the Gift Inventory server itself, so it always talks to that server. */
export const webOrigin: string | null = typeof window !== 'undefined' ? window.location.origin : null;

let done = false;

/** Runs once at start-up in the browser version of the phone app. */
export function webSetup() {
  if (done || typeof window === 'undefined') return;
  done = true;

  // Safari has no built-in barcode reader, so expo-camera uses a WebAssembly one. By default it is
  // downloaded from a public CDN; load the copy the PC serves instead, so scanning works without internet.
  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? `${APP_BASE}${path}` : prefix + path),
    },
  });

  // Keeps the app's files on the phone so it opens even when the PC can't be reached.
  // Browsers only allow this over HTTPS (or on localhost).
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register(`${APP_BASE}sw.js`, { scope: APP_BASE }).catch(() => {});
  }
}
