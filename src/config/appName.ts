// Product name shown in the UI. Kept in its own module (rather than in
// `@config/app`) so light contexts like the service worker can import it
// without pulling in App's `navigator`/`location` module-level side effects.
//
// Note this is NOT App.suffix — that one is part of the MTProto websocket
// hostname (see dcConfigurator) and must stay 'K'.
export const APP_NAME = 'Cat Messenger';
