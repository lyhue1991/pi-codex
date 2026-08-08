import { afterEach, describe, expect, it } from "vitest";
import piGoalExtension from "../src/goal.ts";

// Minimal mock of the Pi ExtensionAPI + ExtensionContext surface, sufficient to
// drive the goal extension's tools, commands, and event handlers without a live
// agent. This is an integration test of the extension's behavior (state machine,
// persistence, steering injection, continuation triggering, accounting), not a
// unit test of individual functions.

function makeMock() {
	const entries: any[] = [];
	const sentMessages: any[] = [];
	const sentUserMessages: string[] = [];
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const ui: any = {
		_confirm: true,
		_editor: undefined as string | undefined,
		notifications: [] as any[],
		status: new Map<string, any>(),
		notify(m: string, t?: string) {
			ui.notifications.push([m, t]);
		},
		confirm() {
			return Promise.resolve(ui._confirm);
		},
		input() {
			return Promise.resolve(ui._editor);
		},
		editor() {
			return Promise.resolve(ui._editor);
		},
		select() {
			return Promise.resolve(undefined);
		},
		setStatus(k: string, v: any) {
			ui.status.set(k, v);
		},
	};
	const ctx: any = {
		ui,
		mode: "tui",
		hasUI: true,
		cwd: "/tmp",
		_idle: true,
		_pending: false,
		isIdle: () => ctx._idle,
		hasPendingMessages: () => ctx._pending,
		sessionManager: { getEntries: () => entries.slice() },
	};
	const pi: any = {
		on(e: string, h: Function) {
			(handlers.get(e) ?? handlers.set(e, []).get(e)!).push(h);
		},
		registerTool(t: any) {
			tools.set(t.name, t);
		},
		registerCommand(n: string, o: any) {
			commands.set(n, o);
		},
		appendEntry(ct: string, d: unknown) {
			entries.push({
				type: "custom",
				customType: ct,
				data: d,
				id: String(entries.length),
				parentId: null,
				timestamp: new Date().toISOString(),
			});
		},
		sendMessage(m: any, o?: any) {
			sentMessages.push({ m, o });
		},
		sendUserMessage(c: string) {
			sentUserMessages.push(c);
		},
		getFlag() {
			return undefined;
		},
	};
	function emit(ev: string, event: any, c: any = ctx) {
		let result: any;
		for (const h of handlers.get(ev) ?? []) {
			const r = h(event, c);
			if (r !== undefined) result = r;
		}
		return result;
	}
	return { pi, entries, sentMessages, sentUserMessages, tools, commands, ctx, ui, emit };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const mocks: ReturnType<typeof makeMock>[] = [];
afterEach(() => {
	while (mocks.length) mocks.pop();
});
function setup() {
	const m = makeMock();
	mocks.push(m);
	piGoalExtension(m.pi);
	return m;
}
const tool = (m: ReturnType<typeof makeMock>, name: string) => m.tools.get(name)!;

describe("phase 1: state machine, tools, persistence, rehydrate", () => {
	it("create_goal creates an active goal and persists an entry", async () => {
		const m = setup();
		const r = await tool(m, "create_goal").execute("c", { objective: "build X" }, undefined, undefined, m.ctx);
		expect(r.details.status).toBe("active");
		expect(m.entries.some((e) => e.customType === "goal")).toBe(true);
	});

	it("create_goal rejects when an unfinished goal exists", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "a" }, undefined, undefined, m.ctx);
		await expect(tool(m, "create_goal").execute("c", { objective: "b" }, undefined, undefined, m.ctx)).rejects.toThrow();
	});

	it("create_goal succeeds after the current goal is terminal", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "a" }, undefined, undefined, m.ctx);
		await tool(m, "update_goal").execute("c", { status: "complete" }, undefined, undefined, m.ctx);
		const r = await tool(m, "create_goal").execute("c", { objective: "b" }, undefined, undefined, m.ctx);
		expect(r.details.status).toBe("active");
	});

	it("get_goal reports the active objective", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "build Y" }, undefined, undefined, m.ctx);
		const r = await tool(m, "get_goal").execute("c", {}, undefined, undefined, m.ctx);
		expect(r.content[0].text).toContain("build Y");
	});

	it("get_goal reports no goal when none exists", async () => {
		const m = setup();
		const r = await tool(m, "get_goal").execute("c", {}, undefined, undefined, m.ctx);
		expect(r.content[0].text).toBe("No active goal for this thread.");
	});

	it("update_goal marks complete and blocked", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "o" }, undefined, undefined, m.ctx);
		expect((await tool(m, "update_goal").execute("c", { status: "complete" }, undefined, undefined, m.ctx)).details.status).toBe("complete");
	});

	it("rehydrates goal state from session entries on session_start", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "persisted" }, undefined, undefined, m.ctx);
		await tool(m, "update_goal").execute("c", { status: "blocked" }, undefined, undefined, m.ctx);
		const persisted = m.entries.slice();

		const m2 = setup();
		m2.ctx.sessionManager = { getEntries: () => persisted.slice() };
		m2.emit("session_start", {}, m2.ctx);
		const r = await tool(m2, "get_goal").execute("g", {}, undefined, undefined, m2.ctx);
		expect(r.content[0].text).toContain("persisted");
		expect(r.details.status).toBe("blocked");
	});
});

