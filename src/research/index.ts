/**
 * Research engine — entry point.
 * All exports needed externally: initResearch, stopResearch, getSignalStore, triggerResearchTick.
 */

export { SignalStore, SECTOR_ETFS } from "./db.js";
export type { SignalSource, SignalQuery, TableInfo } from "./db.js";
export { initResearch, stopResearch, getSignalStore, triggerResearchTick, getResearchHealth } from "./ingestion.js";