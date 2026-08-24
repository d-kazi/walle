import type { Repos } from '../db/repos.js';

/**
 * Automated suggestions to improve the model setup. Aggregates a week of
 * llm_call telemetry into short advisory lines for Dan's Sunday rollup.
 * Suggestions only — switching models stays a manual env change.
 */
export function modelSuggestions(repos: Repos, fromTs: string): string[] {
  const stats = repos.llmStats(fromTs);
  const out: string[] = [];
  let totalCost = 0;

  for (const s of stats) {
    totalCost += s.costUsd;
    const failRate = s.calls > 0 ? s.failures / s.calls : 0;
    const retryRate = s.calls > 0 ? s.schemaRetries / s.calls : 0;
    if (s.calls >= 5 && failRate > 0.1) {
      out.push(
        `${s.task} failed ${s.failures}/${s.calls} calls on ${s.model} this week. Worth trying a stronger model for that task (WALLE_MODEL_ESCALATED).`,
      );
    } else if (s.calls >= 5 && retryRate > 0.25) {
      out.push(
        `${s.task} needed schema retries on ${Math.round(retryRate * 100)}% of calls on ${s.model}. The prompt's output format may need tightening, or a stronger model.`,
      );
    }
    if (s.calls >= 5 && s.p50LatencyMs > 20000) {
      out.push(`${s.task} is slow (median ${Math.round(s.p50LatencyMs / 1000)}s on ${s.model}). A faster model would sharpen replies.`);
    }
  }

  if (totalCost > 0) {
    out.push(`Model spend this week: about $${totalCost.toFixed(2)}.`);
  }
  return out.slice(0, 4);
}
