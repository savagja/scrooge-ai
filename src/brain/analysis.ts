/**
 * OpenRouter LLM analysis for news headlines.
 * Returns structured trading signals.
 */

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

interface RawLLMResponse {
  direction: string;
  impact_score: number;
  confidence: number;
  reasoning: string;
  timeframe?: string;
  key_entities?: string[];
}

export async function analyzeNews(
  headline: string,
  summary: string,
  ticker: string,
  prevClose: number = 0
): Promise<{
  symbol: string;
  direction: "long" | "short" | "neutral";
  impactScore: number;
  confidence: number;
  reasoning: string;
  suggestedSizePct: number;
  suggestedHoldMinutes: number;
}> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY not set");
  }

  const model = process.env.OPENROUTER_MODEL || "google/gemini-flash-1.5-8b";

  const systemPrompt = `You are an expert financial news analyst specializing in rapid price-action signals.
Your job is to read a news headline and determine if it creates a SHORT-TERM TRADING OPPORTUNITY.

Rules:
- Focus on IMMEDIATE market reaction potential (minutes to hours), not long-term fundamentals.
- Score impact from -10 (extremely bearish) to +10 (extremely bullish).
- A score of 4-5 means "moderate, tradeable move likely". A score of 6+ means "strong, high conviction".
- "quick" = likely reaction within 15-30 minutes (e.g. FDA approval, cyber breach).
- "hours" = likely reaction over 1-4 hours (e.g. earnings beat, activist investor).

Respond ONLY in this JSON format:
{"direction": "long", "impact_score": 8, "confidence": 0.82, "reasoning": "brief rationale", "timeframe": "quick", "key_entities": ["NOTABLE INVESTOR", "ACQUISITION TARGET"]}`;

  const userPrompt = `HEADLINE: ${headline}
${summary ? `SUMMARY: ${summary}` : ""}
TICKER: ${ticker}
${prevClose > 0 ? `PREVIOUS CLOSE: $${prevClose.toFixed(2)}` : ""}

Analyze this news for short-term directional movement.`;

  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://localhost",
        "X-Title": "Scrooge Trading Bot",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 512,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenRouter error: ${res.status} ${text}`);
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || "";

    // Extract JSON from markdown fences
    let cleaned = raw.replace(/```json\s*|```\s*/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) cleaned = match[0];

    let parsed: RawLLMResponse;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return defaultNeutral("Failed to parse LLM JSON response");
    }

    // Normalize
    const direction = ["long", "short", "neutral"].includes(String(parsed.direction).toLowerCase())
      ? (String(parsed.direction).toLowerCase() as "long" | "short" | "neutral")
      : "neutral";

    const impactScore = Math.max(-10, Math.min(10, Number(parsed.impact_score) || 0));
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    const reasoning = String(parsed.reasoning || "");
    const timeframe = String(parsed.timeframe || "quick");

    // Map to suggested hold
    const suggestedHoldMinutes = timeframe === "quick" ? 15 : 60;
    // Size based on confidence and impact
    const suggestedSizePct = confidence > 0.8 && Math.abs(impactScore) >= 7 ? 0.25
      : confidence > 0.65 && Math.abs(impactScore) >= 5 ? 0.20
      : confidence > 0.5 ? 0.15
      : 0.10;

    return {
      symbol: ticker,
      direction,
      impactScore,
      confidence,
      reasoning,
      suggestedSizePct,
      suggestedHoldMinutes,
    };
  } catch (e: any) {
    console.error("[LLM] Analysis error:", e.message);
    return defaultNeutral(e.message);
  }
}

function defaultNeutral(reason: string) {
  return {
    symbol: "",
    direction: "neutral" as const,
    impactScore: 0,
    confidence: 0,
    reasoning: reason,
    suggestedSizePct: 0,
    suggestedHoldMinutes: 15,
  };
}
