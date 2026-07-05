/**
 * Research engine — entry point.
 * All exports needed externally: initResearch, stopResearch, getSignalStore, triggerResearchTick.
 */

export { SignalStore } from "./db.js";
export type { SignalSource, SignalQuery, TableInfo } from "./db.js";
export { initResearch, stopResearch, getSignalStore, triggerResearchTick } from "./ingestion.js";