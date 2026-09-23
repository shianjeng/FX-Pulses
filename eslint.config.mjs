export default [{ignores: ["extension/amount-parser.js", "extension/messages.js"]}, {
  files: ["extension/*.js", "tests/*.cjs"],
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "script",
    globals: Object.fromEntries(["chrome", "document", "navigator", "fetch", "URL", "URLSearchParams",
      "setTimeout", "console", "require", "__dirname", "Buffer", "process", "importScripts"].map(x => [x, "readonly"]))
  },
  rules: {"no-undef": "error", "no-unused-vars": "error", "no-unreachable": "error",
    "no-constant-condition": "error", "eqeqeq": "error"}
}];
