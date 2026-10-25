/**
 * Host-half tests.
 *
 * A tomato press must put a reminder into the agent's *next model request* and
 * nowhere else: never into the composer, never into the loop's inbox (an inbox
 * message is rendered as a turn trigger by the chat view), and never into the
 * request of another conversation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import * as host from '../lib/index.js';

const ROUTE = '/_dsh/throwtomatoes';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fake agent that records what the host half asks of it. */
function makeAgent({ id = 'session-1', status = 'running' } = {}) {
	const calls = { cancel: [], wake: [] };
	const agent = {
		id,
		session: { id },
		status,
		phase: { kind: status === 'running' ? 'running' : 'idle', turn: 1, step: 0 },
		calls,
		cancel(cause, options) {
			calls.cancel.push({ cause, options });
		},
		wakeDriver() {
			calls.wake.push(Date.now());
			agent.status = 'running';
		},
		whenIdle() {
			return Promise.resolve();
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
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		effect() {},
		logger: { warn() {}, info() {}, debug() {} },
	};
	host.apply(ctx);
	return { route: routes[0], handlers, ctx };
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
	route.handler(req, res);
	req.emit('data', Buffer.from(JSON.stringify(body)));
	req.emit('end');
	return res;
}

/** Run the pre-step hook the way the agent loop does. */
async function preStep(handlers, payload, messages = []) {
	const handler = handlers.get('agent/pre-step')[0];
	return handler(payload, async () => ({ kind: 'continue', messages }));
}

/** Let the deferred wake run. */
const settle = () => sleep(20);

test('registers one prefix route and both agent hooks', () => {
	const { route, handlers } = mount(makeAgent());
	assert.equal(route.kind, 'prefix');
	assert.equal(route.path, ROUTE);
	assert.equal(typeof route.handler, 'function');
	assert.equal(handlers.get('agent/pre-step').length, 1);
	assert.equal(handlers.get('agent/status').length, 1);
});

test('a light throw does not interrupt the running task', async () => {
	const agent = makeAgent({ status: 'running' });
	const { route } = mount(agent);
	const res = post(route, { sessionId: agent.id, hits: 1 });
	await settle();
	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body(), { ok: true, heavy: false, stopped: false });
	assert.equal(agent.calls.cancel.length, 0);
});

test('a heavy throw interrupts the running turn first', async () => {
	const agent = makeAgent({ status: 'running' });
	const { route } = mount(agent);
	const res = post(route, { sessionId: agent.id, hits: 3 });
	await settle();
	assert.deepEqual(res.body(), { ok: true, heavy: true, stopped: true });
	assert.deepEqual(agent.calls.cancel, [
		{ cause: { kind: 'user' }, options: { keepInbox: true } },
	]);
});

test('the reminder lands in the next model request and nowhere else', async () => {
	const agent = makeAgent({ status: 'running' });
	const { route, handlers } = mount(agent);
	post(route, { sessionId: agent.id, hits: 1 });
	await settle();

	// The loop opens the next turn: phase.turn is the new turn, phase.step is 0.
	agent.phase = { kind: 'running', turn: 2, step: 0 };
	const decision = await preStep(handlers, { agent, turn: 2, step: 1, signal: new AbortController().signal });

	assert.equal(decision.messages.length, 1);
	const message = decision.messages[0];
	assert.equal(message.role, 'user');
	assert.equal(message.source.kind, 'dsh-throwtomatoes');
	assert.equal(message.source.form, 'notice');
	assert.notEqual(message.source.kind, 'runtime-context', 'that kind is dropped before the request is built');
	assert.equal(typeof message.id, 'string');
	assert.equal(typeof message.time, 'number');
	assert.match(message.content[0].text, /扔番茄/);
	assert.match(message.content[0].text, /ask_user_question/);
	// Nothing was handed to the loop's queue, so the chat view has no turn
	// trigger to render.
	assert.equal(agent.inbox, undefined);
});

test('the reminder is delivered exactly once', async () => {
	const agent = makeAgent({ status: 'running' });
	const { route, handlers } = mount(agent);
	post(route, { sessionId: agent.id, hits: 1 });
	await settle();

	agent.phase = { kind: 'running', turn: 2, step: 0 };
	const first = await preStep(handlers, { agent, turn: 2, step: 1, signal: new AbortController().signal });
	agent.phase = { kind: 'running', turn: 3, step: 0 };
	const second = await preStep(handlers, { agent, turn: 3, step: 1, signal: new AbortController().signal });

	assert.equal(first.messages.length, 1);
	assert.equal(second.messages.length, 0);
});

