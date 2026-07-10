/**
 * Test the strategist retrospective in isolation using Pi data
 * Run: STRATEGIES_DB_PATH=data/strategies.pi.db npx tsx scripts/test-strategist-retro.ts
 */
import { config } from "dotenv";
config();

import { analyzeStrategistPerformance, extractPatternsFromWhatIf } from "../src/retrospective/strategist-retrospective.js";
import { StrategyStore } from "../src/state/strategies.js";

async function main() {
  const strategies = new StrategyStore("data/strategies.pi.db");
  
  // Get the what-if data that was already computed
  // We need to reconstruct it from the DB
  const whatIf = getWhatIfFromDb(strategies, "2026-07-09");
  
  const patterns = whatIf ? extractPatternsFromWhatIf(whatIf) : [];
  const existingLessons = strategies.getStrategistLessons(true);
  const stateCounts = strategies.getStateCounts();
  
  console.log("What-If strategies:", whatIf?.totalStrategiesAnalyzed ?? 0);
  console.log("Patterns found:", patterns.length);
  for (const p of patterns) console.log("  [x" + p.count + "] " + p.pattern + " avg G" + p.avgGrade + " (" + p.direction + ")");
  console.log("Existing strategist lessons:", existingLessons.length);
  console.log("State counts:", JSON.stringify(stateCounts));
  
  console.log("\nRunning strategist retrospective...");
  const result = await analyzeStrategistPerformance({
    date: "2026-07-09",
    whatIfAnalysis: whatIf,
    totalStrategiesCreated: strategies.getTotalCount(),
    strategyStateCounts: stateCounts,
    patterns,
    existingStrategistLessons: existingLessons,
    marketRegime: "chop",
  });
  
  console.log("\n=== STRATEGIST ANALYSIS ===");
  console.log("\n--- Overview ---");
  console.log(result.analysis.overview);
  console.log("\n--- Signal Source Quality ---");
  console.log(result.analysis.signalSourceQuality.slice(0, 500));
  console.log("\n--- Strategy × Regime Fit ---");
  console.log(result.analysis.strategyRegimeFit.slice(0, 500));
  console.log("\n--- Lifecycle Management ---");
  console.log(result.analysis.lifecycleManagement.slice(0, 500));
  console.log("\n--- Catalyst Assessment ---");
  console.log(result.analysis.catalystAssessment.slice(0, 500));
  
  console.log("\n=== EVOLVED STRATEGIST LESSONS ===");
  const active = result.evolvedLessons.filter(l => !l.deprecated);
  console.log("Active:", active.length);
  for (const l of active) {
    console.log("  [" + l.category + "] w:" + l.weight.toFixed(2) + " r:" + l.reinforcementCount + "x");
    console.log("    " + l.insight);
  }
  
  strategies.close();
  process.exit(0);
}

function getWhatIfFromDb(strategies: any, date: string) {
  // We need to find how to reconstruct the WhatIfAnalysis from the DB
  // StrategyStore doesn't have getWhatIfForDate yet - let me check
  // For now, try to get strategies with what-if data
  try {
    // Use getStrategiesForDay (which filters by updated_at on date)
    const dayStrategies = strategies.getStrategiesForDay(date);
    const graded = dayStrategies.filter((s: any) => s.what_if);
    
    if (graded.length === 0) {
      console.log("No what-if data for", date, "- looking for any graded strategies");
      return null;
    }
    
    const gradeDist: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    let totalPnl = 0;
    for (const s of graded) {
      const g = s.what_if.grade;
      gradeDist[String(g)] = (gradeDist[String(g)] || 0) + 1;
      totalPnl += s.what_if.potentialGainLoss || 0;
    }
    
    return {
      date,
      totalStrategiesAnalyzed: graded.length,
      gradeDistribution: gradeDist,
      totalHypotheticalPnL: totalPnl,
      bestStrategy: graded.reduce((best: any, s: any) => 
        (!best || (s.what_if.potentialGainLoss || 0) > best.potentialGainLoss) 
          ? { ticker: s.ticker, grade: s.what_if.grade, potentialGainLoss: s.what_if.potentialGainLoss || 0, abstraction: s.what_if.abstraction } 
          : best, null),
      worstStrategy: graded.reduce((worst: any, s: any) => 
        (!worst || (s.what_if.potentialGainLoss || 0) < worst.potentialGainLoss) 
          ? { ticker: s.ticker, grade: s.what_if.grade, potentialGainLoss: s.what_if.potentialGainLoss || 0, abstraction: s.what_if.abstraction } 
          : worst, null),
      strategies: graded.map((s: any) => ({
        ticker: s.ticker,
        strategy_type: s.strategy_type,
        direction: s.direction,
        state: s.state,
        grade: s.what_if.grade,
        potentialGainLoss: s.what_if.potentialGainLoss || 0,
        potentialGainLossPct: s.what_if.potentialGainLossPct || 0,
        abstraction: s.what_if.abstraction || "",
        gradeRationale: s.what_if.gradeRationale || "",
      })),
    };
  } catch (e: any) {
    console.log("Error reconstructing what-if:", e.message);
    return null;
  }
}

main().catch(e => { console.error(e); process.exit(1); });