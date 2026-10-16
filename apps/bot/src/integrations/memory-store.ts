/**
 * In-memory Store. Fully implements the Store contract; used by tests, the
 * scripted runner, and as the fallback when SurrealDB can't initialize.
 */
import type {
  CatalogEntry,
  CategoryId,
  ComplaintDraft,
  ComplaintLocation,
  ComplaintState,
  DuplicateCandidate,
  FilingAttempt,
  FilingTarget,
  MemoryRecord,
  OfficialRequest,
  RepairProposal,
  Resident,
  Store,
  WorkflowPattern,
} from "../core/contracts.js";
import { nowIso, shortId } from "../core/contracts.js";
import { filterRelated } from "../services/memory.js";
import { memoryMatches, searchMemoryRows } from "../services/agent-memory.js";

const TERMINAL: ComplaintState[] = ["CANCELLED", "EMERGENCY_REFERRAL", "OUT_OF_SCOPE", "TRACKING", "SUBMITTED"];

export type TransitionRecord = { complaintId: string; from: ComplaintState; to: ComplaintState; reason: string; actor: "user" | "system" | "llm"; at: string };

const clone = <T>(v: T): T => structuredClone(v);

export type MemoryStore = Store & {
  transitions: TransitionRecord[];
  listTransitions(complaintId: string): Promise<TransitionRecord[]>;
  /** Same contract as SurrealStore's (#7/#28): upsert by id (merge), list everything. */
  upsertCatalog(entries: CatalogEntry[]): Promise<number>;
  listCatalog(): Promise<CatalogEntry[]>;
};

