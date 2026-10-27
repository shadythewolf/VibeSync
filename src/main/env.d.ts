/// <reference types="electron-vite/node" />

/**
 * Ambient typing for the main process bundle.
 *
 * `electron-vite/node` declares the `*?asset` / `*?modulePath` import suffixes and the
 * `ELECTRON_RENDERER_URL` environment variable used in development.
 */
declare namespace NodeJS {
  interface ProcessEnv {
    /** Override the userData directory (used by e2e tests for an isolated profile). */
    readonly VIBEDECK_USER_DATA?: string
    /** '1' enables DevTools in a packaged build. */
    readonly VIBEDECK_DEVTOOLS?: string
    /** '1' mirrors log lines to the console in a packaged build. */
    readonly VIBEDECK_LOG_CONSOLE?: string
    /** Set by electron-builder's portable target to the folder the portable exe runs from. */
    readonly PORTABLE_EXECUTABLE_DIR?: string
    /** Set by electron-builder's portable target to the portable exe path. */
    readonly PORTABLE_EXECUTABLE_FILE?: string
  }
}
