export default [{
  files: ["extension/*.js", "tests/*.cjs"],
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "script",
    globals: Object.fromEntries(["chrome", "document", "navigator", "fetch", "URL",
      "setTimeout", "console", "require", "__dirname", "Buffer", "process"].map(x => [x, "readonly"]))
  },
  rules: {"no-undef": "error", "no-unused-vars": "error", "no-unreachable": "error",
    "no-constant-condition": "error", "eqeqeq": "error"}
}];
