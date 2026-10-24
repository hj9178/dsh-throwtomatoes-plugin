/**
 * Tests for dsh-throwtomatoes-plugin.
 *
 * Browser half: loaded exactly the way the DSH web bundle loads it — a plain
 * script calling `window.__ModuleLoader__.load({ id, factory })` — then driven
 * against a synthetic composer DOM (the shape InputBar renders).
 *
 * Host half: `apply` is given a stub ctx and its route handler is called with
 * fake request/response objects, which pins down what the agent receives.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'lib', 'client.js');
const hostPath = path.join(here, '..', 'lib', 'index.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rect(left, top, width, height) {
	return {
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		x: left,
		y: top,
		toJSON() { return this; },
	};
}

/** Build the composer DOM InputBar renders, with jsdom-friendly geometry. */
function buildComposer(dom, { stop, draft, sessionAttr, misplacedPrimary = false }) {
	const { document } = dom.window;
	const card = document.createElement('div');
	card.setAttribute('data-composer-card', '');
	card.getBoundingClientRect = () => rect(20, 400, 800, 150);

	const overlay = document.createElement('div');
	overlay.setAttribute('data-composer-overlay', '');
	card.appendChild(overlay);

	const editor = document.createElement('div');
	editor.setAttribute('contenteditable', 'true');
	editor.textContent = draft;
	card.appendChild(editor);

	const row = document.createElement('div');
	const tools = document.createElement('div');
	const plus = document.createElement('button');
	plus.textContent = '+';
	plus.getBoundingClientRect = () => rect(30, 470, 24, 24);
	tools.appendChild(plus);
	row.appendChild(tools);

	const trailing = document.createElement('div');
	if (stop) {
		const stopButton = document.createElement('button');
		stopButton.setAttribute('aria-label', '停止');
		stopButton.innerHTML = '<svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10"></rect></svg>';
		stopButton.getBoundingClientRect = () => rect(700, 470, 32, 32);
		trailing.appendChild(stopButton);
	}
	const primary = document.createElement('button');
	primary.setAttribute('aria-label', stop ? '停止' : '发送');
	primary.className = 'primary';
	primary.innerHTML = stop
		? '<svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10"></rect></svg>'
		: '<svg viewBox="0 0 16 16"><path d="M8 1L8 15"></path></svg>';
	primary.getBoundingClientRect = () => (misplacedPrimary ? rect(40, 410, 32, 32) : rect(750, 470, 32, 32));
	trailing.appendChild(primary);

	row.appendChild(trailing);
	card.appendChild(row);
	if (sessionAttr === undefined) {
		document.body.appendChild(card);
	} else {
		const holder = document.createElement('div');
		holder.setAttribute('data-conversation-session', sessionAttr);
		holder.appendChild(card);
		document.body.appendChild(holder);
	}
	return { card, overlay, editor, primary, plus };
}

/**
 * Load the browser half into a fresh jsdom and return the plugin exports plus
 * the DOM handles the tests drive.
 */
