/* Single source of truth for the backend address the extension ships with.
 *
 * Popup, options page and the background worker all read `defaultApiUrl` from
 * here instead of repeating a literal, so pointing a build at a hosted backend
 * is a one-line change rather than four scattered edits that silently drift.
 *
 * Changing this value REQUIRES a matching entry in manifest.json's
 * `host_permissions`, otherwise the extension ships without permission to reach
 * its own default backend and every request fails until the user opens the
 * options page. `npm run check:config` enforces that pairing and CI runs it.
 */
globalThis.FXConfig = {
  defaultApiUrl: "http://localhost:8000/api/v1",
};
