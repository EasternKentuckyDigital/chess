import { useCallback, useEffect, useRef, useState } from "react";
import { RecklessEngine } from "../reckless-engine.js";

export function useRecklessEngine(options = {}) {
  const optionsRef = useRef(options);
  const engineRef = useRef(null);
  const analysisIdRef = useRef(0);
  const [ready, setReady] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [lines, setLines] = useState([]);
  const [bestMove, setBestMove] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const engine = new RecklessEngine(optionsRef.current);
    engineRef.current = engine;
    const unsubscribe = engine.onInfo((info) => {
      setLines((current) => {
        const next = new Map(current.map((line) => [line.multiPv, line]));
        next.set(info.multiPv, info);
        return [...next.values()].sort((a, b) => a.multiPv - b.multiPv);
      });
    });

    engine.init().then(
      () => setReady(true),
      (reason) => setError(reason instanceof Error ? reason : new Error(String(reason))),
    );

    return () => {
      unsubscribe();
      engine.terminate();
      engineRef.current = null;
    };
  }, []);

  const analyzeFen = useCallback(async (fen, searchOptions = {}) => {
    const engine = engineRef.current;
    if (!engine) return null;
    const analysisId = ++analysisIdRef.current;
    setAnalyzing(true);
    setLines([]);
    setBestMove(null);
    setError(null);
    try {
      const result = await engine.analyze({ fen, ...searchOptions });
      if (analysisId !== analysisIdRef.current) return null;
      setLines(result.lines);
      setBestMove(result.bestMove);
      return result;
    } catch (reason) {
      if (analysisId === analysisIdRef.current && reason?.name !== "AbortError") {
        setError(reason instanceof Error ? reason : new Error(String(reason)));
      }
      return null;
    } finally {
      if (analysisId === analysisIdRef.current) setAnalyzing(false);
    }
  }, []);

  const stop = useCallback(async () => {
    analysisIdRef.current += 1;
    setAnalyzing(false);
    await engineRef.current?.stop();
  }, []);

  return { ready, analyzing, lines, bestMove, error, analyzeFen, stop };
}
