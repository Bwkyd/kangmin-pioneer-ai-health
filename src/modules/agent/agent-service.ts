import { randomUUID } from "node:crypto";

import { DomainError } from "../../kernel/errors.js";
import type { AgentRepository } from "./agent-repository.js";
import type { AgentRecordSnapshotReader } from "./record-snapshot-reader.js";
import type {
  AgentDecisionEvidence,
  AgentQuestion,
  AgentSession,
  TriStateAnswer
} from "./contracts.js";

const URGENT_HELP_QUESTION: AgentQuestion = {
  key: "urgentHelp",
  prompt: "你是否认为自己现在需要立即获得急救或紧急医疗帮助？",
  answerType: "yes_no_unknown"
};

function now(): string {
  return new Date().toISOString();
}

function decision(
  ruleId: AgentDecisionEvidence["ruleId"],
  answer: TriStateAnswer,
  decidedAt: string
): AgentDecisionEvidence {
  return {
    rulePackVersion: "agent-safety-shell-v1",
    ruleId,
    confirmedFacts: { urgentHelp: answer },
    decidedAt
  };
}

export class AgentService {
  constructor(
    private readonly repository: AgentRepository,
    private readonly recordSnapshotReader: AgentRecordSnapshotReader
  ) {}

  async start(patientId: string): Promise<AgentSession> {
    const timestamp = now();
    const session: AgentSession = {
      id: randomUUID(),
      status: "awaiting_answer",
      revision: 1,
      answers: {},
      nextQuestion: URGENT_HELP_QUESTION,
      outcome: null,
      approvedPlanAvailable: false,
      recordSnapshot: await this.recordSnapshotReader.read(patientId),
      decisionEvidence: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.repository.create(patientId, session);
    return session;
  }

  async continue(
    patientId: string,
    input: {
      id: string;
      expectedRevision: number;
      question: AgentQuestion["key"];
      answer: TriStateAnswer;
    }
  ): Promise<AgentSession> {
    const current = await this.get(patientId, input.id);
    if (current.revision !== input.expectedRevision) {
      throw this.versionConflict(input.expectedRevision, current.revision);
    }
    if (current.status !== "awaiting_answer" || current.nextQuestion === null) {
      throw new DomainError("validation_failed", "Agent 会话已终止，不能继续回答");
    }
    if (input.question !== current.nextQuestion.key) {
      throw new DomainError(
        "validation_failed",
        "回答的问题不是服务端当前要求的下一题",
        { details: { expectedQuestion: current.nextQuestion.key } }
      );
    }

    const timestamp = now();
    const next = this.evaluate(current, input.answer, timestamp);
    const outcome = await this.repository.update(
      patientId,
      input.expectedRevision,
      next
    );
    if (outcome.kind === "not_found") {
      throw new DomainError("resource_not_found", "Agent 会话不存在");
    }
    if (outcome.kind === "version_conflict") {
      throw this.versionConflict(input.expectedRevision, outcome.currentRevision);
    }
    return outcome.session;
  }

  async get(patientId: string, id: string): Promise<AgentSession> {
    const session = await this.repository.find(patientId, id);
    if (session === null) {
      throw new DomainError("resource_not_found", "Agent 会话不存在");
    }
    return session;
  }

  async list(patientId: string): Promise<AgentSession[]> {
    return this.repository.list(patientId);
  }

  private evaluate(
    current: AgentSession,
    answer: TriStateAnswer,
    timestamp: string
  ): AgentSession {
    const common = {
      ...current,
      revision: current.revision + 1,
      answers: { ...current.answers, urgentHelp: answer },
      nextQuestion: null,
      updatedAt: timestamp
    };
    if (answer === "yes") {
      return {
        ...common,
        status: "safety_blocked",
        outcome: "urgent_help_required",
        decisionEvidence: decision("urgent_help_reported", answer, timestamp)
      };
    }
    if (answer === "unknown") {
      return {
        ...common,
        status: "safety_blocked",
        outcome: "cannot_confirm_safety",
        decisionEvidence: decision(
          "urgent_help_unknown_fail_closed",
          answer,
          timestamp
        )
      };
    }
    return {
      ...common,
      status: "completed",
      outcome: "clinical_content_unavailable",
      decisionEvidence: decision(
        "clinical_content_not_approved",
        answer,
        timestamp
      )
    };
  }

  private versionConflict(expected: number, current: number): DomainError {
    return new DomainError("version_conflict", "Agent 会话已更新，请重新读取", {
      details: { expectedRevision: expected, currentRevision: current }
    });
  }
}
