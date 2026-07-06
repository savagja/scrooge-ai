// Shim: re-exports from the real src/config.ts
// tsx on Pi can't resolve ../config.js → config.ts automatically for relative imports.
export { getConfig, reloadConfig, getTradingDate } from "./src/config.ts";