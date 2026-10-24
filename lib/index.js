/**
 * dsh-throwtomatoes-plugin — host half.
 *
 * The browser half owns the tomato key and its effects. This half is the only
 * place that can reach the model request itself: it exposes one same-origin
 * HTTP endpoint, and a tomato press arms a one-shot reminder that is merged
 * into the next LLM request by the `agent/pre-step` waterfall.
 *
 * That path never appends a session event, so nothing shows up in the
 * conversation: the model reads the reminder in the request, the user does not
 * get a synthetic message. A light throw arms the reminder and lets the current
 * turn finish; a heavy throw interrupts the turn first, then restarts it with
 * the reminder armed.
 */

import { randomUUID } from 'node:crypto';

export const name = 'dsh-throwtomatoes-plugin';

export const inject = ['webServer'];

/** Prefix the browser half posts to. Keep in sync with `lib/client.js`. */
const ROUTE = '/_dsh/throwtomatoes';

/** Hard cap on the request body so a stray client cannot balloon host memory. */
const MAX_BODY_BYTES = 8 * 1024;

/** A reminder that was never claimed is dropped after this long. */
const ARM_TTL_MS = 120_000;

/** Source identity the model sees on the injected request-only message. */
const SOURCE_KIND = 'runtime-context';

/** @type {Map<string, { text: string, summary: string, armedAt: number }>} */
const armed = new Map();

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error('request body too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8').trim();
			if (raw.length === 0) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(raw));
			} catch (error) {
				reject(error);
			}
		});
		req.on('error', reject);
	});
}

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(body),
	});
	res.end(body);
}

/** The session key both halves agree on: the agent id, else its session id. */
function sessionKey(agent) {
	const fromSession = agent?.session?.id;
	if (typeof fromSession === 'string' && fromSession.length > 0) return fromSession;
	const fromAgent = agent?.id;
	return typeof fromAgent === 'string' && fromAgent.length > 0 ? fromAgent : '';
}

/**
 * The message the model reads. It is request-only: the waterfall result feeds
 * `buildRequest` and is never committed as a session event, so the transcript
 * stays exactly as the user typed it and as the model wrote it.
 */
function noticeMessage(text, summary) {
	return {
		id: randomUUID(),
		role: 'user',
		content: [{ type: 'text', text }],
		source: {
			kind: SOURCE_KIND,
			form: 'notice',
			summary,
		},
	};
}

function lightText(hits) {
	const opening = hits > 1
		? `🍅 用户朝你扔了 ${hits} 个番茄，表示刚才的做法不对。`
		: '🍅 用户朝你扔了一个番茄，表示刚才的做法不对。';
	return `【扔番茄】${opening}

用户对刚才的做法不满意。当前任务已经结束（或即将结束），请按下面的要求做：

1. 先承认错误：明确指出你刚才哪一步做错了、为什么用户会不认可。
2. 深入思考「不该这么做的话，应该怎么做」：在思考过程里完整推演替代方案，包括应当先确认什么、应当改动哪些地方、以及如何避免同样的问题再次出现。
3. 本轮不要修改任何文件，也不要继续原任务，只做反思与方案。
4. 反思完成后，用 ask_user_question 工具把你的替代方案作为选项提问用户，简要说明每个选项的取舍；等用户回答后，再严格按用户的答复继续。

说明：这条提醒由用户点击番茄键触发，是系统注入到本次模型请求里的，不是用户手打的内容，也不会出现在对话记录里。`;
}

function heavyText(hits) {
	return `【扔番茄】🍅 用户怒气冲冲地朝你连扔了 ${hits} 个番茄，并且已经强行中断了刚才的任务。

用户认为刚才的做法明显不对。请立刻停下原有思路，按下面的要求做：

1. 先承认错误：明确指出你刚才哪一步做错了、为什么用户会不认可。
2. 深入思考「不该这么做的话，应该怎么做」：在思考过程里完整推演替代方案，包括应当先确认什么、应当改动哪些地方、以及如何避免类似问题再次出现。
3. 本轮不要修改任何文件，也不要继续原任务，只做反思与方案。
4. 反思完成后，用 ask_user_question 工具把你的替代方案作为选项提问用户，简要说明每个选项的取舍；等用户回答后，再严格按用户的答复继续。

说明：这条提醒由用户点击番茄键触发，是系统注入到本次模型请求里的，不是用户手打的内容，也不会出现在对话记录里。`;
}

/** Arm a reminder for the next request of one agent. */
function arm(agent, text, summary) {
	const key = sessionKey(agent);
	if (key.length === 0) return false;
	armed.set(key, { text, summary, armedAt: Date.now() });
	return true;
}

