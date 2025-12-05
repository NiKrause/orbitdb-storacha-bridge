import js from "@eslint/js";

/** @type {import('eslint').Linter.Config[]} */
export default [
  js.configs.recommended,
  {
    languageOptions: {
      globals: {
        // Browser globals
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        File: "readonly",
        // Node globals
        process: "readonly",
        Buffer: "readonly",
        // Jest globals
        jest: "readonly",
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
        // Globals available in test/browser environments
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        console: "readonly",
        fetch: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        Response: "readonly",
        URL: "readonly",
        Blob: "readonly",
        File: "readonly",
        CustomEvent: "readonly",
        AbortSignal: "readonly",
        navigator: "readonly",
        global: "readonly",
      },
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-console": "off",
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "prefer-const": "warn",
      "no-var": "error",
    },
  },
  {
    files: ["examples/**/*.js"],
    rules: {
      "no-unused-vars": "off",
      "no-console": "off",
    },
  },
  {
    files: ["lib/**/*.js"],
    rules: {
      "prefer-const": "error",
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    ignores: [
      "node_modules/",
      "coverage/",
      "*.min.js",
      "dist/",
      "orbitdb/",
      "examples/svelte/*/build/**",
      "examples/svelte/*/dist/**",
      "examples/svelte/**/.svelte-kit/**",
    ],
  },
];

