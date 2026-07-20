export const PROMOTION_CHOICES = Object.freeze([
  { value: "q", label: "Queen" },
  { value: "r", label: "Rook" },
  { value: "b", label: "Bishop" },
  { value: "n", label: "Knight" },
]);

export function normalizePromotion(value) {
  const promotion = String(value || "").toLowerCase();
  return PROMOTION_CHOICES.some(choice => choice.value === promotion) ? promotion : "q";
}

export function selectPromotionMove(moves, to, requested = "q") {
  const candidates = (Array.isArray(moves) ? moves : []).filter(move => move.to === to);
  if (!candidates.length) return null;
  if (!candidates.some(move => move.promotion)) return candidates[0];
  const promotion = normalizePromotion(requested);
  return candidates.find(move => move.promotion === promotion)
    || candidates.find(move => move.promotion === "q")
    || candidates[0];
}