async function loadPlugin(options = {}) {
	const { stop = true, draft = '', settings = {}, sessionAttr, misplacedPrimary = false, failFetch = false } = options;
	const dom = new JSDOM('<!doctype html><html><body></body></html>', {
		url: 'http://127.0.0.1/',
		pretendToBeVisual: true,
	});

	// jsdom has no Web Animations API; the plugin only needs the event surface.
	dom.window.Element.prototype.animate = function animate() {
		const listeners = new Map();
		return {
			addEventListener: (name, listener) => {
				listeners.set(name, listener);
				if (name === 'finish') {
					dom.window.setTimeout(() => {
						const fn = listeners.get('finish');
						if (fn) fn({ type: 'finish' });
					}, 0);
				}
			},
			cancel: () => {},
			finish: () => {},
		};
	};

	if (Object.keys(settings).length > 0) {
		dom.window.localStorage.setItem('dsh-throwtomatoes:settings:v1', JSON.stringify(settings));
	}

	const composer = buildComposer(dom, { stop, draft, sessionAttr, misplacedPrimary });
	const seatProps = 'seatProps' in options ? options.seatProps : { sessionId: 'session-test' };

	let pendingEffects = [];
	const renderComponent = (component, props) => {
		pendingEffects = [];
		const rendered = component(props);
		const cleanups = pendingEffects.map((effect) => effect()).filter((value) => typeof value === 'function');
		return { rendered, cleanup: () => { for (const fn of cleanups) fn(); } };
	};

	/** A minimal React stand-in: enough createElement/refs/effects for the seat. */
	const ReactStub = {
		createElement: (type, props, ...children) => {
			if (typeof type === 'string') {
				const element = dom.window.document.createElement(type);
				for (const [key, value] of Object.entries(props ?? {})) {
					if (key === 'ref') {
						if (value !== null && typeof value === 'object') value.current = element;
						continue;
					}
					if (key === 'hidden') { element.hidden = value === true; continue; }
					if (key === 'className') { element.className = String(value); continue; }
				}
				element.textContent = children.filter((child) => typeof child === 'string').join('');
				composer.overlay.appendChild(element);
				return element;
			}
			return { type, props, children };
		},
		useRef: (initial) => ({ current: initial }),
		useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
		useEffect: (effect) => { pendingEffects.push(effect); },
	};

	const hostCalls = [];
	const fetchImpl = async (url, init) => {
		hostCalls.push({ url, body: JSON.parse(init.body), method: init.method });
		if (failFetch) throw new Error('offline');
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ ok: true, heavy: JSON.parse(init.body).heavy, stopped: false }),
		};
	};

	const source = await readFile(clientPath, 'utf8');
	const evaluate = new Function('require', 'window', 'document', 'Element', 'Intl', 'crypto', 'console', 'fetch', source);
	let loaded = null;

	dom.window.__ModuleLoader__ = {
		load: (definition) => { loaded = definition; },
	};

	evaluate(
		(moduleId) => {
			if (moduleId === 'react') return ReactStub;
			throw new Error(`unexpected require: ${moduleId}`);
		},
		dom.window,
		dom.window.document,
		dom.window.Element,
		dom.window.Intl,
		globalThis.crypto,
		console,
		fetchImpl,
	);

	assert.ok(loaded !== null, 'client bundle must call __ModuleLoader__.load');
	assert.equal(loaded.id, 'dsh-throwtomatoes-plugin');
	const plugin = loaded.factory((moduleId) => {
		if (moduleId === 'react') return ReactStub;
		throw new Error(`unexpected require: ${moduleId}`);
	});

	const calls = { prompt: [], cancel: 0 };
	const session = {
		prompt: async (content, mode) => { calls.prompt.push({ content, mode }); return { ok: true }; },
		cancel: async () => { calls.cancel += 1; return { ok: true }; },
		getSnapshot: () => ({ running: stop }),
	};
	const registered = [];
	const slotsApi = {
		inject: (name, register) => { registered.push({ name, slot: register() }); },
		register: (options, component) => ({ options, component }),
		getVersion: () => 0,
		entries: () => [],
		subscribe: () => () => {},
	};
	const ctx = {
		get: (name) => {
			if (name === 'sessions') return { binding: () => ({ session }) };
			if (name === 'slots') return slotsApi;
			return undefined;
		},
		effect: () => {},
	};

	const dispose = plugin.apply(ctx);
	const tomatoKey = dom.window.document.querySelector('.dtt-key');
	const seatSlot = registered.find((entry) => entry.name === 'conversation.input.overlay');
	const seat = seatSlot.slot.component !== undefined
		? renderComponent(seatSlot.slot.component, seatProps)
		: { cleanup: () => {} };

	return {
		dom,
		composer,
		calls,
		hostCalls,
		registered,
		dispose: () => { seat.cleanup(); dispose(); },
		tomatoKey,
		layer: () => dom.window.document.getElementById('dtt-layer'),
	};
}

/* ------------------------------------------------------------------ */
/* Host half                                                           */
/* ------------------------------------------------------------------ */

/** Stub ctx that captures the registered route and the agent it resolves. */
function hostHarness({ running = true } = {}) {
	const routed = [];
	let handler = null;
	const agent = {
		status: running ? 'running' : 'idle',
		cancelled: [],
		messages: [],
		cancel(cause, options) { this.cancelled.push({ cause, options }); this.status = 'idle'; },
		followup(message) { this.messages.push(message); },
	};
	const ctx = {
		get: (name) => {
			if (name === 'webServer') {
				return {
					register: (route) => { routed.push(route); handler = route.handler; return () => {}; },
				};
			}
			if (name === 'agents') {
				return { get: (id) => (id === 'session-host' ? agent : undefined) };
			}
			return undefined;
		},
		effect: () => {},
		logger: { warn: () => {} },
	};
	return { ctx, agent, routed, handler: () => handler };
}

function fakeRequest(method, url, body) {
	const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
	const stream = Readable.from(chunks);
	stream.method = method;
	stream.url = url;
	return stream;
}

function fakeResponse() {
	const out = { status: 0, headers: null, body: '' };
	return {
		out,
		writeHead(status, headers) { out.status = status; out.headers = headers; },
		end(body) { out.body = body ?? ''; },
	};
}

async function callHost(harness, method, url, body) {
	const res = fakeResponse();
	await harness.handler()(fakeRequest(method, url, body), res);
	return { status: res.out.status, body: res.out.body.length > 0 ? JSON.parse(res.out.body) : null };
}

