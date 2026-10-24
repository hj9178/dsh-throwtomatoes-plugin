/**
 * DOM-level tests for dsh-throwtomatoes-plugin's browser half.
 *
 * The plugin is loaded exactly the way the DSH web bundle loads it: a plain
 * script that calls `window.__ModuleLoader__.load({ id, factory })`. The tests
 * then drive a synthetic composer DOM (the same shape InputBar renders) and
 * assert on what the tomato key does.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'lib', 'client.js');

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
function buildComposer(dom, { stop, draft }) {
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
	primary.getBoundingClientRect = () => rect(750, 470, 32, 32);
	trailing.appendChild(primary);

	row.appendChild(trailing);
	card.appendChild(row);
	document.body.appendChild(card);
	return { card, overlay, editor, primary, plus };
}

/**
 * Load the browser half into a fresh jsdom and return the plugin exports plus
 * the DOM handles the tests drive.
 */
async function loadPlugin(options = {}) {
	const { stop = true, draft = '', settings = {} } = options;
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

	const composer = buildComposer(dom, { stop, draft });

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

	const source = await readFile(clientPath, 'utf8');
	const evaluate = new Function('require', 'window', 'document', 'Element', 'Intl', 'crypto', 'console', source);
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
		getSnapshot: () => ({ running: false }),
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
		? renderComponent(seatSlot.slot.component, { sessionId: 'session-test' })
		: { cleanup: () => {} };

	return {
		dom,
		composer,
		calls,
		registered,
		dispose: () => { seat.cleanup(); dispose(); },
		tomatoKey,
		layer: () => dom.window.document.getElementById('dtt-layer'),
	};
}

let active = null;

afterEach(() => {
	if (active !== null) {
		try { active.dispose(); } catch { /* ignore teardown noise */ }
		active = null;
	}
});

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
	await sleep(30);
	assert.equal(plugin.tomatoKey.dataset.visible, 'false');
});

test('reveals the tomato key while a turn runs and the composer is empty', async () => {
	const plugin = await loadPlugin({ stop: true, draft: '' });
	active = plugin;
	await sleep(30);
	assert.equal(plugin.tomatoKey.dataset.visible, 'true');
	assert.equal(plugin.tomatoKey.style.left, '750px');
	assert.equal(plugin.tomatoKey.style.top, '470px');
	assert.equal(plugin.tomatoKey.style.width, '32px');
	assert.equal(plugin.tomatoKey.style.height, '32px');
});

test('hides the tomato key when the composer has text', async () => {
	const plugin = await loadPlugin({ stop: true, draft: '先别动' });
	active = plugin;
	await sleep(30);
	assert.equal(plugin.tomatoKey.dataset.visible, 'false');
});

test('never forwards the press to the original primary key', async () => {
	const plugin = await loadPlugin({ stop: true, draft: '' });
	active = plugin;
	await sleep(30);
	let primaryClicks = 0;
	plugin.composer.primary.addEventListener('click', () => { primaryClicks += 1; });
	plugin.tomatoKey.dispatchEvent(new plugin.dom.window.MouseEvent('click', { bubbles: true }));
	assert.equal(primaryClicks, 0, 'the primary key must not receive the tomato press');
});

test('one press plays the throw and queues a light reminder', async () => {
	const plugin = await loadPlugin({ stop: true, draft: '' });
	active = plugin;
	await sleep(30);

	plugin.tomatoKey.dispatchEvent(new plugin.dom.window.MouseEvent('click', { bubbles: true }));
	assert.equal(plugin.tomatoKey.querySelector('.dtt-badge').textContent, '1');
	assert.equal(plugin.calls.prompt.length, 0, 'the reminder waits for the streak window');

	await sleep(1150);
	assert.equal(plugin.calls.prompt.length, 1);
	assert.equal(plugin.calls.prompt[0].mode, 'queue');
	assert.match(plugin.calls.prompt[0].content[0].text, /扔番茄/);
	assert.match(plugin.calls.prompt[0].content[0].text, /ask_user_question/);
	assert.equal(plugin.calls.cancel, 0, 'a light throw must not stop the running turn');
	assert.ok(plugin.layer() !== null, 'the effect layer must exist after a throw');
});

test('three rapid presses stop the turn first, then deliver the heavy reminder', async () => {
	const plugin = await loadPlugin({ stop: true, draft: '' });
	active = plugin;
	await sleep(30);

	const click = () => plugin.tomatoKey.dispatchEvent(new plugin.dom.window.MouseEvent('click', { bubbles: true }));
	click();
	click();
	click();
	assert.equal(plugin.calls.cancel, 1, 'the heavy throw stops the running turn');
	await sleep(80);
	assert.equal(plugin.calls.prompt.length, 1);
	assert.equal(plugin.calls.prompt[0].mode, 'queue');
	assert.match(plugin.calls.prompt[0].content[0].text, /已经中断/);
});

test('the tomato key can be used more than once in a conversation', async () => {
	const plugin = await loadPlugin({ stop: true, draft: '' });
	active = plugin;
	await sleep(30);

	const click = () => plugin.tomatoKey.dispatchEvent(new plugin.dom.window.MouseEvent('click', { bubbles: true }));
	click();
	await sleep(1150);
	click();
	await sleep(1150);
	assert.equal(plugin.calls.prompt.length, 2);
	assert.equal(plugin.dom.window.localStorage.getItem('dsh-throwtomatoes:count:v1'), '2');
});

test('respects the effects switch', async () => {
	const plugin = await loadPlugin({ stop: true, draft: '', settings: { effects: false, sound: false } });
	active = plugin;
	await sleep(30);
	plugin.tomatoKey.dispatchEvent(new plugin.dom.window.MouseEvent('click', { bubbles: true }));
	await sleep(30);
	assert.equal(plugin.layer(), null, 'no effect layer when effects are disabled');
	assert.equal(plugin.tomatoKey.querySelector('.dtt-badge').textContent, '1', 'the press still counts');
});