test('a reminder never leaks into another conversation', async () => {
	const agent = makeAgent({ status: 'running' });
	const other = makeAgent({ id: 'session-2', status: 'running' });
	other.phase = { kind: 'running', turn: 2, step: 0 };
	const { route, handlers } = mount(agent);
	post(route, { sessionId: agent.id, hits: 1 });
	await settle();

	const decision = await preStep(handlers, { agent: other, turn: 2, step: 1, signal: new AbortController().signal });
	assert.equal(decision.messages.length, 0);
});

test('a reminder waits for the turn that opens after the running task', async () => {
	const agent = makeAgent({ status: 'running' });
	const { route, handlers } = mount(agent);
	post(route, { sessionId: agent.id, hits: 1 });
	await settle();

	// A step in the middle of the running turn must not consume it.
	agent.phase = { kind: 'running', turn: 1, step: 4 };
	const mid = await preStep(handlers, { agent, turn: 1, step: 5, signal: new AbortController().signal });
	assert.equal(mid.messages.length, 0);

	agent.phase = { kind: 'running', turn: 2, step: 0 };
	const next = await preStep(handlers, { agent, turn: 2, step: 1, signal: new AbortController().signal });
	assert.equal(next.messages.length, 1);
});

test('an idle loop is woken immediately so the reminder does not wait for the user', async () => {
	const agent = makeAgent({ status: 'idle' });
	agent.phase = { kind: 'idle', turn: 1 };
	const { route } = mount(agent);
	post(route, { sessionId: agent.id, hits: 1 });
	await settle();
	assert.equal(agent.calls.wake.length, 1);
});

test('the status handler retries the wake once the turn releases the loop', async () => {
	const agent = makeAgent({ status: 'running' });
	const { route, handlers } = mount(agent);
	post(route, { sessionId: agent.id, hits: 1 });
	await settle();
	// Still running: the wake inside the throw is refused.
	assert.equal(agent.calls.wake.length, 0);

	agent.status = 'idle';
	agent.phase = { kind: 'idle', turn: 1 };
	handlers.get('agent/status')[0]({ agent, status: 'idle' });
	await settle();
	assert.equal(agent.calls.wake.length, 1);
});

test('a burst folds into one reminder that counts them all', async () => {
	const agent = makeAgent({ status: 'running' });
	const { route, handlers } = mount(agent);
	post(route, { sessionId: agent.id, hits: 1 });
	post(route, { sessionId: agent.id, hits: 2 });
	await settle();

	agent.phase = { kind: 'running', turn: 2, step: 0 };
	const decision = await preStep(handlers, { agent, turn: 2, step: 1, signal: new AbortController().signal });
	assert.equal(decision.messages.length, 1);
	assert.match(decision.messages[0].content[0].text, /3 个番茄/);
});

test('a second throw after the first one landed starts a new reflection', async () => {
	const agent = makeAgent({ status: 'running' });
	const { route, handlers } = mount(agent);
	post(route, { sessionId: agent.id, hits: 1 });
	await settle();
	agent.phase = { kind: 'running', turn: 2, step: 0 };
	await preStep(handlers, { agent, turn: 2, step: 1, signal: new AbortController().signal });

	post(route, { sessionId: agent.id, hits: 1 });
	await settle();
	agent.phase = { kind: 'running', turn: 3, step: 0 };
	const decision = await preStep(handlers, { agent, turn: 3, step: 1, signal: new AbortController().signal });
	assert.equal(decision.messages.length, 1);
	assert.match(decision.messages[0].content[0].text, /一个番茄/);
});

test('unknown session answers 409 instead of throwing', async () => {
	const { route } = mount(undefined);
	const res = post(route, { sessionId: 'nope', hits: 1 });
	await settle();
	assert.equal(res.statusCode, 409);
	assert.equal(res.body().error, 'agent-unavailable');
});

test('malformed bodies are rejected and non-POST verbs are refused', async () => {
	const { route } = mount(makeAgent());
	const bad = post(route, { sessionId: '', hits: 1 });
	await settle();
	assert.equal(bad.statusCode, 400);

	const getter = new EventEmitter();
	getter.method = 'GET';
	getter.url = `${ROUTE}/throw`;
	const res = { statusCode: 0, writeHead(s) { this.statusCode = s; }, end() {} };
	route.handler(getter, res);
	await settle();
	assert.equal(res.statusCode, 405);
});
