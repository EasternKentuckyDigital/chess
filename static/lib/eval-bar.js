import { sideToMoveFactor, whitePerspectiveScore } from "./engine-score.js";

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function evaluationBarState(result, fen, flipped = false) {
  if (!result || !fen) return { active: false, flipped, whiteShare: 50, label: "—", advantage: "equal" };
  const mate = result.mate === null || result.mate === undefined ? null : Number(result.mate) * sideToMoveFactor(fen);
  const whiteScore = whitePerspectiveScore(result, fen);
  const whiteShare = mate
    ? (mate > 0 ? 97 : 3)
    : clamp(50 + 47 * Math.tanh(whiteScore / 500), 3, 97);
  const label = mate
    ? `${mate > 0 ? "+" : "−"}M${Math.abs(mate)}`
    : `${whiteScore >= 0 ? "+" : "−"}${Math.abs(whiteScore / 100).toFixed(1)}`;
  return {
    active: true,
    flipped,
    whiteShare,
    label,
    advantage: whiteScore > 20 ? "white" : whiteScore < -20 ? "black" : "equal",
  };
}

export function renderEvaluationBar(element, result, fen, flipped = false) {
  if (!element) return evaluationBarState(result, fen, flipped);
  const state = evaluationBarState(result, fen, flipped);
  element.style.setProperty("--white-share", `${state.whiteShare}%`);
  element.classList.toggle("active", state.active);
  element.classList.toggle("flipped", state.flipped);
  element.classList.toggle("white-ahead", state.advantage === "white");
  element.classList.toggle("black-ahead", state.advantage === "black");
  element.classList.toggle("equal", state.advantage === "equal");
  const label = element.querySelector(".eval-bar-label");
  if (label) label.textContent = state.label;
  element.setAttribute("aria-valuenow", String(Math.round(state.whiteShare)));
  element.setAttribute("aria-valuetext", state.active ? `${state.label}, White perspective` : "Evaluation unavailable");
  return state;
}
