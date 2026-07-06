/**
 * Pi.dev agent session factory for the strategist.
 * Research-only tools. No execution capabilities.
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
import { STRATEGIST_SYSTEM_PROMPT } from "./strategist-prompt.js";
import { allStrategistTools } from "./strategist-tools.js";

export async function createStrategistBrain(openRouterKey?: string) {
  const authStorage = AuthStorage.create();
  if (openRouterKey) {
    authStorage.setRuntimeApiKey("openrouter", openRouterKey);
  }

  const modelRegistry = ModelRegistry.inMemory(authStorage);

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
      console.log(`🧠 Strategist using model: ${mid}`);
      break;
    }
  }

  if (!model) {
    throw new Error(`No valid model found in OpenRouter registry. Tried: ${knownModels.join(", ")}`);
  }

  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => STRATEGIST_SYSTEM_PROMPT,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  const settingsManager = SettingsManager.inMemory({
    compaction: {
      enabled: true,
      keepRecentTokens: 12000,
      reserveTokens: 4000,
    },
    retry: { enabled: false },
  });

  const { session } = await createAgentSession({
    model: model ?? undefined,
    thinkingLevel: "low",
    authStorage,
    modelRegistry,
    resourceLoader,
    tools: allStrategistTools.map((t) => t.name),
    customTools: allStrategistTools,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });

  return session;
}