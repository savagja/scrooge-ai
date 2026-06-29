/**
 * Pi.dev agent session factory.
 * Creates the trading brain with custom tools, system prompt, and OpenRouter model.
 */

import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  createExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
import { TRADING_SYSTEM_PROMPT } from "./system-prompt.js";
import { allTradingTools } from "./tools.js";

export async function createTradingBrain(openRouterKey?: string) {
  // 1. Auth: OpenRouter
  const authStorage = AuthStorage.create();
  if (openRouterKey) {
    authStorage.setRuntimeApiKey("openrouter", openRouterKey);
  }

  // 2. Model Registry
  const modelRegistry = ModelRegistry.inMemory(authStorage);

  // 3. Model Selection — try configured model, then fall through known-good models
  const knownModels = [
    process.env.OPENROUTER_MODEL,
    "google/gemini-2.5-flash-lite",
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v3.2",
    "google/gemini-2.5-flash",
  ].filter(Boolean) as string[];

  let model: ReturnType<ModelRegistry["find"]> = undefined;
  for (const mid of knownModels) {
    model = modelRegistry.find("openrouter", mid);
    if (model) {
      console.log(`🧠 Using model: ${mid}`);
      break;
    }
  }

  if (!model) {
    throw new Error(`No valid model found in OpenRouter registry. Tried: ${knownModels.join(", ")}`);
  }

  // 4. Custom ResourceLoader (no discovery, fully explicit)
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => TRADING_SYSTEM_PROMPT,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  // 5. Settings — aggressive compaction to control token costs
  // Compaction keeps recent tokens (roughly ~12 turns worth) and discards old context
  const settingsManager = SettingsManager.inMemory({
    compaction: {
      enabled: true,
      keepRecentTokens: 12000,  // Keep ~12K tokens of recent context (~12 turns)
      reserveTokens: 4000,      // Reserve 4K tokens for the response
    },
    retry: { enabled: false }, // Disable retries to prevent runaway costs on errors
  });

  // 6. Create Session
  const { session } = await createAgentSession({
    model: model ?? undefined,
    thinkingLevel: "low",
    authStorage,
    modelRegistry,
    resourceLoader,
    tools: allTradingTools.map((t) => t.name),
    customTools: allTradingTools,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });

  return session;
}