/** Start (or keep) a turn so the armed reminder reaches a model request. */
function wake(agent) {
	if (typeof agent?.wakeDriver !== 'function') return;
	try {
		agent.wakeDriver();
	} catch {
		/* the driver refuses to restart while a turn owns the phase; the next
		 * natural turn picks the reminder up instead. */
	}
}

/**
 * Turn one tomato press into host-side agent work.
 * @returns {{ ok: boolean, heavy: boolean, stopped: boolean, error?: string }}
 */
function throwTomato(ctx, { sessionId, hits, heavy }) {
	const agents = ctx.get('agents');
	const agent = agents?.get?.(sessionId);
	if (agent === undefined || agent === null) {
		return { ok: false, heavy, stopped: false, error: 'agent-unavailable' };
	}
	const text = heavy ? heavyText(hits) : lightText(hits);
	const summary = heavy
		? `🍅 连扔 ${hits} 个番茄，已中断当前任务`
		: `🍅 扔了 ${hits} 个番茄`;
	if (!arm(agent, text, summary)) {
		return { ok: false, heavy, stopped: false, error: 'unsupported-agent' };
	}
	let stopped = false;
	if (heavy && agent.status === 'running') {
		// Same shape as the composer's own stop key, so queued user input survives.
		agent.cancel({ kind: 'user' }, { keepInbox: true });
		stopped = true;
	}
	// Wait for the current turn to release the phase, then start the turn that
	// carries the reminder. A light throw therefore lands right after the
	// running task finishes; a heavy one lands right after the interrupt.
	const restart = () => {
		if (armed.has(sessionKey(agent))) wake(agent);
	};
	if (typeof agent.whenIdle === 'function') {
		try {
			Promise.resolve(agent.whenIdle()).then(restart, restart);
		} catch {
			restart();
		}
	} else {
		restart();
	}
	return { ok: true, heavy, stopped };
}

function createHandler(ctx) {
	return async (req, res) => {
		const rawUrl = req.url ?? '/';
		const pathname = rawUrl.split('?')[0];
		if (pathname !== `${ROUTE}/throw`) {
			sendJson(res, 404, { ok: false, error: 'not-found' });
			return;
		}
		if (req.method !== 'POST') {
			sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
			return;
		}
		let body;
		try {
			body = await readJsonBody(req);
		} catch {
			sendJson(res, 400, { ok: false, error: 'bad-json' });
			return;
		}
		const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
		const hits = Number(body.hits);
		if (sessionId.length === 0 || !Number.isFinite(hits) || hits <= 0) {
			sendJson(res, 400, { ok: false, error: 'bad-request' });
			return;
		}
		const heavy = body.heavy === true || hits >= 3;
		try {
			const result = throwTomato(ctx, { sessionId, hits: Math.floor(hits), heavy });
			sendJson(res, result.ok ? 200 : 409, result);
		} catch (error) {
			ctx.logger?.warn?.('[throwtomatoes] failed to deliver the tomato notice', error);
			sendJson(res, 500, { ok: false, heavy, stopped: false, error: 'internal' });
		}
	};
}

export function apply(ctx) {
	// Merge the armed reminder into the very next model request of that agent.
	// `prepend` keeps this ahead of the stock runtime-context provider so the
	// reminder reads last inside the assembled request.
	ctx.on('agent/pre-step', async (payload, next) => {
		const decision = await next();
		if (decision?.kind === 'reject' || payload?.signal?.aborted === true) return decision;
		// Only the first step of a turn carries the reminder: a light throw must
		// let the running task finish before the model reconsiders it, and the
		// restart below opens exactly that turn.
		if (payload?.step !== 1) return decision;
		const key = sessionKey(payload?.agent);
		if (key.length === 0) return decision;
		const item = armed.get(key);
		if (item === undefined) return decision;
		armed.delete(key);
		if (Date.now() - item.armedAt > ARM_TTL_MS) return decision;
		const messages = Array.isArray(decision.messages) ? decision.messages : [];
		return {
			...decision,
			messages: [...messages, noticeMessage(item.text, item.summary)],
		};
	}, { prepend: true });

	const webServer = ctx.get('webServer');
	if (webServer === undefined || typeof webServer.register !== 'function') {
		ctx.logger?.warn?.('[throwtomatoes] webServer is unavailable; tomato delivery is disabled');
		return;
	}
	const registered = webServer.register({ kind: 'prefix', path: ROUTE, handler: createHandler(ctx) });
	if (typeof registered === 'function') {
		ctx.effect(() => registered, 'dsh-throwtomatoes-plugin: route');
	} else if (registered !== undefined && registered !== null && typeof registered.then === 'function') {
		ctx.effect(() => () => { void registered.then((dispose) => dispose?.()); }, 'dsh-throwtomatoes-plugin: route');
	}
}
