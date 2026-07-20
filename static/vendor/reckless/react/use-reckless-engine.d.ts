import type { RecklessAnalysisOptions, RecklessAnalysisResult, RecklessEngineOptions, RecklessInfo } from "../reckless-engine.js";

export interface UseRecklessEngineResult {
  ready: boolean;
  analyzing: boolean;
  lines: RecklessInfo[];
  bestMove: string | null;
  error: Error | null;
  analyzeFen(fen: string, options?: Omit<RecklessAnalysisOptions, "fen">): Promise<RecklessAnalysisResult | null>;
  stop(): Promise<void>;
}

export declare function useRecklessEngine(options?: RecklessEngineOptions): UseRecklessEngineResult;
