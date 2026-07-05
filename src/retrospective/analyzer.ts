/**
 * LLM-powered analysis for the daily retrospective.
 *
 * Sends the day's raw trade data, equity curve, lessons, and calibration table
 * to OpenRouter and asks it to produce the three prose sections:
 *   - What Worked Well
 *   - What Didn't Work Well
 *   - What to Do Differently
 *
 * All analysis is anchored to the goal: **grow the account fast**.
 */

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

interface RetrospectiveAnalysis {
  whatWorked: string;
  whatDidnt: string;
  whatToChange: string;
}

/**
 * Analyze a full day of trading data and produce structured retrospective prose.
 */
export async function analyzeDay(
  data: RetrospectiveDataBundle
): Promise<RetrospectiveAnalysis> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn("[RETRO] No OPENROUTER_API_KEY — falling back to template report");
    return fallbackAnalysis(data);
  }

  const model = process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash-lite";

  const systemPrompt = `You are the performance analyst for Scrooge, an autonomous AI trading bot. Your job is to tell the truth about how it performed — no sugar-coating, no excuses.

You evaluate based on what the bot's LLM ACTUALLY did, not just the P&L numbers. A flat day with zero trades where the bot spent all day analyzing and never pulling the trigger IS a failure. A losing trade where the bot correctly identified a catalyst but got stopped out on normal volatility IS NOT a failure — it's process working correctly.

Key questions you always ask:
1. **Did the LLM execute or just analyze?** If the bot spent multiple cycles scanning, looking at the same data, and never committing, that's analysis paralysis. Call it out.
2. **Was the thesis right even if the trade lost?** A correct catalyst thesis that got stopped out on a normal retracement is GOOD process. A trade that went against the market regime is BAD process regardless of P&L.
3. **Did infrastructure failures stall the bot?** If an API error caused the LLM to spin its wheels retrying or pivoting poorly, flag it. The bot needs fallback plays.
4. **Was cash deployed with intent?** Cash is not inherently bad. Buying SPY just to be invested is dumb. Was the cash held for a specific reason (waiting for a setup) or was it idle because the bot froze?
5. **Did the bot learn from failures or repeat them?** Same mistake two days in a row? That's a memory/lesson problem.
6. **Regime match**: Was the strategy appropriate for the market conditions? Mean reversion in a strong trend is wrong. Trend-following in chop is wrong.
7. **Opportunity cost**: What did the bot NOT do that it should have? Especially when a clear catalyst thesis existed.

Be direct. Use specific examples from the data. No corporate speak. No fluff. If the bot did nothing useful, say it.

Respond ONLY with valid JSON in this exact format:
{
  "whatWorked": "Markdown prose (2-4 paragraphs describing what actually went right — process, not just P&L",
  "whatDidnt": "Markdown prose (2-4 paragraphs describing what went wrong and WHY — be specific about LLM behavior, not just outcomes",
  "whatToChange": "Markdown prose with 2-4 specific, actionable changes. Include implementation approach (hard-code rule, prompt change, lesson update, tool change)"
}`;

  const userPrompt = buildAnalysisPrompt(data);

  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://scrooge-trading-bot.local",
        "X-Title": "Scrooge Daily Retrospective",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 2048,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`[RETRO] OpenRouter error: ${res.status} ${text.slice(0, 200)}`);
      return fallbackAnalysis(data);
    }

    const raw = await res.json();
    const content: string = raw.choices?.[0]?.message?.content || "";

    // Extract JSON from potential markdown fences
    let cleaned = content.replace(/```json\s*|```\s*/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) cleaned = match[0];

    const parsed = JSON.parse(cleaned) as RetrospectiveAnalysis;

    return {
      whatWorked: parsed.whatWorked || fallbackWhatWorked(data),
      whatDidnt: parsed.whatDidnt || fallbackWhatDidnt(data),
      whatToChange: parsed.whatToChange || fallbackWhatToChange(data),
    };
  } catch (e: any) {
    console.warn(`[RETRO] LLM analysis failed: ${e.message}`);
    return fallbackAnalysis(data);
  }
}

// ─── Prompt Builder ────────────────────────────────────────────────────────

interface RetrospectiveDataBundle {
  date: string;
  tradeCount: number;
  trades: Array<{
    symbol: string;
    strategy: string;
    pnl: number;
    pnlPct: number;
    entryPrice: number;
    exitPrice: number;
    exitReason: string;
    holdMinutes: number;
    wasPromoted: boolean;
    signalSource: string;
    signalConfidence: number;
    signalImpactScore: number;
    agentReasoning: string;
  }>;
  wins: number;
  losses: number;
  winRate: number;
  grossPnL: number;
  startingEquity: number;
  endingEquity: number;
  totalEquityChange: number;
  tokenCost: number;
  netPnL: number;
  lessons: string[];
  calibrationTable: Array<{
    strategy: string;
    regime: string;
    winRate: number;
    totalTrades: number;
    avgWinPct: number;
    avgLossPct: number;
  }>;
  equityCurve: string;
  marketRegimes: string[];
  contextNotes: string[];
}

