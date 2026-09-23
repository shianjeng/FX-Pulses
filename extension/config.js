/* Single source of truth for the backend the extension ships with.
 *
 * Popup, options page and the background worker all read this instead of
 * repeating a literal, so pointing a build at another backend is a one-line
 * change rather than four scattered edits that silently drift.
 *
 * Changing `defaultApiUrl` REQUIRES a matching entry in manifest.json's
 * `host_permissions`, otherwise the extension ships without permission to reach
 * its own default backend and every request fails until the user opens the
 * options page. `npm run check:config` enforces that pairing and CI runs it.
 *
 * `backendMode` picks how the worker talks to that backend:
 *
 *   "api"     a running FastAPI service. Paths are sent as the API defines
 *             them, and the server computes freshness per request.
 *   "static"  a directory of JSON files on any web host, produced by
 *             `python -m app.export_static`. There is no server process, so
 *             the worker maps each API path onto its file and computes the
 *             time-dependent fields (`is_stale`, `is_stalled`, history
 *             windows) itself from the thresholds in meta.json.
 *
 * Both modes present the same data to popup and hover, which never learn which
 * one is in use. The options page detects the mode of a user-supplied backend.
 */
globalThis.FXConfig = {
  defaultApiUrl: "http://localhost:8000/api/v1",
  backendMode: "api",
};