let active = null;

afterEach(() => {
	if (active !== null) {
		try { active.dispose(); } catch { /* ignore teardown noise */ }
		active = null;
	}
});

/* ------------------------------------------------------------------ */
/* Browser half                                                        */
/* ------------------------------------------------------------------ */

test('exposes the module contract the DSH web bundle expects', async () => {
	const plugin = await loadPlugin({ stop: false, draft: '' });
	active = plugin;
	assert.equal(typeof plugin.dispose, 'function');
	assert.equal(typeof plugin.tomatoKey, 'object');
});

test('registers both surfaces into the slot system', async () => {
	const plugin = await loadPlugin({ stop: false, draft: '' });
	active = plugin;
	const names = plugin.registered.map((entry) => entry.name);
	assert.deepEqual(names, ['conversation.input.overlay', 'settings.section']);
	assert.equal(plugin.registered[0].slot.options.id, 'throwtomatoes-seat');
	assert.equal(plugin.registered[1].slot.options.id, 'throwtomatoes');
	assert.equal(typeof plugin.registered[1].slot.component, 'function');
});

test('keeps the tomato key hidden while the primary key sends', async () => {
	const plugin = await loadPlugin({ stop: false, draft: '' });
	active = plugin;
	await sleep(60);
	assert.equal(plugin.tomatoKey.dataset.visible, 'false');
});

test('reveals the tomato key while a turn runs and the composer is empty', async () => {
	const plugin = await loadPlugin({ stop: true, draft: '' });
	active = plugin;
	await sleep(60);
	assert.equal(plugin.tomatoKey.dataset.visible, 'true');
	assert.equal(plugin.tomatoKey.style.left, '750px');
	assert.equal(plugin.tomatoKey.style.top, '470px');
	assert.equal(plugin.tomatoKey.style.width, '32px');
	assert.equal(plugin.tomatoKey.style.height, '32px');
});

test('hides the tomato key when the composer has text', async () => {
	const plugin = await loadPlugin({ stop: true, draft: '先别动' });
	active = plugin;
	await sleep(60);
	assert.equal(plugin.tomatoKey.dataset.visible, 'false');
});

test('never forwards the press to the original primary key', async () => {
	const plugin = await loadPlugin({ stop: true, draft: '' });
	active = plugin;
	await sleep(60);
	let primaryClicks = 0;
	plugin.composer.primary.addEventListener('click', () => { primaryClicks += 1; });
	plugin.tomatoKey.dispatchEvent(new plugin.dom.window.MouseEvent('click', { bubbles: true }));
	assert.equal(primaryClicks, 0, 'the primary key must not receive the tomato press');
});

test('one press plays the throw and asks the host for a light reminder', async () => {
	const plugin = await loadPlugin({ stop: true, draft: '' });
	active = plugin;
	await sleep(60);

	plugin.tomatoKey.dispatchEvent(new plugin.dom.window.MouseEvent('click', { bubbles: true }));
	assert.equal(plugin.tomatoKey.querySelector('.dtt-badge').textContent, '1');
	assert.equal(plugin.hostCalls.length, 0, 'the reminder waits for the streak window');

	await sleep(1150);
	assert.equal(plugin.hostCalls.length, 1);
	assert.equal(plugin.hostCalls[0].url, '/_dsh/throwtomatoes/throw');
	assert.deepEqual(
		{ sessionId: plugin.hostCalls[0].body.sessionId, hits: plugin.hostCalls[0].body.hits, heavy: plugin.hostCalls[0].body.heavy },
		{ sessionId: 'session-test', hits: 1, heavy: false },
	);
	assert.equal(plugin.calls.prompt.length, 0, 'the visible composer path must stay unused');
	assert.equal(plugin.calls.cancel, 0, 'a light throw must not stop the running turn');
	assert.ok(plugin.layer() !== null, 'the effect layer must exist after a throw');
});

test('three rapid presses ask the host for the interrupting heavy reminder', async () => {
	const plugin = await loadPlugin({ stop: true, draft: '' });
	active = plugin;
	await sleep(60);

	const click = () => plugin.tomatoKey.dispatchEvent(new plugin.dom.window.MouseEvent('click', { bubbles: true }));
	click();
	click();
	click();
	await sleep(120);
	assert.equal(plugin.hostCalls.length, 1);
	assert.equal(plugin.hostCalls[0].body.heavy, true);
	assert.equal(plugin.hostCalls[0].body.hits, 3);
	assert.equal(plugin.calls.cancel, 0, 'interrupting is the host half responsibility');
	assert.equal(plugin.calls.prompt.length, 0);
});

