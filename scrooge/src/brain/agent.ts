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
  getModel,
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

  // 3. Model Selection — use cheapest model, Gemini Flash 1.5 is fine
  const modelId = process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat-v3-0724";
  let model = modelRegistry.find("openrouter", modelId);
  if (!model) {
    throw new Error(`Model ${modelId} not found in OpenRouter registry. Check the model name is correct.`);
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
  const settingsManager = SettingsManager.inMemory({
    compaction: {
      enabled: true,
      maxTurns: 12,           // Keep only last 12 turns (~3 cycles at 4 tool calls each)
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