export function createMemoryStore(): MemoryStore {
  const residents = new Map<string, Resident>(); // by id
  const residentByChat = new Map<string, string>();
  const complaints = new Map<string, ComplaintDraft>();
  const attempts = new Map<string, FilingAttempt>();
  const officialRequests = new Map<string, OfficialRequest>();
  const locations = new Map<string, ComplaintLocation>();
  const complaintLocation = new Map<string, string>();
  const duplicateLinks = new Map<string, DuplicateCandidate[]>();
  const processed = new Set<string>();
  const patterns: WorkflowPattern[] = [];
  const transitions: TransitionRecord[] = [];
  const similar = new Map<string, Set<string>>();
  /** #5: supporter id → original id (complaint->same_issue_as->complaint), insertion order = oldest first. */
  const sameIssue = new Map<string, string>();
  /** #5: complaint id → ids it is not the same as (complaint->not_same_as->complaint). */
  const notSame = new Map<string, Set<string>>();
  const joinedTo = (originalId: string) => [...sameIssue.entries()].filter(([, o]) => o === originalId).map(([s]) => s);
  const memories = new Map<string, MemoryRecord>();
  const catalog = new Map<string, CatalogEntry>();
  const repairs = new Map<string, RepairProposal>();
  const learnedSchemas = new Map<string, Pick<CatalogEntry, "requiredFields" | "formSchema">>();

  const store: MemoryStore = {
    backend: "memory",
    transitions,
    async listTransitions(complaintId) {
      return clone(transitions.filter((t) => t.complaintId === complaintId));
    },
    async init() {},

    async getOrCreateResident(chatId, username) {
      const existing = residentByChat.get(chatId);
      if (existing) {
        const r = residents.get(existing)!;
        if (username && r.telegramUsername !== username) {
          r.telegramUsername = username;
        }
        return clone(r);
      }
      const r: Resident = {
        id: shortId("res"),
        telegramChatId: chatId,
        telegramUsername: username,
        preferredLanguage: null,
        contactName: null,
        contactEmail: null,
        createdAt: nowIso(),
      };
      residents.set(r.id, r);
      residentByChat.set(chatId, r.id);
      return clone(r);
    },
    async updateResident(id, patch) {
      const r = residents.get(id);
      if (!r) throw new Error(`resident ${id} not found`);
      const next = { ...r, ...patch, id: r.id };
      residents.set(id, next);
      return clone(next);
    },

    async createComplaint(c) {
      complaints.set(c.id, clone(c));
      return clone(c);
    },
    async saveComplaint(c) {
      // #5: `supporters` is derived from same_issue_as edges (a stale copy of the original never resets it)
      const n = joinedTo(c.id).length;
      if (n > 0) c = { ...c, supporters: n };
      complaints.set(c.id, clone(c));
      if (c.location.source !== "none") {
        const locId = await store.upsertLocation(c.location);
        if (locId) complaintLocation.set(c.id, locId);
      }
      return clone(c);
    },
    async getComplaint(id) {
      const c = complaints.get(id);
      return c ? clone(c) : null;
    },
    async getActiveComplaint(chatId) {
      const list = [...complaints.values()]
        .filter((c) => c.telegramChatId === chatId && !TERMINAL.includes(c.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return list[0] ? clone(list[0]) : null;
    },
    async listComplaints(args) {
      let list = [...complaints.values()];
      if (args?.chatId) list = list.filter((c) => c.telegramChatId === args.chatId);
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return clone(list.slice(0, args?.limit ?? 100));
    },
    async recordTransition(complaintId, from, to, reason, actor) {
      transitions.push({ complaintId, from, to, reason, actor, at: nowIso() });
    },

    async upsertLocation(loc) {
      if (loc.latitude == null && !loc.address) return null;
      const key = loc.latitude != null ? `${loc.latitude.toFixed(5)},${loc.longitude?.toFixed(5)}` : (loc.address ?? "").toLowerCase();
      const id = `loc_${key.replace(/[^a-z0-9]+/gi, "_")}`;
      locations.set(id, clone(loc));
      return id;
    },
    async linkDuplicates(complaintId, candidates) {
      duplicateLinks.set(complaintId, clone(candidates));
    },

    async createAttempt(a) {
      attempts.set(a.id, clone(a));
      return clone(a);
    },
    async saveAttempt(a) {
      attempts.set(a.id, clone(a));
      return clone(a);
    },
    async getAttempt(id) {
      const a = attempts.get(id);
      return a ? clone(a) : null;
    },
    async listAttempts(args) {
      let list = [...attempts.values()];
      if (args?.complaintId) list = list.filter((a) => a.complaintId === args.complaintId);
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return clone(list.slice(0, args?.limit ?? 100));
    },
    async saveOfficialRequest(r) {
      // Upsert by officialRequestNumber: one record per SR regardless of who saves it.
      const existing = [...officialRequests.values()].find((x) => x.officialRequestNumber === r.officialRequestNumber && x.id !== r.id);
      const next = existing ? { ...existing, ...r, id: existing.id } : r;
      officialRequests.set(next.id, clone(next));
      return clone(next);
    },
    async listOfficialRequests(chatId) {
      const ids = new Set([...complaints.values()].filter((c) => !chatId || c.telegramChatId === chatId).map((c) => c.id));
      return clone([...officialRequests.values()].filter((r) => ids.has(r.complaintId)));
    },

    async markUpdateProcessed(updateId) {
      if (processed.has(updateId)) return false;
      processed.add(updateId);
      return true;
    },

    async recordWorkflowPattern(p) {
      // Upsert by id (ask-before-approval patterns are re-recorded with an incremented count).
      const i = patterns.findIndex((x) => x.id === p.id);
      if (i >= 0) patterns[i] = clone(p);
      else patterns.push(clone(p));
    },
    async findRelatedComplaints(q) {
      return clone(filterRelated([...complaints.values()], q));
    },
    async linkSimilarComplaints(complaintId, similarIds) {
      const set = similar.get(complaintId) ?? new Set<string>();
      for (const id of similarIds) if (id !== complaintId) set.add(id);
      similar.set(complaintId, set);
    },
    async linkSameIssue(supporterId, originalId) {
      if (supporterId !== originalId) sameIssue.set(supporterId, originalId);
      const n = joinedTo(originalId).length;
      const o = complaints.get(originalId);
      if (o && n > 0) complaints.set(originalId, { ...o, supporters: n });
      return n;
    },
    async linkNotSameIssue(complaintId, otherId) {
      if (complaintId === otherId) return;
      const set = notSame.get(complaintId) ?? new Set<string>();
      set.add(otherId);
      notSame.set(complaintId, set);
    },
    async getIssueLinks(complaintId) {
      const joined = joinedTo(complaintId);
      return { sameIssueAs: sameIssue.get(complaintId) ?? null, joined, notSameAs: [...(notSame.get(complaintId) ?? [])], supporters: joined.length };
    },
    async getWorkflowPatterns(args: { target: FilingTarget; category: CategoryId }) {
      return clone(patterns.filter((p) => p.target === args.target && p.category === args.category));
    },

    // -- NYC311 catalog (#7) + learned form schemas (#11): same semantics as surrealdb.ts
    async upsertCatalog(entries) {
      for (const e of entries) {
        const prev = catalog.get(e.id);
        const learned = learnedSchemas.get(e.id);
        // a learned requiredFields list (from filing runs) survives a re-crawl
        catalog.set(e.id, clone({ ...prev, ...e, ...(learned ? { requiredFields: learned.requiredFields, formSchema: learned.formSchema } : {}) }));
      }
      return entries.length;
    },
    async listCatalog() {
      return clone([...catalog.values()].sort((a, b) => a.id.localeCompare(b.id)));
    },
    async updateCategorySchema(id, learned) {
      learnedSchemas.set(id, clone({ requiredFields: learned.requiredFields, formSchema: learned.formSchema }));
      const row = catalog.get(id);
      if (row) catalog.set(id, clone({ ...row, ...learned }));
    },

    // -- post-mortem repair proposals (#13)
    async saveRepairProposal(p) {
      repairs.set(p.id, clone(p));
      return clone(p);
    },
    async getRepairProposal(id) {
      const p = repairs.get(id);
      return p ? clone(p) : null;
    },
    async listRepairProposals(args) {
      return clone(
        [...repairs.values()]
          .filter((p) => !args?.status || p.status === args.status)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, args?.limit ?? 100),
      );
    },

    // -- agent memory (#4): same semantics as the SurrealQL in surrealdb.ts (shared helpers in services/agent-memory.ts)
    async insertMemory(row) {
      memories.set(row.id, clone(row));
    },
    async searchMemory(q) {
      return clone(searchMemoryRows(memories.values(), q));
    },
    async listMemoryNeedingEmbedding({ model, limit }) {
      return [...memories.values()]
        .filter((m) => m.embedModel !== model)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit)
        .map((m) => ({ id: m.id, text: m.text, embedModel: m.embedModel }));
    },
    async setMemoryEmbedding(id, embedding, embedModel) {
      const m = memories.get(id);
      if (m) memories.set(id, { ...m, embedding: [...embedding], embedModel });
    },
    async listMemory(args) {
      const list = [...memories.values()]
        .filter((m) => memoryMatches(m, { kind: args?.kind, category: args?.category, chatId: args?.chatId, about: args?.about }))
        .filter((m) => !args?.source || m.source === args.source)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, args?.limit ?? 100);
      return clone(list.map(({ embedding: _e, ...rest }) => rest));
    },

    async graph(args) {
      const nodes = new Map<string, { id: string; kind: string; label: string }>();
      const edges: { from: string; to: string; rel: string }[] = [];
      const list = [...complaints.values()].filter((c) => !args?.complaintId || c.id === args.complaintId);
      for (const c of list) {
        nodes.set(c.id, { id: c.id, kind: "complaint", label: `${c.category ?? "uncategorized"} · ${c.status}` });
        const res = residents.get(c.residentId);
        if (res) {
          nodes.set(res.id, { id: res.id, kind: "resident", label: res.telegramUsername ?? res.telegramChatId });
          edges.push({ from: res.id, to: c.id, rel: "reported" });
        }
        if (c.category) {
          const catId = `category_${c.category}`;
          nodes.set(catId, { id: catId, kind: "category", label: c.category });
          edges.push({ from: c.id, to: catId, rel: "classified_as" });
        }
        const locId = complaintLocation.get(c.id);
        if (locId) {
          const loc = locations.get(locId);
          nodes.set(locId, { id: locId, kind: "location", label: loc?.address ?? locId });
          edges.push({ from: c.id, to: locId, rel: "located_at" });
        }
        for (const m of c.media) {
          nodes.set(m.id, { id: m.id, kind: "media", label: m.type });
          edges.push({ from: c.id, to: m.id, rel: "has_media" });
        }
        for (const d of duplicateLinks.get(c.id) ?? []) {
          const did = `sr_${d.uniqueKey}`;
          nodes.set(did, { id: did, kind: "open_data_request", label: `${d.uniqueKey} (${d.status ?? "?"})` });
          edges.push({ from: c.id, to: did, rel: "possible_duplicate_of" });
        }
        for (const other of similar.get(c.id) ?? []) {
          const o = complaints.get(other);
          if (!o) continue;
          nodes.set(o.id, { id: o.id, kind: "complaint", label: `${o.category ?? "uncategorized"} · ${o.status}` });
          edges.push({ from: c.id, to: o.id, rel: "similar_to" });
        }
        const issueEdges: [string, string | undefined][] = [
          ["same_issue_as", sameIssue.get(c.id)],
          ...[...(notSame.get(c.id) ?? [])].map((o): [string, string] => ["not_same_as", o]),
        ];
        for (const [rel, other] of issueEdges) {
          const o = other ? complaints.get(other) : undefined;
          if (!o) continue;
          nodes.set(o.id, { id: o.id, kind: "complaint", label: `${o.category ?? "uncategorized"} · ${o.status}` });
          edges.push({ from: c.id, to: o.id, rel });
        }
        for (const a of attempts.values()) {
          if (a.complaintId !== c.id) continue;
          nodes.set(a.id, { id: a.id, kind: "filing_attempt", label: a.outcome ?? "running" });
          edges.push({ from: c.id, to: a.id, rel: "filing_attempt" });
        }
        for (const r of officialRequests.values()) {
          if (r.complaintId !== c.id) continue;
          nodes.set(r.id, { id: r.id, kind: "official_request", label: r.officialRequestNumber });
          edges.push({ from: c.id, to: r.id, rel: "filed_as" });
        }
      }
      return { nodes: [...nodes.values()], edges };
    },
  };
  return store;
}
