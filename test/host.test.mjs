/**
 * Host-half tests: a tomato press must hand the loop a reminder for its next
 * turn — never a composer prompt — and a heavy throw must interrupt the running
 * turn first. The reminder has to stay invisible to the browser: its source kind
 * is what keeps it out of the rendered conversation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import * as host from '../lib/index.js';

const ROUTE = '/_dsh/throwtomatoes';

/** Fake agent that records what the host half asks of it. */
function makeAgent({ id = 'session-1', status = 'running' } = {}) {
	const calls = { cancel: [], messages: [], removed: [] };
	const agent = {
		id,
		session: { id },
		status,
		phase: { kind: status === 'running' ? 'running' : 'idle', turn: 1, step: 0 },
		calls,
		// Default inbox: the note is still waiting, so a later press can fold in.
		inbox: {
			remove(noteId) {
				calls.removed.push(noteId);
				return true;
			},
		},
		cancel(cause, options) {
			calls.cancel.push({ cause, options });
		},
		followup(message) {
			calls.messages.push(message);
		},
	};
	return agent;
}

/** Minimal harness around `apply(ctx)`. */
function mount(agent) {
	const routes = [];
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
		on() {
			throw new Error('the host half must not register agent hooks any more');
		},
		effect() {},
		logger: { warn() {}, info() {}, debug() {} },
	};
	host.apply(ctx);
	return { route: routes[0], ctx };
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

/** Let the handler's body read settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('registers one prefix route and no agent hooks', () => {
	const { route } = mount(makeAgent());
	assert.equal(route.kind, 'prefix');
	assert.equal(route.path, ROUTE);
	assert.equal(typeof route.handler, 'function');
});

test('a light throw hands the loop an invisible reminder for its next turn', async () => {
	const agent = makeAgent({ status: 'running' });
	const { route } = mount(agent);
	const { res } = post(route, { sessionId: agent.id, hits: 1 });
	await settle();
	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body(), { ok: true, heavy: false, stopped: false });
	assert.equal(agent.calls.cancel.length, 0, 'light throw must not interrupt');
	assert.equal(agent.calls.messages.length, 1);

	const message = agent.calls.messages[0];
	assert.equal(message.role, 'user');
	// `runtime-context` is the one kind the agent loop drops before building the
	// request, so the reminder must never use it.
	assert.notEqual(message.source.kind, 'runtime-context');
	assert.equal(message.source.kind, 'dsh-throwtomatoes');
	assert.equal(message.source.form, 'notice');
	assert.equal(typeof message.id, 'string');
	assert.equal(typeof message.time, 'number');
	assert.match(message.content[0].text, /扔番茄/);
	assert.match(message.content[0].text, /ask_user_question/);
});

test('a heavy throw interrupts the running turn and then hands over the reminder', async () => {
	const agent = makeAgent({ status: 'running' });
	const { route } = mount(agent);
	const { res } = post(route, { sessionId: agent.id, hits: 3 });
	await settle();
	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body(), { ok: true, heavy: true, stopped: true });
	assert.equal(agent.calls.cancel.length, 1);
	assert.deepEqual(agent.calls.cancel[0], {
		cause: { kind: 'user' },
		options: { keepInbox: true },
	});
	assert.equal(agent.calls.messages.length, 1);
	assert.match(agent.calls.messages[0].content[0].text, /强行中断/);
});

test('a heavy throw on an idle agent does not fabricate a stop', async () => {
	const agent = makeAgent({ status: 'idle' });
	const { route } = mount(agent);
	const { res } = post(route, { sessionId: agent.id, hits: 4 });
	await settle();
	assert.equal(res.body().stopped, false);
	assert.equal(agent.calls.cancel.length, 0);
	assert.equal(agent.calls.messages.length, 1);
});

test('a burst folds into the note that is still waiting', async () => {
	const agent = makeAgent({ status: 'running' });
	const { route } = mount(agent);
	post(route, { sessionId: agent.id, hits: 1 });
	await settle();
	const first = agent.calls.messages[0];
	post(route, { sessionId: agent.id, hits: 1 });
	await settle();
	// The earlier note is withdrawn so the model does not read two nearly
	// identical reflections, and the presses are counted together.
	assert.deepEqual(agent.calls.removed, [first.id]);
	assert.equal(agent.calls.messages.length, 2);
	assert.match(agent.calls.messages[1].content[0].text, /2 个番茄/);
});

test('a note the model already read is not folded into the next one', async () => {
	const agent = makeAgent({ status: 'running' });
	agent.inbox.remove = () => false;
	const { route } = mount(agent);
	post(route, { sessionId: agent.id, hits: 1 });
	await settle();
	post(route, { sessionId: agent.id, hits: 1 });
	await settle();
	assert.equal(agent.calls.messages.length, 2);
	assert.match(agent.calls.messages[1].content[0].text, /一个番茄/);
});

test('the tomato feature can be used again in the same conversation', async () => {
	const agent = makeAgent({ status: 'running' });
	agent.inbox.remove = () => false;
	const { route } = mount(agent);
	for (const hits of [1, 1, 3]) {
		post(route, { sessionId: agent.id, hits });
		await settle();
	}
	assert.equal(agent.calls.messages.length, 3);
	assert.match(agent.calls.messages[2].content[0].text, /强行中断/);
});

test('an agent that cannot receive a follow-up is refused, not silently dropped', async () => {
	const agent = makeAgent();
	agent.followup = undefined;
	agent.send = undefined;
	const { route } = mount(agent);
	const { res } = post(route, { sessionId: agent.id, hits: 1 });
	await settle();
	assert.equal(res.statusCode, 409);
	assert.equal(res.body().error, 'agent-unavailable');
});

test('unknown session answers 409 instead of throwing', async () => {
	const { route } = mount(undefined);
	const { res } = post(route, { sessionId: 'nope', hits: 1 });
	await settle();
	assert.equal(res.statusCode, 409);
	assert.equal(res.body().ok, false);
	assert.equal(res.body().error, 'agent-unavailable');
});

test('malformed bodies are rejected and non-POST verbs are refused', async () => {
	const { route } = mount(makeAgent());
	const bad = post(route, { sessionId: '', hits: 1 });
	await settle();
	assert.equal(bad.res.statusCode, 400);

	const getter = new EventEmitter();
	getter.method = 'GET';
	getter.url = `${ROUTE}/throw`;
	const res = { statusCode: 0, writeHead(s) { this.statusCode = s; }, end() {} };
	route.handler(getter, res);
	await settle();
	assert.equal(res.statusCode, 405);
});