describe("phase 2: steering injection, context dedup, continuation", () => {
	it("before_agent_start injects a hidden goal-context message when active", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "o" }, undefined, undefined, m.ctx);
		const res = m.emit("before_agent_start", { prompt: "", systemPrompt: "", systemPromptOptions: {} }, m.ctx);
		expect(res?.message?.customType).toBe("goal-context");
		expect(res.message.display).toBe(false);
	});

	it("before_agent_start is a no-op without an active goal", async () => {
		const m = setup();
		expect(m.emit("before_agent_start", { prompt: "", systemPrompt: "", systemPromptOptions: {} }, m.ctx)).toBeUndefined();
	});

	it("context event keeps only the latest goal steering message", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "o" }, undefined, undefined, m.ctx);
		const msgs = [
			{ role: "user", content: "hi" },
			{ role: "custom", customType: "goal-context", content: "old" },
			{ role: "assistant", content: "x" },
			{ role: "custom", customType: "goal-context", content: "new" },
		];
		const res = m.emit("context", { messages: msgs }, m.ctx);
		expect(res?.messages?.length).toBe(3);
		expect(res.messages.some((mm: any) => mm.content === "new")).toBe(true);
		expect(res.messages.some((mm: any) => mm.content === "old")).toBe(false);
	});

	it("agent_settled triggers a continuation turn when idle", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "long task" }, undefined, undefined, m.ctx);
		m.emit("agent_settled", {}, m.ctx);
		await flush();
		expect(m.sentUserMessages.length).toBe(1);
		expect(m.sentUserMessages[0]).toContain("Continue working toward the active thread goal");
	});

	it("does not continue when the user has pending messages", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "o" }, undefined, undefined, m.ctx);
		m.ctx._pending = true;
		m.emit("agent_settled", {}, m.ctx);
		await flush();
		expect(m.sentUserMessages.length).toBe(0);
	});
});