function buildAnalysisPrompt(data: RetrospectiveDataBundle): string {
  const lines: string[] = [
    `## Daily Retrospective Data — ${data.date}`,
    ``,
    `### Overview`,
    `- Trades executed: ${data.tradeCount}`,
    `- Wins: ${data.wins} | Losses: ${data.losses}`,
    `- Win Rate: ${data.winRate.toFixed(1)}%`,
    `- Gross P&L: $${data.grossPnL.toFixed(2)}`,
    `- Token Cost: $${data.tokenCost.toFixed(5)}`,
    `- Net P&L: $${data.netPnL.toFixed(2)}`,
    `- Starting Equity: $${data.startingEquity.toFixed(2)}`,
    `- Ending Equity: $${data.endingEquity.toFixed(2)}`,
    `- Total Equity Change: $${data.totalEquityChange.toFixed(2)}`,
    `- Market Regimes Seen: ${data.marketRegimes.join(", ") || "unknown"}`,
    ``,
    `### Equity Curve (sampled)`,
    data.equityCurve || "No snapshots available",
    ``,
  ];

  // Individual trades
  if (data.trades.length > 0) {
    lines.push(`### Trades`);
    for (const t of data.trades) {
      const emoji = t.pnl >= 0 ? "✅" : "❌";
      lines.push(
        `${emoji} [${t.symbol}] ${t.strategy} | P&L: $${t.pnl.toFixed(2)} (${t.pnlPct.toFixed(2)}%) | ` +
        `Entry: $${t.entryPrice.toFixed(2)} → Exit: $${t.exitPrice.toFixed(2)} | ` +
        `Held: ${t.holdMinutes}min | Exit: ${t.exitReason} | ` +
        `Signal: ${t.signalSource} (conf: ${(t.signalConfidence * 100).toFixed(0)}%, impact: ${t.signalImpactScore}/10)`
      );
      if (t.agentReasoning) {
        lines.push(`  Reasoning: ${t.agentReasoning.slice(0, 200)}`);
      }
    }
    lines.push(``);
  }

  // Context notes (what the agent was tracking)
  if (data.contextNotes.length > 0) {
    lines.push(`### Context Notes (What the Agent Was Tracking)`);
    for (const n of data.contextNotes) {
      lines.push(`- ${n}`);
    }
    lines.push(``);
  }

  // Lessons already stored
  if (data.lessons.length > 0) {
    lines.push(`### Previously Stored Lessons`);
    for (const l of data.lessons.slice(-10)) {
      lines.push(`- ${l}`);
    }
    lines.push(``);
  }

  // Strategy calibration
  if (data.calibrationTable.length > 0) {
    lines.push(`### Strategy × Regime Calibration (Historical)`);
    for (const c of data.calibrationTable) {
      lines.push(
        `- ${c.strategy} in ${c.regime}: ${(c.winRate * 100).toFixed(0)}% WR (${c.totalTrades} trades, ` +
        `avg win ${(c.avgWinPct * 100).toFixed(1)}%, avg loss ${(c.avgLossPct * 100).toFixed(1)}%)`
      );
    }
    lines.push(``);
  }

  lines.push(
    `---`,
    ``,
    `Now analyze this day with the goal of growing the account fast. Be direct and critical.`,
    `Consider: risk level, research scope, assumptions, trend-chasing, long-term vs short-term plays,`,
    `timing of entries/exits, conviction, missed opportunities, and whether cash was deployed enough.`,
  );

  return lines.join("\n");
}

// ─── Fallback generators (when LLM is unavailable) ──────────────────────────

function fallbackAnalysis(data: RetrospectiveDataBundle): RetrospectiveAnalysis {
  return {
    whatWorked: fallbackWhatWorked(data),
    whatDidnt: fallbackWhatDidnt(data),
    whatToChange: fallbackWhatToChange(data),
  };
}

function fallbackWhatWorked(data: RetrospectiveDataBundle): string {
  const parts: string[] = [];

  if (data.winRate > 60) {
    parts.push(`**Win rate was strong at ${data.winRate.toFixed(0)}%** — the agent showed good discretion on which setups to take.`);
  }
  if (data.grossPnL > 0) {
    parts.push(`**The day finished positive with a gross P&L of $${data.grossPnL.toFixed(2)}**, meaning overall the agent's directional bets were correct more often than not.`);
  }
  if (data.tradeCount > 0) {
    const winners = data.trades.filter((t) => t.pnl > 0);
    if (winners.length > 0) {
      const bestTrade = winners.reduce((a, b) => (a.pnl > b.pnl ? a : b));
      parts.push(`**Best trade: ${bestTrade.symbol}** ($${bestTrade.pnl.toFixed(2)}, +${bestTrade.pnlPct.toFixed(2)}%) using ${bestTrade.strategy} strategy — this represents the type of setup the agent should look for more of.`);
    }
  }
  if (data.lessons.length > 0) {
    parts.push(`The agent had **${data.lessons.length} stored lessons** from prior reflection cycles that informed today's decisions.`);
  }
  if (data.tokenCost < 0.01) {
    parts.push(`**Token costs were low** ($${data.tokenCost.toFixed(5)}) — the agent operated efficiently without excessive LLM overhead.`);
  }

  if (parts.length === 0) {
    parts.push(`No trades were executed today. The agent held cash, which is a valid decision if no clear edge was identified. However, cash doesn't compound — the bar for taking a trade should be low enough to deploy capital regularly.`);
  }

  return parts.join("\n\n");
}

