export type CandidateDecision = "accepted" | "ignored";

export function areCandidateInteractionsLocked(
  extracting: boolean,
  submitting: boolean,
): boolean {
  return extracting || submitting;
}

export function restoreAcceptedValues<Key extends string, Value>(
  current: Partial<Record<Key, Value>>,
  candidateKeys: readonly Key[],
  decisions: Partial<Record<Key, CandidateDecision>>,
  originals: Partial<Record<Key, Value>>,
): Partial<Record<Key, Value>> {
  const restored = { ...current };

  for (const key of candidateKeys) {
    if (decisions[key] !== "accepted") continue;

    const original = originals[key];
    if (original === undefined) {
      delete restored[key];
    } else {
      restored[key] = original;
    }
  }

  return restored;
}

export function captureOriginalValues<Key extends string, Value>(
  candidateKeys: readonly Key[],
  current: Partial<Record<Key, Value>>,
): Partial<Record<Key, Value>> {
  return Object.fromEntries(
    candidateKeys.map((key) => [key, current[key]]),
  ) as Partial<Record<Key, Value>>;
}
