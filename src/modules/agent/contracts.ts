export type TriStateAnswer = "yes" | "no" | "unknown";

export type AgentSessionStatus =
  | "awaiting_answer"
  | "safety_blocked"
  | "completed";

export interface AgentQuestion {
  key: "urgentHelp";
  prompt: string;
  answerType: "yes_no_unknown";
}

export interface AgentRecordSnapshot {
  capturedAt: string;
  recentSymptomDate: string | null;
  lastTnss: number | null;
  recentExposureDate: string | null;
  recentMedicationDate: string | null;
}

export interface AgentDecisionEvidence {
  rulePackVersion: "agent-safety-shell-v1";
  ruleId:
    | "urgent_help_reported"
    | "urgent_help_unknown_fail_closed"
    | "clinical_content_not_approved";
  confirmedFacts: Record<string, TriStateAnswer>;
  decidedAt: string;
}

export interface AgentSession {
  id: string;
  status: AgentSessionStatus;
  revision: number;
  answers: Partial<Record<AgentQuestion["key"], TriStateAnswer>>;
  nextQuestion: AgentQuestion | null;
  outcome:
    | "urgent_help_required"
    | "cannot_confirm_safety"
    | "clinical_content_unavailable"
    | null;
  approvedPlanAvailable: false;
  recordSnapshot: AgentRecordSnapshot;
  decisionEvidence: AgentDecisionEvidence | null;
  createdAt: string;
  updatedAt: string;
}