function fallbackWhatDidnt(data: RetrospectiveDataBundle): string {
  const parts: string[] = [];

  if (data.tradeCount === 0) {
    parts.push(`**Zero trades executed today.** While discretion is good, the agent needs to find more opportunities. Cash doesn't compound. The agent should be asking: did I look hard enough? Did I check all data sources? Did I miss obvious setups?`);
  }

  if (data.winRate < 50 && data.tradeCount >= 3) {
    parts.push(`**Win rate was ${data.winRate.toFixed(0)}%** — the agent lost more trades than it won. This suggests either poor signal selection, wrong regime fit, or bad timing.`);
  }

  if (data.netPnL < 0) {
    parts.push(`**Net P&L was negative at $${data.netPnL.toFixed(2)}** — the combination of trade losses and token costs resulted in account drawdown. Every losing day needs root-cause analysis.`);
  }

  const losers = data.trades.filter((t) => t.pnl < 0);
  const bigLosers = losers.filter((t) => t.pnl <= -5);
  if (bigLosers.length > 0) {
    for (const l of bigLosers.slice(0, 3)) {
      parts.push(`**Big loss on ${l.symbol}**: -$${Math.abs(l.pnl).toFixed(2)} (${l.pnlPct.toFixed(2)}%). ${l.exitReason !== "stop_loss" ? "This loss was NOT a stop-loss exit — the stop may have been too loose or absent." : "The stop-loss did its job and cut the loss."}`);
    }
  }

  if (data.totalEquityChange < 0) {
    parts.push(`**Account equity declined by $${Math.abs(data.totalEquityChange).toFixed(2)} today.** The primary goal is to grow the account fast, so a red day is a failure toward that objective.`);
  }

  // Check if winners were cut too early
  const winnersCutEarly = data.trades.filter((t) => t.pnl > 0 && t.pnlPct < 1.0 && t.wasPromoted === false);
  if (winnersCutEarly.length > 0) {
    parts.push(`**${winnersCutEarly.length} winning trade(s) were closed before hitting the green threshold** (+1%). These were small winners that could have become larger if given more room. The agent may be exiting too early.`);
  }

  if (parts.length === 0) {
    parts.push(`No major issues identified from the raw data. The LLM analysis would provide deeper insight into qualitative factors like market context fit, research thoroughness, and conviction levels.`);
  }

  return parts.join("\n\n");
}

function fallbackWhatToChange(data: RetrospectiveDataBundle): string {
  const recommendations: string[] = [];

  if (data.tradeCount === 0) {
    recommendations.push("**Trade more aggressively.** Set a minimum of 1-2 trades per day. Review all data sources (news, EDGAR, volume, gaps, Yahoo movers) before concluding there's nothing to trade.");
    recommendations.push("**Lower the bar for entry.** If no trade meets the confidence + impact threshold, consider reducing position size rather than skipping entirely. Small, frequent bets compound.");
  }

  if (data.winRate < 50 && data.tradeCount >= 3) {
    recommendations.push("**Improve signal quality.** A win rate below 50% means either the strategies don't fit the current regime or the execution is poor. Check if today's regime matched the strategies used.");
  }

  if (data.netPnL < 0 && data.tokenCost > 0.02) {
    recommendations.push("**Reduce token costs.** The LLM cost ($${data.tokenCost.toFixed(3)}) exceeded the value generated. Use cheaper models for preliminary screening and only use expensive models for high-conviction setups.");
  }

  // Check if mostly one strategy was used
  const strategies = new Set(data.trades.map((t) => t.strategy));
  if (strategies.size <= 1 && data.tradeCount >= 3) {
    recommendations.push("**Diversify strategies.** All today's trades used only one approach. Different regimes reward different strategies. Use the full toolkit: news momentum, mean reversion, EDGAR catalysts, volume breakouts.");
  }

  const hasHeldPositions = data.trades.some((t) => t.holdMinutes > 60);
  if (!hasHeldPositions && data.tradeCount > 0) {
    recommendations.push("**Let winners run.** All trades were short-duration (under 1 hour). Consider holding strong positions longer to capture larger moves. The trailing stop mechanism is designed for this.");
  }

  if (data.totalEquityChange > 0 && data.tradeCount < 3) {
    recommendations.push("**Scale up.** The day was profitable but with limited activity. Increase trade frequency to compound faster. More trades = more data = faster learning.");
  }

  if (recommendations.length === 0) {
    recommendations.push("**Continue with current approach** — monitor for regime changes that might require strategy adjustments.");
    recommendations.push("**Increase position sizing** if win rate stays above 60% over the next few days. Compounding works faster with larger bets when the edge is proven.");
  }

  return recommendations.map((r) => `- ${r}`).join("\n");
}