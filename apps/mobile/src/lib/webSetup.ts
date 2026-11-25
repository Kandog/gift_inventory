/** Runs once at start-up. Nothing is needed in the installed Android/iPhone app; see webSetup.web.ts. */
export function webSetup() {}

/** On the web the app is served by the Gift Inventory server itself, so it always talks to that server. */
export const webOrigin: string | null = null;
