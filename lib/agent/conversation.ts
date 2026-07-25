export type TriState = "yes" | "no" | "unknown";

export const SAFETY_QUESTION_KEYS = [
  "respiratoryEmergency",
  "persistentHighFever",
  "facialSwelling",
  "severeNoseBleed",
  "unilateralFoulDischarge",
  "severeNeurologicalSymptoms",
] as const;

export const SEVERITY_QUESTION_KEYS = [
  "sleepAffected",
  "activityAffected",
  "workStudyAffected",
  "symptomTroublesome",
] as const;

export const SYNDROME_QUESTION_KEYS = [
  "thirst",
  "fatigue",
  "limbsNotWarm",
  "fearWind",
  "coldIntolerance",
] as const;

export const QUESTION_KEYS = [
  ...SAFETY_QUESTION_KEYS,
  "diagnosedAllergicRhinitis",
  ...SEVERITY_QUESTION_KEYS,
  ...SYNDROME_QUESTION_KEYS,
] as const;

export type QuestionKey = (typeof QUESTION_KEYS)[number];
export type AnswerMap = Partial<Record<QuestionKey, TriState>>;

export const FIRST_QUESTION_KEY: QuestionKey = SAFETY_QUESTION_KEYS[0];

interface NavigationAssessment {
  status:
    | "classified"
    | "blocked"
    | "conflict"
    | "no_match"
    | "need_more_information"
    | "referred";
  nextQuestions?: string[];
}

function answerGroup(
  answers: AnswerMap,
  keys: readonly QuestionKey[],
): Record<string, TriState> {
  return Object.fromEntries(
    keys.map((key) => [key, answers[key] ?? "unknown"]),
  );
}

export function createAssessmentPayload(answers: AnswerMap) {
  return {
    diagnosedAllergicRhinitis:
      answers.diagnosedAllergicRhinitis ?? "unknown",
    safety: answerGroup(answers, SAFETY_QUESTION_KEYS),
    severity: answerGroup(answers, SEVERITY_QUESTION_KEYS),
    syndrome: answerGroup(answers, SYNDROME_QUESTION_KEYS),
  };
}

function isQuestionKey(value: string): value is QuestionKey {
  return (QUESTION_KEYS as readonly string[]).includes(value);
}

export function findNextQuestion(
  assessment: NavigationAssessment,
  answers: AnswerMap,
): QuestionKey | null {
  return (
    assessment.nextQuestions?.find(
      (question): question is QuestionKey =>
        isQuestionKey(question) && answers[question] === undefined,
    ) ?? null
  );
}
