export type TriState = "yes" | "no" | "unknown";

export const RULE_PACKAGE_VERSION = "draft-local-v0";

export const SAFETY_FIELDS = [
  "respiratoryEmergency",
  "persistentHighFever",
  "severeNoseBleed",
  "unilateralFoulDischarge",
  "severeNeurologicalSymptoms",
] as const;

export type SafetyField = (typeof SAFETY_FIELDS)[number];
export type SafetyAnswers = Record<SafetyField, TriState>;

export const SEVERITY_FIELDS = [
  "sleepAffected",
  "activityAffected",
  "workStudyAffected",
  "symptomTroublesome",
] as const;

export type SeverityField = (typeof SEVERITY_FIELDS)[number];
export type SeverityAnswers = Record<SeverityField, TriState>;
export type SeverityCode = "mild" | "moderate_severe";

export const SYNDROME_FIELDS = [
  "thirst",
  "fatigue",
  "limbsNotWarm",
  "fearWind",
  "coldIntolerance",
] as const;

export type SyndromeField = (typeof SYNDROME_FIELDS)[number];
export type SyndromeAnswers = Record<SyndromeField, TriState>;

export type SyndromeCode =
  | "LUNG_HEAT"
  | "LUNG_QI_COLD"
  | "SPLEEN_QI_DEF"
  | "KIDNEY_YANG_DEF"
  | "MIXED_COLD_HEAT";

export interface SyndromeRule {
  id: string;
  syndromeCode: SyndromeCode;
  when: Partial<Record<SyndromeField, Exclude<TriState, "unknown">>>;
}

export const DRAFT_SYNDROME_RULES: readonly SyndromeRule[] = [
  {
    id: "T1",
    syndromeCode: "LUNG_HEAT",
    when: { thirst: "yes" },
  },
  {
    id: "T2",
    syndromeCode: "SPLEEN_QI_DEF",
    when: { fatigue: "yes", thirst: "no" },
  },
  {
    id: "T3",
    syndromeCode: "LUNG_QI_COLD",
    when: {
      fearWind: "yes",
      limbsNotWarm: "no",
      fatigue: "no",
      thirst: "no",
    },
  },
  {
    id: "T4",
    syndromeCode: "KIDNEY_YANG_DEF",
    when: {
      coldIntolerance: "yes",
      limbsNotWarm: "yes",
      fatigue: "no",
      thirst: "no",
    },
  },
  {
    id: "T5",
    syndromeCode: "MIXED_COLD_HEAT",
    when: {
      limbsNotWarm: "yes",
      fatigue: "no",
      thirst: "yes",
    },
  },
] as const;

export type SafetyResult =
  | {
      status: "clear";
      rulePackageVersion: string;
    }
  | {
      status: "blocked";
      matchedRuleIds: string[];
      rulePackageVersion: string;
    }
  | {
      status: "need_more_information";
      nextQuestions: SafetyField[];
      rulePackageVersion: string;
    };

export type SeverityResult =
  | {
      status: "classified";
      severity: SeverityCode;
      ruleId: "SEV-01";
      matchedFacts: Partial<SeverityAnswers>;
      rulePackageVersion: string;
    }
  | {
      status: "need_more_information";
      nextQuestions: SeverityField[];
      rulePackageVersion: string;
    };

export type SyndromeResult =
  | {
      status: "classified";
      syndromeCode: SyndromeCode;
      ruleId: string;
      matchedFacts: Partial<SyndromeAnswers>;
      rulePackageVersion: string;
    }
  | {
      status: "need_more_information";
      candidateSyndromes: SyndromeCode[];
      nextQuestions: SyndromeField[];
      rulePackageVersion: string;
    }
  | {
      status: "conflict";
      candidateSyndromes: SyndromeCode[];
      matchedRuleIds: string[];
      rulePackageVersion: string;
    }
  | {
      status: "no_match";
      rulePackageVersion: string;
    };

export type AssessmentResult =
  | {
      status: "blocked";
      safety: Extract<SafetyResult, { status: "blocked" }>;
      rulePackageVersion: string;
    }
  | {
      status: "referred";
      reason: "not_diagnosed_or_uncertain";
      rulePackageVersion: string;
    }
  | {
      status: "need_more_information";
      stage: "safety" | "severity" | "syndrome";
      nextQuestions: string[];
      rulePackageVersion: string;
    }
  | {
      status: "conflict" | "no_match";
      severity: SeverityCode;
      syndrome: Extract<SyndromeResult, { status: "conflict" | "no_match" }>;
      rulePackageVersion: string;
    }
  | {
      status: "classified";
      severity: SeverityCode;
      syndrome: Extract<SyndromeResult, { status: "classified" }>;
      planStatus: "no_approved_plan";
      rulePackageVersion: string;
    };

export interface AssessmentInput {
  diagnosedAllergicRhinitis: TriState;
  safety: SafetyAnswers;
  severity: SeverityAnswers;
  syndrome: SyndromeAnswers;
}

export function evaluateSafety(answers: SafetyAnswers): SafetyResult {
  const matchedRuleIds = SAFETY_FIELDS
    .filter((field) => answers[field] === "yes")
    .map((field) => `SAFE-${field}`);

  if (matchedRuleIds.length > 0) {
    return {
      status: "blocked",
      matchedRuleIds,
      rulePackageVersion: RULE_PACKAGE_VERSION,
    };
  }

  const nextQuestions = SAFETY_FIELDS.filter((field) => answers[field] === "unknown");
  if (nextQuestions.length > 0) {
    return {
      status: "need_more_information",
      nextQuestions,
      rulePackageVersion: RULE_PACKAGE_VERSION,
    };
  }

  return {
    status: "clear",
    rulePackageVersion: RULE_PACKAGE_VERSION,
  };
}

