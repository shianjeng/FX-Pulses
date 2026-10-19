#!/usr/bin/env node
/* Builds the Firefox edition from extension/, which stays the one source.
 *
 *   node tools/build-firefox.mjs [--out dist/firefox]
 *
 * Only the manifest differs. Firefox runs Manifest V3 background code as
 * scripts in an event page rather than a service worker, so the worker's
 * importScripts() list becomes background.scripts, in the same order. It
 * needs an add-on ID, opens settings through options_ui, and does not know
 * Chrome's minimum_chrome_version or use_dynamic_url. Everything else,
 * including the chrome.* calls, runs unchanged: Firefox answers them with
 * promises as Chrome does.
 */
import {cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "extension");
const flag = process.argv.indexOf("--out");
const out = resolve(root, flag > 0 ? process.argv[flag + 1] : "dist/firefox");

export const GECKO_ID = "fx-pulse@shianjeng.github.io";
// Firefox 140, the current ESR, is the first to read the data collection
// declaration AMO now asks every add-on for; Firefox for Android follows in 142.
export const FIREFOX_MIN = "140.0";
export const FIREFOX_ANDROID_MIN = "142.0";

export function firefoxManifest(chrome, workerSource) {
  const manifest = structuredClone(chrome);
  delete manifest.minimum_chrome_version;
  // The worker's own importScripts() list, so the two can never disagree.
  const imported = workerSource.match(/importScripts\(([^)]*)\)/)?.[1].match(/"[^"]+"/g)?.map(name => JSON.parse(name));
  if (!imported?.length) throw new Error("background.js no longer names the scripts it imports");
  manifest.background = {scripts: [...imported, manifest.background.service_worker]};
  manifest.options_ui = {page: manifest.options_page, open_in_tab: true};
  delete manifest.options_page;
  manifest.web_accessible_resources = manifest.web_accessible_resources.map(({use_dynamic_url, ...entry}) => entry);
  manifest.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: FIREFOX_MIN,
      // Nothing is collected: requests carry no identifiers, preferences stay on the device.
      data_collection_permissions: {required: ["none"]},
    },
    gecko_android: {strict_min_version: FIREFOX_ANDROID_MIN},
  };
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chrome = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
  const manifest = firefoxManifest(chrome, readFileSync(join(source, "background.js"), "utf8"));
  rmSync(out, {recursive: true, force: true});
  mkdirSync(out, {recursive: true});
  cpSync(source, out, {recursive: true, filter: path => !path.endsWith(".DS_Store")});
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Firefox ${manifest.version} built in ${out}`);
}
