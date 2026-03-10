import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.js", "test.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        performance: "readonly",
        fetch: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        module: "readonly",
        require: "readonly",
        exports: "readonly",
      },
    },
    rules: {
      // Catch real bugs
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-unreachable": "error",
      "no-constant-condition": "error",

      // Async safety — most bugs in this codebase are unhandled promise rejections
      "no-async-promise-executor": "error",
      "require-await": "warn",

      // Keep code consistent without being pedantic
      "eqeqeq": ["error", "always"],
      "no-var": "error",
      "prefer-const": "warn",

      // Our phone digit-stripping uses \D which ESLint flags as control chars in some contexts
      "no-control-regex": "off",

      // Not enforced — formatting handled by eye, not rules
      "semi": "off",
      "quotes": "off",
      "indent": "off",
      "comma-dangle": "off",
    },
  },
  {
    // Ignore generated/vendored files and old test files not managed by this config
    ignores: [
      "node_modules/**",
      "public/**",
      "test-ai.js",        // legacy test file — not part of v1.0 test suite
      "test-whatsapp.js",  // legacy test file — not part of v1.0 test suite
    ],
  },
];