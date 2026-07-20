export interface RecklessInfo {
  multiPv: number;
  depth: number;
  selDepth: number;
  scoreCp: number | null;
  mate: number | null;
  nodes: number;
  nps: number;
  timeMs: number;
  pv: string[];
  raw: string;
}

export interface RecklessAnalysisOptions {
  fen?: string;
  movetime?: number;
  depth?: number;
  nodes?: number;
  multiPv?: number;
  searchMoves?: string | string[];
}

export interface RecklessAnalysisResult {
  bestMove: string | null;
  scoreCp: number | null;
  mate: number | null;
  depth: number;
  nodes: number;
  lines: RecklessInfo[];
  fen: string;
}

export interface RecklessDownloadProgress {
  loaded: number;
  total: number | null;
  url: string;
}

export interface RecklessWorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener?(type: "message" | "error", listener: (event: MessageEvent<unknown> | ErrorEvent) => void): void;
  onmessage?: ((event: MessageEvent) => void) | null;
  onerror?: ((event: ErrorEvent) => void) | null;
}

export interface RecklessEngineOptions {
  assetBaseUrl?: string | URL;
  workerUrl?: string | URL;
  glueFile?: string;
  wasmFile?: string;
  wasmParts?: string[];
  workerFactory?: (url: string, options: WorkerOptions) => RecklessWorkerLike;
}

export interface RecklessMoveResult {
  move: string;
  fen: string;
}

export declare class RecklessEngine {
  constructor(options?: RecklessEngineOptions);
  readonly assetBaseUrl: string;
  readonly workerUrl: string;
  init(): Promise<this>;
  setPosition(fen: string): Promise<string>;
  makeMove(uciMove: string): Promise<RecklessMoveResult>;
  analyze(options?: RecklessAnalysisOptions): Promise<RecklessAnalysisResult>;
  stop(): Promise<void>;
  newGame(): Promise<string>;
  getFen(): Promise<string>;
  terminate(): void;
  onInfo(callback: (info: RecklessInfo, event?: unknown) => void): () => boolean;
  onOutput(callback: (line: string, event?: unknown) => void): () => boolean;
  onDownloadProgress(callback: (progress: RecklessDownloadProgress, event?: unknown) => void): () => boolean;
}

export declare const START_FEN: string;
