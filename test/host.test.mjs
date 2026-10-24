/**
 * Host-half tests: the tomato bridge must merge its reminder into the next
 * model request instead of appending a session event, and a heavy throw must
 * interrupt the running turn first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import * as host from '../lib/index.js';

const ROUTE = '/_dsh/throwtomatoes';

/** Fake agent that records what the host half asks of it. */
function makeAgent({ id = 'session-1', status = 'running', idle = true } = {}) {
	const calls = { cancel: [], wake: [], followup: 0, prompt: 0 };
	const agent = {
		id,
		session: { id },
		status,
		// The agent loop reads `step = phase.step + 1` right before the pre-step
		// hook, so a first-step hook sees `{ turn, step: 1 }` against step 0 here.
		phase: { kind: status === 'running' ? 'running' : 'idle', turn: 1, step: 0 },
		calls,
		cancel(cause, options) {
			calls.cancel.push({ cause, options });
		},
		wakeDriver() {
			calls.wake.push(Date.now());
		},
		whenIdle() {
			return idle ? Promise.resolve() : new Promise(() => {});
		},
		followup() {
			calls.followup += 1;
		},
	};
	return agent;
}

/** Minimal harness around `apply(ctx)`. */
function mount(agent) {
	const routes = [];
	const handlers = new Map();
	const agents = new Map();
	if (agent !== undefined) agents.set(agent.id, agent);
	const ctx = {
		get(name) {
			if (name === 'webServer') {
				return {
					register(spec) {
						routes.push(spec);
						return () => {};
					},
				};
			}
			if (name === 'agents') return { get: (id) => agents.get(id) };
			return undefined;
		},
		on(event, fn, options) {
			handlers.set(event, { fn, options });
			return () => {};
		},
		effect() {},
		logger: { warn() {}, info() {}, debug() {} },
	};
	host.apply(ctx);
	const route = routes[0];
	const preStep = handlers.get('agent/pre-step');
	return { route, preStep, ctx };
}

/** Drive one POST through the registered handler. */
function post(route, body) {
	const req = new EventEmitter();
	req.method = 'POST';
	req.url = `${ROUTE}/throw`;
	const chunks = [];
	const res = {
		statusCode: 0,
		headers: undefined,
		writeHead(status, headers) {
			this.statusCode = status;
			this.headers = headers;
		},
		end(chunk) {
			if (chunk !== undefined) chunks.push(Buffer.from(chunk));
		},
		body() {
			return JSON.parse(Buffer.concat(chunks).toString('utf8'));
		},
	};
	const done = route.handler(req, res);
	req.emit('data', Buffer.from(JSON.stringify(body)));
	req.emit('end');
	return { res, done };
}

/**
 * Run the registered pre-step waterfall once.
 *
 * The loop calls it with `{ messages, turn, step, signal }`, and the agent
 * dispatcher fuses `agent` into every agent event, so the handler really does
 * see the agent that is entering the step.
 */
async function step(preStep, agent, messages = [], position = { turn: 1, step: 1 }) {
	const next = () => Promise.resolve({ kind: 'enter', messages });
	return preStep.fn({ messages, ...position, agent, signal: { aborted: false } }, next);
}

test('registers one prefix route and the pre-step hook', () => {
	const { route, preStep } = mount(makeAgent());
	assert.equal(route.kind, 'prefix');
	assert.equal(route.path, ROUTE);
	assert.equal(typeof route.handler, 'function');
	assert.ok(preStep !== undefined);
	assert.equal(preStep.options?.prepend, true);
});

test('a light throw arms a request-visible reminder without sending a user prompt', async () => {
	const agent = makeAgent({ status: 'running' });
	const { route, preStep } = mount(agent);
	const { res } = post(route, { sessionId: agent.id, hits: 1 });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body(), { ok: true, heavy: false, stopped: false });
	assert.equal(agent.calls.cancel.length, 0, 'light throw must not interrupt');
	assert.equal(agent.calls.followup, 0, 'the notice must not be sent as a user message');

	const decision = await step(preStep, agent);
	assert.equal(decision.messages.length, 1);
	const injected = decision.messages[0];
	assert.equal(injected.role, 'user');
	// `runtime-context` is the one kind the agent loop drops before building the
	// request, so the reminder must never use it.
	assert.notEqual(injected.source.kind, 'runtime-context');
	assert.equal(injected.source.kind, 'dsh-throwtomatoes');
	assert.equal(injected.source.form, 'notice');
	assert.equal(typeof injected.id, 'string');
	assert.match(injected.content[0].text, /扔番茄/);
	assert.match(injected.content[0].text, /ask_user_question/);
});

