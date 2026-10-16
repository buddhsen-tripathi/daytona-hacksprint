import type {
  ComplaintDraft,
  ComplaintState,
  Evidence,
  FilingAttempt,
  OfficialRequest,
  WorkflowPattern,
} from "@bot/core/contracts";

export type { ComplaintDraft, ComplaintState, Evidence, FilingAttempt, OfficialRequest, WorkflowPattern };
export type { DuplicateCandidate, WorkerEvent, FilingErrorCode, CategoryId } from "@bot/core/contracts";

export type Actor = "user" | "system" | "llm";

/** Mirrors memory-store TransitionRecord; optional in the API response. */
export type Transition = {
  complaintId: string;
  from: ComplaintState;
  to: ComplaintState;
  reason: string;
  actor: Actor;
  at: string;
  /** The bot API emits `ts`; `at` is kept for mock data. */
  ts?: string;
};

export type ComplaintDetail = {
  complaint: ComplaintDraft;
  attempts: FilingAttempt[];
  evidence: Evidence[];
  transitions?: Transition[];
  /** Open Data freshness for duplicate search, if the API exposes it. */
  duplicatesDataAsOf?: string | null;
  /** Phoenix links for the intake conversation (bot API adds these). */
  traceUrl?: string | null;
  sessionUrl?: string | null;
};

export type GraphNode = { id: string; kind: string; label: string };
export type GraphEdge = { from: string; to: string; rel: string };
export type GraphResponse = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  patterns?: WorkflowPattern[];
  workflowPatterns?: WorkflowPattern[];
};

export type Health = {
  ok: boolean;
  telegram: boolean | null;
  store: string | null;
  sandbox: string | null;
  browser: string | null;
  filingTarget: string | null;
  phoenix: string | null;
  classifier: string | null;
};
