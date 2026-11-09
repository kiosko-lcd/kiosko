/**
 * Compile-time flag set by build.mjs (esbuild `define`): true only in the
 * static browser demo (`build.mjs --demo`). Branches on it are dropped
 * from the normal editor build.
 */
declare const KIOSKO_DEMO: boolean;