test('the reminder is one-shot: the following step carries nothing extra', async () => {
	const agent = makeAgent();
	const { route, preStep } = mount(agent);
	post(route, { sessionId: agent.id, hits: 2 });
	await new Promise((resolve) => setTimeout(resolve, 0));
	const first = await step(preStep, agent);
	assert.equal(first.messages.length, 1);
	const second = await step(preStep, agent);
	assert.equal(second.messages.length, 0);
});

test('a heavy throw interrupts the running turn and restarts it with the reminder', async () => {
	const agent = makeAgent({ status: 'running' });
	const { route, preStep } = mount(agent);
	const { res } = post(route, { sessionId: agent.id, hits: 3 });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body(), { ok: true, heavy: true, stopped: true });
	assert.equal(agent.calls.cancel.length, 1);
	assert.equal(agent.calls.wake.length, 1, 'the interrupted turn is restarted so the model can reflect');
	const decision = await step(preStep, agent);
	assert.equal(decision.messages.length, 1);
	assert.match(decision.messages[0].content[0].text, /已经强行中断/);
});

test('a heavy throw on an idle agent does not fabricate a stop', async () => {
	const agent = makeAgent({ status: 'idle' });
	const { route } = mount(agent);
	const { res } = post(route, { sessionId: agent.id, hits: 4 });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(res.body().stopped, false);
	assert.equal(agent.calls.cancel.length, 0);
	assert.equal(agent.calls.wake.length, 1);
});

test('the tomato feature can be used again in the same conversation', async () => {
	const agent = makeAgent({ status: 'running' });
	const { route, preStep } = mount(agent);
	for (const hits of [1, 1, 3]) {
		post(route, { sessionId: agent.id, hits });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const decision = await step(preStep, agent);
		assert.equal(decision.messages.length, 1, `throw ${hits} should inject once`);
	}
	assert.equal(agent.calls.wake.length, 3);
});

test('the reminder only lands on the armed agent, never on another turn', async () => {
	const armed = makeAgent({ id: 'session-a' });
	const other = makeAgent({ id: 'session-b' });
	const { route, preStep } = mount(armed);
	post(route, { sessionId: armed.id, hits: 1 });
	await new Promise((resolve) => setTimeout(resolve, 0));
	// A different conversation sitting at the same turn/step must not steal it.
	const stolen = await step(preStep, other);
	assert.equal(stolen.messages.length, 0);
	// Another turn (e.g. a different conversation that happens to be at turn 7)
	// must not claim it.
	const elsewhere = await step(preStep, armed, [], { turn: 7, step: 1 });
	assert.equal(elsewhere.messages.length, 0);
	// A non-first step of the same turn must not claim it either.
	const laterStep = await step(preStep, armed, [], { turn: 1, step: 2 });
	assert.equal(laterStep.messages.length, 0);
	// The armed turn still gets it afterwards.
	const mine = await step(preStep, armed, [], { turn: 1, step: 1 });
	assert.equal(mine.messages.length, 1);
});

test('unknown session answers 409 instead of throwing', async () => {
	const { route } = mount(undefined);
	const { res } = post(route, { sessionId: 'nope', hits: 1 });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(res.statusCode, 409);
	assert.equal(res.body().ok, false);
	assert.equal(res.body().error, 'agent-unavailable');
});

test('malformed bodies are rejected and non-POST verbs are refused', async () => {
	const { route } = mount(makeAgent());
	const bad = post(route, { sessionId: '', hits: 1 });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(bad.res.statusCode, 400);

	const getter = new EventEmitter();
	getter.method = 'GET';
	getter.url = `${ROUTE}/throw`;
	const res = { statusCode: 0, writeHead(s) { this.statusCode = s; }, end() {} };
	route.handler(getter, res);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(res.statusCode, 405);
});
