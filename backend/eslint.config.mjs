import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Lint rules for the backend.
 *
 * The audit's release-assurance finding was that `npm run lint` was a
 * placeholder that echoed a message and exited zero — so the repository had a
 * lint step in name only, and CI could never have caught anything with it.
 *
 * The selection below is deliberately narrow. Rules that merely express a style
 * preference are left out: they generate churn, train people to add
 * `eslint-disable`, and a disable comment that everyone has learned to ignore is
 * worse than no rule. What is enabled is the set that catches genuine defects in
 * *this* codebase — a platform that runs untrusted model output against real
 * repositories, where a floating promise means an un-awaited database write and
 * an accidental `any` means an unvalidated tool argument reaching `fs`.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /**
       * The most valuable rule here by a wide margin.
       *
       * Almost every write in this codebase is an async repository call, and a
       * forgotten `await` produces a silent partial state change: the status
       * flips in memory, the database never hears about it, and the run reports
       * success. Several of the audit's execution findings have this shape.
       */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        // Express handlers legitimately pass async functions where a void-returning
        // one is expected; `asyncHandler` is what makes that safe.
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],

      // Unvalidated model output flowing into typed code is the failure mode
      // these guard. `warn` rather than `error` because provider SDK boundaries
      // legitimately deal in `any` and blocking CI on them helps nobody.
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',

      // An unused variable is usually a half-finished edit. The underscore
      // prefix is the escape hatch for deliberately-ignored bindings.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // `console` is how the environment validator reports a fatal misconfiguration
      // before the logger exists; everything else must use the structured logger,
      // which carries redaction.
      'no-console': ['warn', { allow: ['error', 'warn'] }],

      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-return-await': 'off',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],

      // Template literals around a non-string silently produce "[object Object]"
      // in a log line or an agent-visible error message.
      '@typescript-eslint/restrict-template-expressions': [
        'warn',
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],

      /**
       * Off, with reasons — each of these fires on a deliberate pattern here.
       *
       * `unbound-method`: controllers are plain object literals whose methods
       * never reference `this`; passing `controller.create` to `asyncHandler` is
       * the intended shape and rebinding every one would add noise without
       * removing a risk. The rule cannot see that the methods are `this`-free.
       *
       * `require-await`: several functions are `async` because they satisfy an
       * async interface or return a promise from a callback, not because they
       * await. Forcing them sync would make the contract worse.
       *
       * `no-redundant-type-constituents`: `StopReason` is deliberately
       * `'end_turn' | ... | string` so a provider can return a stop reason this
       * codebase has not seen yet without a type error. The named members are
       * documentation and autocomplete; widening is the point.
       *
       * `no-unsafe-enum-comparison`: Mongoose exposes `connection.readyState`
       * as a number that is not typed as its own enum. Comparing it to a literal
       * is how the driver's own docs do it.
       */
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/no-unsafe-enum-comparison': 'off',
    },
  },

  {
    // Tests assert on deliberately-wrong values, so the unsafe-* family is noise
    // here by construction.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
);