test('the tomato key can be used more than once in a conversation', async () => {
	const plugin = await loadPlugin({ stop: true, draft: '' });
	active = plugin;
	await sleep(60);

	const click = () => plugin.tomatoKey.dispatchEvent(new plugin.dom.window.MouseEvent('click', { bubbles: true }));
	click();
	await sleep(1150);
	click();
	await sleep(1150);
	assert.equal(plugin.hostCalls.length, 2);
	assert.equal(plugin.dom.window.localStorage.getItem('dsh-throwtomatoes:count:v1'), '2');
});

test('respects the effects switch', async () => {
	const plugin = await loadPlugin({ stop: true, draft: '', settings: { effects: false, sound: false } });
	active = plugin;
	await sleep(60);
	plugin.tomatoKey.dispatchEvent(new plugin.dom.window.MouseEvent('click', { bubbles: true }));
	await sleep(40);
	assert.equal(plugin.layer(), null, 'no effect layer when effects are disabled');
	assert.equal(plugin.tomatoKey.querySelector('.dtt-badge').textContent, '1', 'the press still counts');
});

test('resolves the session from the conversation DOM when no sessionId prop arrives', async () => {
	const plugin = await loadPlugin({ stop: true, draft: '', sessionAttr: 'session-from-dom', seatProps: {} });
	active = plugin;
	await sleep(60);
	assert.equal(plugin.tomatoKey.dataset.visible, 'true', 'the key still reveals itself without the prop');
	plugin.tomatoKey.dispatchEvent(new plugin.dom.window.MouseEvent('click', { bubbles: true }));
	await sleep(1150);
	assert.equal(plugin.hostCalls.length, 1);
	assert.equal(plugin.hostCalls[0].body.sessionId, 'session-from-dom');
});

test('falls back to the composer corner when the primary key cannot be located', async () => {
	const plugin = await loadPlugin({ stop: true, draft: '', misplacedPrimary: true });
	active = plugin;
	await sleep(60);
	assert.equal(plugin.tomatoKey.dataset.visible, 'true');
	assert.equal(plugin.tomatoKey.style.left, '778px');
	assert.equal(plugin.tomatoKey.style.top, '508px');
	assert.equal(plugin.tomatoKey.style.width, '34px');
});

test('an unreachable host bridge fails quietly instead of posting a visible message', async () => {
	const plugin = await loadPlugin({ stop: true, draft: '', failFetch: true });
	active = plugin;
	await sleep(60);
	plugin.tomatoKey.dispatchEvent(new plugin.dom.window.MouseEvent('click', { bubbles: true }));
	await sleep(1150);
	assert.equal(plugin.hostCalls.length, 1, 'the bridge was attempted');
	// Never fall back to a queued user prompt: that is precisely what the
	// plugin must not add to the conversation.
	assert.equal(plugin.calls.prompt.length, 0);
	assert.equal(plugin.tomatoKey.dataset.failed, 'true', 'the key flags the failed delivery');
	assert.equal(plugin.dom.window.localStorage.getItem('dsh-throwtomatoes:count:v1'), null,
		'a refused throw must not inflate the counter');
});

test('a throw survives the key hiding inside the streak window', async () => {
	const plugin = await loadPlugin({ stop: true, draft: '' });
	active = plugin;
	await sleep(60);

	plugin.tomatoKey.dispatchEvent(new plugin.dom.window.MouseEvent('click', { bubbles: true }));
	// The composer leaves the viewport while the streak window is still open: the
	// key hides itself and clears its bound seat before the streak flushes.
	plugin.composer.card.getBoundingClientRect = () => rect(20, -5000, 800, 150);
	plugin.dom.window.document.dispatchEvent(new plugin.dom.window.Event('input'));
	await sleep(80);
	assert.equal(plugin.tomatoKey.dataset.visible, 'false', 'the key must hide once the composer is gone');

	await sleep(1100);
	assert.equal(plugin.hostCalls.length, 1, 'the captured seat still delivers the throw');
	assert.equal(plugin.hostCalls[0].body.hits, 1);
});

test('a throw follows the conversation the composer now shows', async () => {
	const plugin = await loadPlugin({ stop: true, draft: '', sessionAttr: 'session-first' });
	active = plugin;
	await sleep(60);

	// Switching conversations swaps the attribute on the ancestor in place, so
	// the id captured when the seat mounted is the one the user just left.
	const holder = plugin.composer.card.closest('[data-conversation-session]');
	holder.setAttribute('data-conversation-session', 'session-second');

	plugin.tomatoKey.dispatchEvent(new plugin.dom.window.MouseEvent('click', { bubbles: true }));
	await sleep(1150);
	assert.equal(plugin.hostCalls.length, 1);
	assert.equal(plugin.hostCalls[0].body.sessionId, 'session-second');
});
