#!/usr/bin/env node
/*
 * Verifies that the backend address the extension ships with is actually
 * reachable under the permissions the extension ships with.
 *
 * extension/config.js holds the default API URL. manifest.json holds the
 * host permissions granted at install time. If the two drift — the usual way
 * being a new deployment domain set in one place but not the other — the
 * extension installs without permission to call its own default backend, and
 * every request fails with a bare "cannot connect" until the user discovers
 * the options page. Nothing else in the build catches that, so this does.
 *
 *   node tools/check-config.mjs
 */
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(root, "extension", ...parts), "utf8");

const fail = (message) => {
  console.error(`config check failed: ${message}`);
  process.exit(1);
};

const source = read("config.js");
const match = source.match(/defaultApiUrl:\s*"([^"]+)"/);
if (!match) fail("extension/config.js does not define a literal defaultApiUrl");

let api;
try {
  api = new URL(match[1]);
} catch {
  fail(`defaultApiUrl is not a valid URL: ${match[1]}`);
}

if (!["http:", "https:"].includes(api.protocol)) {
  fail(`defaultApiUrl must be http or https, got ${api.protocol}`);
}

// A public deployment served over http would send every request in the clear.
// localhost is exempt: self-hosting over plain http on the same machine is the
// documented development path.
if (api.protocol === "http:" && !["localhost", "127.0.0.1"].includes(api.hostname)) {
  fail(`defaultApiUrl must use https for a non-local host, got ${api.origin}`);
}

const manifest = JSON.parse(read("manifest.json"));
const granted = manifest.host_permissions ?? [];

// Chrome match patterns, restricted to the shapes this manifest uses.
const covers = (pattern, url) => {
  const parsed = pattern.match(/^(\*|https?):\/\/([^/]+)(\/.*)$/);
  if (!parsed) return false;
  const [, scheme, host, path] = parsed;
  if (scheme !== "*" && `${scheme}:` !== url.protocol) return false;
  if (host !== url.host && !(host.startsWith("*.") && url.host.endsWith(host.slice(1)))) return false;
  return path === "/*" || path === url.pathname;
};

if (!granted.some((pattern) => covers(pattern, api))) {
  fail(
    `manifest host_permissions ${JSON.stringify(granted)} do not cover the default backend ${api.origin}.\n` +
    `  Add "${api.origin}/*" to host_permissions in extension/manifest.json.`,
  );
}

console.log(`config ok: default backend ${api.origin} is covered by host_permissions`);