describe("phase 3: accounting and budget", () => {
	it("turn_end accounts token usage and wall time", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "o" }, undefined, undefined, m.ctx);
		m.emit("turn_start", {});
		m.emit("turn_end", { message: { usage: { input: 300, output: 200, cacheRead: 0, cacheWrite: 0 } } }, m.ctx);
		const g = await tool(m, "get_goal").execute("g", {}, undefined, undefined, m.ctx);
		expect(g.details.tokens_used).toBe(500);
		expect(g.details.time_used_seconds).toBeGreaterThanOrEqual(0);
	});

	it("exhausting token_budget transitions to budget_limited and stops continuation", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "o", token_budget: 1000 }, undefined, undefined, m.ctx);
		m.emit("turn_start", {});
		m.emit("turn_end", { message: { usage: { input: 600, output: 500, cacheRead: 0, cacheWrite: 0 } } }, m.ctx);
		const g = await tool(m, "get_goal").execute("g", {}, undefined, undefined, m.ctx);
		expect(g.details.status).toBe("budget_limited");
		expect(m.sentMessages.some((s) => s.m.customType === "goal-budget-limit")).toBe(true);
		m.emit("agent_settled", {}, m.ctx);
		await flush();
		expect(m.sentUserMessages.length).toBe(0);
	});

	it("update_goal can raise the token budget", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "o", token_budget: 1000 }, undefined, undefined, m.ctx);
		await tool(m, "update_goal").execute("u", { token_budget: 5000 }, undefined, undefined, m.ctx);
		const g = await tool(m, "get_goal").execute("g", {}, undefined, undefined, m.ctx);
		expect(g.details.token_budget).toBe(5000);
		expect(g.details.status).toBe("active");
	});

	it("update_goal can remove the token budget (set to null)", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "o", token_budget: 1000 }, undefined, undefined, m.ctx);
		await tool(m, "update_goal").execute("u", { token_budget: null }, undefined, undefined, m.ctx);
		const g = await tool(m, "get_goal").execute("g", {}, undefined, undefined, m.ctx);
		expect(g.details.token_budget).toBeNull();
		expect(g.details.status).toBe("active");
	});

	it("update_goal revives budget_limited goal when budget is raised above usage", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "o", token_budget: 1000 }, undefined, undefined, m.ctx);
		m.emit("turn_start", {});
		m.emit("turn_end", { message: { usage: { input: 600, output: 500, cacheRead: 0, cacheWrite: 0 } } }, m.ctx);
		const before = await tool(m, "get_goal").execute("g", {}, undefined, undefined, m.ctx);
		expect(before.details.status).toBe("budget_limited");
		await tool(m, "update_goal").execute("u", { token_budget: 5000 }, undefined, undefined, m.ctx);
		const after = await tool(m, "get_goal").execute("g", {}, undefined, undefined, m.ctx);
		expect(after.details.status).toBe("active");
		expect(after.details.token_budget).toBe(5000);
	});

	it("update_goal rejects invalid token_budget values", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "o" }, undefined, undefined, m.ctx);
		await expect(tool(m, "update_goal").execute("u", { token_budget: 0 }, undefined, undefined, m.ctx)).rejects.toThrow("positive integer");
		await expect(tool(m, "update_goal").execute("u", { token_budget: -100 }, undefined, undefined, m.ctx)).rejects.toThrow("positive integer");
	});

	it("update_goal requires at least one parameter", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "o" }, undefined, undefined, m.ctx);
		await expect(tool(m, "update_goal").execute("u", {}, undefined, undefined, m.ctx)).rejects.toThrow("at least one");
	});
});

