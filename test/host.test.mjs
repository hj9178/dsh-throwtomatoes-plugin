import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const host = await import(pathToFileURL('E:/plugin/dsh-throwtomatoes-plugin/lib/index.js').href);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One agent double whose inbox behaves like the loop's pending lists. */
function makeAgent({ id = 'session-host', status = 'running' } = {}) {
	const calls = { inject: [], cancel: [], wake: [], order: [] };
	const pending = new Map();
	const agent = {
		id,
		session: { id },
		status,
		phase: { kind: status === 'running' ? 'running' : 'idle', turn: 1, step: 1 },
		calls,
		inbox: {
			remove(messageId) {
				return pending.delete(messageId);
			},
		},
		inject(message) {
			calls.inject.push(message);
			calls.order.push('inject');
			pending.set(message.id, message);
		},
		cancel(cause, options) {
			calls.cancel.push({ cause, options });
			calls.order.push('cancel');
		},
		/** Mirrors `wakeDriver(wakeAfterAbort)`: a running loop only latches. */
		wakeDriver(wakeAfterAbort = false) {
			calls.wake.push({ wakeAfterAbort, at: Date.now() });
			calls.order.push('wake');
			if (agent.phase.kind !== 'idle') {
				const latched = agent.phase.kind === 'maintenance' || wakeAfterAbort === true;
				if (!latched) return;
				agent.status = 'running';
				agent.phase = { kind: 'running', turn: 2, step: 0 };
				return;
			}
			agent.status = 'running';
			agent.phase = { kind: 'running', turn: 2, step: 0 };
		},
		/** Stand-in for the loop claiming its next step. */
		claimAll() {
			pending.clear();
		},
		/** Everything still waiting in the inbox. */
		pending() {
			return [...pending.values()];
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
		on() {},
		effect() {},
		logger: { warn() {}, info() {}, debug() {} },
	};
	host.apply(ctx);
	return { route: routes[0] };
}

function fakeRequest(body, method = 'POST', url = '/_dsh/throwtomatoes/throw') {
	const payload = typeof body === 'string' ? body : JSON.stringify(body);
	const stream = Readable.from([Buffer.from(payload, 'utf8')]);
	stream.method = method;
	stream.url = url;
	stream.headers = { 'content-type': 'application/json' };
	return stream;
}

function fakeResponse() {
	const state = { status: 0, body: undefined };
	return {
		state,
		writeHead(status) {
			state.status = status;
		},
		end(text) {
			state.body = text === undefined ? undefined : JSON.parse(text);
		},
		setHeader() {},
	};
}

/** Post one throw and return the parsed response. */
async function post(route, body) {
	const req = fakeRequest(body);
	const res = fakeResponse();
	await route.handler(req, res);
	return res.state;
}

test('the host half registers one prefix route', () => {
	const agent = makeAgent();
	const { route } = mount(agent);
	assert.equal(route.kind, 'prefix');
	assert.equal(route.path, '/_dsh/throwtomatoes');
	assert.equal(typeof route.handler, 'function');
});

test('a light throw injects for the next step without interrupting', async () => {
	const agent = makeAgent({ status: 'running' });
	const { route } = mount(agent);
	const state = await post(route, { sessionId: agent.id, hits: 1 });
	assert.equal(state.status, 200);
	assert.equal(state.body.ok, true);
	assert.equal(state.body.heavy, false);
	assert.equal(state.body.stopped, false);
	assert.equal(agent.calls.cancel.length, 0);
	assert.equal(agent.calls.inject.length, 1);
	const [message] = agent.calls.inject;
	assert.equal(message.role, 'user');
	assert.equal(message.source.kind, 'dsh-throwtomatoes');
	assert.equal(message.source.form, 'notice');
	assert.ok(typeof message.source.summary === 'string' && message.source.summary.length > 0);
	const text = message.content.map((block) => block.text).join('\n');
	assert.match(text, /扔番茄/);
	assert.match(text, /不该这么做/);
	assert.match(text, /ask_user_question/);
});

test('a light throw asks for the boundary without latching past the running step', async () => {
	const agent = makeAgent({ status: 'running' });
	const { route } = mount(agent);
	await post(route, { sessionId: agent.id, hits: 1 });
	assert.equal(agent.calls.wake.length, 1);
	assert.equal(agent.calls.wake[0].wakeAfterAbort, false, 'a light throw must not wake past the abort');
	assert.equal(agent.phase.step, 1, 'the step in flight keeps running');
});

test('an idle agent is woken, because no step boundary exists to carry it', async () => {
	const agent = makeAgent({ status: 'idle' });
	const { route } = mount(agent);
	await post(route, { sessionId: agent.id, hits: 1 });
	assert.equal(agent.calls.inject.length, 1);
	assert.equal(agent.calls.wake.length, 1);
	assert.equal(agent.status, 'running');
});

test('a heavy throw injects, arms the wake past the abort, then stops the step', async () => {
	const agent = makeAgent({ status: 'running' });
	const { route } = mount(agent);
	const state = await post(route, { sessionId: agent.id, hits: 3 });
	assert.equal(state.status, 200);
	assert.equal(state.body.heavy, true);
	assert.equal(state.body.stopped, true);
	assert.deepEqual(agent.calls.cancel, [{ cause: { kind: 'user' }, options: { keepInbox: true } }]);
	assert.equal(agent.calls.inject.length, 1);
	// The note has to be in the inbox before the wake is armed, and the abort has
	// to come last: `kick`'s finally only replays a latched wake, and the abort
	// is what ends the turn the note could no longer ride.
	assert.deepEqual(agent.calls.order, ['inject', 'wake', 'cancel']);
	assert.equal(agent.calls.wake[0].wakeAfterAbort, true, 'the wake must survive the abort');
	const text = agent.calls.inject[0].content.map((block) => block.text).join('\n');
	assert.match(text, /已经强行中断/);
});

test('a burst folds into one note that counts them all', async () => {
	const agent = makeAgent({ status: 'running' });
	const { route } = mount(agent);
	await post(route, { sessionId: agent.id, hits: 2 });
	await post(route, { sessionId: agent.id, hits: 2 });
	assert.equal(agent.calls.inject.length, 2);
	assert.equal(agent.pending().length, 1, 'the earlier note must be withdrawn');
	const text = agent.pending()[0].content.map((block) => block.text).join('\n');
	assert.match(text, /4 个番茄/);
});

test('a throw after the earlier one was claimed starts a fresh reflection', async () => {
	const agent = makeAgent({ status: 'running' });
	const { route } = mount(agent);
	await post(route, { sessionId: agent.id, hits: 1 });
	agent.claimAll();
	await post(route, { sessionId: agent.id, hits: 1 });
	assert.equal(agent.pending().length, 1);
	const text = agent.pending()[0].content.map((block) => block.text).join('\n');
	assert.match(text, /扔了一个番茄/);
});

test('unknown session answers 409 instead of throwing', async () => {
	const agent = makeAgent();
	const { route } = mount(agent);
	const state = await post(route, { sessionId: 'session-missing', hits: 1 });
	assert.equal(state.status, 409);
	assert.equal(state.body.error, 'agent-unavailable');
});

test('malformed bodies are rejected and non-POST verbs are refused', async () => {
	const agent = makeAgent();
	const { route } = mount(agent);
	assert.equal((await post(route, { sessionId: '', hits: 1 })).status, 400);
	assert.equal((await post(route, { sessionId: agent.id, hits: 0 })).status, 400);
	assert.equal((await post(route, '{oops')).status, 400);
	const wrongVerb = fakeResponse();
	await route.handler(fakeRequest('{}', 'GET'), wrongVerb);
	assert.equal(wrongVerb.state.status, 405);
	const wrongPath = fakeResponse();
	await route.handler(fakeRequest('{}', 'POST', '/_dsh/throwtomatoes/other'), wrongPath);
	assert.equal(wrongPath.state.status, 404);
});