export function evaluateSeverity(answers: SeverityAnswers): SeverityResult {
  const affectedField = SEVERITY_FIELDS.find((field) => answers[field] === "yes");
  if (affectedField) {
    return {
      status: "classified",
      severity: "moderate_severe",
      ruleId: "SEV-01",
      matchedFacts: { [affectedField]: "yes" },
      rulePackageVersion: RULE_PACKAGE_VERSION,
    };
  }

  const nextQuestions = SEVERITY_FIELDS.filter((field) => answers[field] === "unknown");
  if (nextQuestions.length > 0) {
    return {
      status: "need_more_information",
      nextQuestions,
      rulePackageVersion: RULE_PACKAGE_VERSION,
    };
  }

  return {
    status: "classified",
    severity: "mild",
    ruleId: "SEV-01",
    matchedFacts: Object.fromEntries(
      SEVERITY_FIELDS.map((field) => [field, "no"]),
    ) as SeverityAnswers,
    rulePackageVersion: RULE_PACKAGE_VERSION,
  };
}

function ruleIsCompatible(rule: SyndromeRule, answers: SyndromeAnswers): boolean {
  return Object.entries(rule.when).every(([field, expected]) => {
    const actual = answers[field as SyndromeField];
    return actual === "unknown" || actual === expected;
  });
}

function ruleIsMatched(rule: SyndromeRule, answers: SyndromeAnswers): boolean {
  return Object.entries(rule.when).every(
    ([field, expected]) => answers[field as SyndromeField] === expected,
  );
}

function sortedUnique<T extends string>(items: T[]): T[] {
  return [...new Set(items)].sort();
}

export function evaluateSyndrome(
  answers: SyndromeAnswers,
  rules: readonly SyndromeRule[] = DRAFT_SYNDROME_RULES,
): SyndromeResult {
  const matchedRules = rules.filter((rule) => ruleIsMatched(rule, answers));
  const possibleRules = rules.filter((rule) => ruleIsCompatible(rule, answers));

  if (matchedRules.length > 1) {
    return {
      status: "conflict",
      candidateSyndromes: sortedUnique(
        matchedRules.map((rule) => rule.syndromeCode),
      ),
      matchedRuleIds: sortedUnique(matchedRules.map((rule) => rule.id)),
      rulePackageVersion: RULE_PACKAGE_VERSION,
    };
  }

  const unresolvedRules = possibleRules.filter(
    (rule) => !matchedRules.some((matched) => matched.id === rule.id),
  );

  if (matchedRules.length === 1 && unresolvedRules.length === 0) {
    const matchedRule = matchedRules[0];
    return {
      status: "classified",
      syndromeCode: matchedRule.syndromeCode,
      ruleId: matchedRule.id,
      matchedFacts: Object.fromEntries(
        Object.keys(matchedRule.when).map((field) => [
          field,
          answers[field as SyndromeField],
        ]),
      ) as Partial<SyndromeAnswers>,
      rulePackageVersion: RULE_PACKAGE_VERSION,
    };
  }

  if (possibleRules.length > 0) {
    const nextQuestions = SYNDROME_FIELDS.filter(
      (field) =>
        answers[field] === "unknown" &&
        possibleRules.some((rule) => field in rule.when),
    ).slice(0, 2);

    if (nextQuestions.length > 0) {
      return {
        status: "need_more_information",
        candidateSyndromes: sortedUnique(
          possibleRules.map((rule) => rule.syndromeCode),
        ),
        nextQuestions,
        rulePackageVersion: RULE_PACKAGE_VERSION,
      };
    }
  }

  return {
    status: "no_match",
    rulePackageVersion: RULE_PACKAGE_VERSION,
  };
}

export function evaluateAssessment(input: AssessmentInput): AssessmentResult {
  const safety = evaluateSafety(input.safety);
  if (safety.status === "blocked") {
    return {
      status: "blocked",
      safety,
      rulePackageVersion: RULE_PACKAGE_VERSION,
    };
  }

  if (safety.status === "need_more_information") {
    return {
      status: "need_more_information",
      stage: "safety",
      nextQuestions: safety.nextQuestions,
      rulePackageVersion: RULE_PACKAGE_VERSION,
    };
  }

  if (input.diagnosedAllergicRhinitis !== "yes") {
    return {
      status: "referred",
      reason: "not_diagnosed_or_uncertain",
      rulePackageVersion: RULE_PACKAGE_VERSION,
    };
  }

  const severity = evaluateSeverity(input.severity);
  if (severity.status === "need_more_information") {
    return {
      status: "need_more_information",
      stage: "severity",
      nextQuestions: severity.nextQuestions,
      rulePackageVersion: RULE_PACKAGE_VERSION,
    };
  }

  const syndrome = evaluateSyndrome(input.syndrome);
  if (syndrome.status === "need_more_information") {
    return {
      status: "need_more_information",
      stage: "syndrome",
      nextQuestions: syndrome.nextQuestions,
      rulePackageVersion: RULE_PACKAGE_VERSION,
    };
  }

  if (syndrome.status === "conflict" || syndrome.status === "no_match") {
    return {
      status: syndrome.status,
      severity: severity.severity,
      syndrome,
      rulePackageVersion: RULE_PACKAGE_VERSION,
    };
  }

  return {
    status: "classified",
    severity: severity.severity,
    syndrome,
    planStatus: "no_approved_plan",
    rulePackageVersion: RULE_PACKAGE_VERSION,
  };
}
