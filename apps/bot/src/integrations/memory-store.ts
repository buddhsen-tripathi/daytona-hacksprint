/**
 * In-memory Store. Fully implements the Store contract; used by tests, the
 * demo script, and as the fallback when SurrealDB can't initialize.
 */
import type {
  CategoryId,
  ComplaintDraft,
  ComplaintLocation,
  ComplaintState,
  DuplicateCandidate,
  FilingAttempt,
  FilingTarget,
  OfficialRequest,
  Resident,
  Store,
  WorkflowPattern,
} from "../core/contracts.js";
import { nowIso, shortId } from "../core/contracts.js";

const TERMINAL: ComplaintState[] = ["CANCELLED", "EMERGENCY_REFERRAL", "OUT_OF_SCOPE", "TRACKING", "SUBMITTED"];

export type TransitionRecord = { complaintId: string; from: ComplaintState; to: ComplaintState; reason: string; actor: "user" | "system" | "llm"; at: string };

const clone = <T>(v: T): T => structuredClone(v);

export type MemoryStore = Store & {
  transitions: TransitionRecord[];
  listTransitions(complaintId: string): Promise<TransitionRecord[]>;
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
        demoPortalMode: "normal",
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
      patterns.push(clone(p));
    },
    async getWorkflowPatterns(args: { target: FilingTarget; category: CategoryId }) {
      return clone(patterns.filter((p) => p.target === args.target && p.category === args.category));
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
