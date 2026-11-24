/**
 * `server-only` is a build-time guard: importing it from a Client Component
 * bundle throws, which is exactly what we want in the app.
 *
 * In a plain Node test run the bundler condition that distinguishes the two is
 * not in play, so the guard trips on legitimate server code under test. Vitest
 * resolves the package to this no-op instead — the alias only exists in
 * vitest.config.ts, never in tsconfig or the Next build.
 */
export {};