describe("phase 4: /goal command family", () => {
	it("/goal <objective> sets the goal and triggers continuation", async () => {
		const m = setup();
		await m.commands.get("goal").handler("build the thing", m.ctx);
		const r = await tool(m, "get_goal").execute("g", {}, undefined, undefined, m.ctx);
		expect(r.content[0].text).toContain("build the thing");
		expect(m.sentUserMessages.length).toBe(1);
	});

	it("/goal pause then resume", async () => {
		const m = setup();
		await m.commands.get("goal").handler("do work", m.ctx);
		await m.commands.get("goal").handler("pause", m.ctx);
		expect((await tool(m, "get_goal").execute("g", {}, undefined, undefined, m.ctx)).details.status).toBe("paused");
		await m.commands.get("goal").handler("resume", m.ctx);
		expect((await tool(m, "get_goal").execute("g", {}, undefined, undefined, m.ctx)).details.status).toBe("active");
	});

	it("/goal edit updates the objective and revives a terminal goal", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "orig" }, undefined, undefined, m.ctx);
		await tool(m, "update_goal").execute("c", { status: "complete" }, undefined, undefined, m.ctx);
		m.ui._editor = "revised objective";
		await m.commands.get("goal").handler("edit", m.ctx);
		const r = await tool(m, "get_goal").execute("g", {}, undefined, undefined, m.ctx);
		expect(r.details.objective).toBe("revised objective");
		expect(r.details.status).toBe("active");
	});

	it("/goal edit injects a steering message when the agent is streaming", async () => {
		const m = setup();
		await m.commands.get("goal").handler("build it", m.ctx);
		m.ctx._idle = false;
		m.ui._editor = "new direction";
		await m.commands.get("goal").handler("edit", m.ctx);
		const steer = m.sentMessages.find((s) => s.o?.deliverAs === "steer");
		expect(steer).toBeDefined();
		expect(steer!.m.customType).toBe("goal-objective-updated");
		expect(steer!.m.content).toContain("new direction");
		expect(m.sentUserMessages.length).toBe(1);
	});

	it("/goal edit <text> inline updates objective without dialog", async () => {
		const m = setup();
		await m.commands.get("goal").handler("original goal", m.ctx);
		m.ui._editor = "should not be used";
		await m.commands.get("goal").handler("edit revised inline goal", m.ctx);
		const r = await tool(m, "get_goal").execute("g", {}, undefined, undefined, m.ctx);
		expect(r.details.objective).toBe("revised inline goal");
	});

	it("/goal edit <text> injects steering when agent is streaming", async () => {
		const m = setup();
		await m.commands.get("goal").handler("build it", m.ctx);
		m.ctx._idle = false;
		await m.commands.get("goal").handler("edit inline new direction", m.ctx);
		const steer = m.sentMessages.find((s) => s.o?.deliverAs === "steer");
		expect(steer).toBeDefined();
		expect(steer!.m.customType).toBe("goal-objective-updated");
		expect(steer!.m.content).toContain("inline new direction");
		expect(m.sentUserMessages.length).toBe(1);
	});

	it("/goal clear removes the goal", async () => {
		const m = setup();
		await m.commands.get("goal").handler("temp", m.ctx);
		await m.commands.get("goal").handler("clear", m.ctx);
		const r = await tool(m, "get_goal").execute("g", {}, undefined, undefined, m.ctx);
		expect(r.content[0].text).toBe("No active goal for this thread.");
	});

	it("/goal replace prompts for confirmation and respects decline", async () => {
		const m = setup();
		await m.commands.get("goal").handler("first", m.ctx);
		m.ui._confirm = false;
		await m.commands.get("goal").handler("second", m.ctx);
		const r = await tool(m, "get_goal").execute("g", {}, undefined, undefined, m.ctx);
		expect(r.details.objective).toBe("first");
	});

	it("/goal with no args shows a summary", async () => {
		const m = setup();
		await m.commands.get("goal").handler("summary goal", m.ctx);
		await m.commands.get("goal").handler("", m.ctx);
		expect(m.sentMessages.some((s) => s.m.customType === "goal-summary")).toBe(true);
	});
});

describe("phase 5: steering prompts", () => {
	it("continuation prompt includes completion and blocked audits", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "o" }, undefined, undefined, m.ctx);
		m.emit("agent_settled", {}, m.ctx);
		await flush();
		const cp = m.sentUserMessages[0];
		expect(cp).toContain("Completion audit");
		expect(cp).toContain("Blocked audit");
		expect(cp).toContain("three consecutive goal turns");
		expect(cp).toContain("Tokens used:");
	});

	it("budget-limit notification is emitted on exhaustion", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "o", token_budget: 10 }, undefined, undefined, m.ctx);
		m.emit("turn_start", {});
		m.emit("turn_end", { message: { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } }, m.ctx);
		const msg = m.sentMessages.find((s) => s.m.customType === "goal-budget-limit");
		expect(msg).toBeTruthy();
		expect(msg.m.content).toContain("budget_limited");
	});
});

describe("phase 6: fork flush and status line", () => {
	it("session_before_fork flushes a persistence entry", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "o" }, undefined, undefined, m.ctx);
		const before = m.entries.length;
		m.emit("session_before_fork", {}, m.ctx);
		expect(m.entries.length).toBe(before + 1);
	});

	it("status line reflects the active goal after a turn", async () => {
		const m = setup();
		await tool(m, "create_goal").execute("c", { objective: "o" }, undefined, undefined, m.ctx);
		m.emit("turn_start", {});
		m.emit("turn_end", { message: { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } }, m.ctx);
		expect(m.ui.status.get("goal")?.includes("active")).toBe(true);
	});

	it("status line clears when no goal", async () => {
		const m = setup();
		m.emit("session_start", {}, m.ctx);
		expect(m.ui.status.get("goal")).toBeUndefined();
	});
});
