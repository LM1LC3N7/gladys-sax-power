// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container. Every handler is registered
// BEFORE connect(). Read-only: no command handler, a battery is never commanded.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the batteries known, never a request by itself.
  gladys.onScanRequest(() => app.scan());
  // A device just created: the values of the last read now (no new request).
  gladys.onDeviceCreated((device) => app.onDeviceCreated(device));
  gladys.onDeviceUpdated((device) => app.onDeviceUpdated(device));

  // Configuration screen buttons.
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());

  // Configuration changed by the user: applied one after the other, the last one wins.
  gladys.onConfigUpdated((config) => {
    logger?.info('Configuration updated: restarting');
    return app.start(config, { fresh: true });
  });

  // Every connection (the first one and each reconnection) publishes the
  // devices and the status again, and every value at the next read. A failed
  // getConfig() is asked again without end (src/app.js connectedVia).
  gladys.on('connected', async () => {
    try {
      await app.connectedVia(() => gladys.getConfig());
    } catch (err) {
      logger?.error(`Start failed (${err?.name ?? 'Error'})`);
    }
  });
  gladys.on('disconnected', () => {
    app.stop().catch((err) => logger?.error(`Stop failed (${err?.name ?? 'Error'})`));
  });
}
