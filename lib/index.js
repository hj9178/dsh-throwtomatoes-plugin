/**
 * dsh-throwtomatoes-plugin — host half.
 *
 * The browser half owns the tomato key and its effects. This half is the only
 * place that can reach the agent loop: it exposes one same-origin HTTP endpoint,
 * and a tomato press hands the loop a one-shot reminder for its next turn.
 *
 * The reminder never travels through the composer, so it never looks like a
 * user prompt and never waits behind one. It is committed as a `user/message`
 * event whose source kind is not `user`, which is exactly what keeps it out of
 * the conversation the browser renders while the model still receives it.
 *
 * A light throw lets the running task finish and lands right after it, because
 * a pending inbox entry is what makes the loop open the next turn. A heavy
 * throw interrupts the turn first, then hands over the same kind of reminder.
 */

import { randomUUID } from 'node:crypto';

export const name = 'dsh-throwtomatoes-plugin';

export const inject = ['webServer'];

/** Prefix the browser half posts to. Keep in sync with `lib/client.js`. */
const ROUTE = '/_dsh/throwtomatoes';

/** Hard cap on the request body so a stray client cannot balloon host memory. */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * Source identity of the injected message.
 *
 * It must NOT be `runtime-context`: the agent loop treats that kind specially
 * (it only uses it to trigger the stock runtime-context snapshot and then drops
 * the message, so it never reaches the request). Every other kind is committed
 * as a `user/message` event, which is what puts the reminder into the derived
 * history the model request is built from. The browser hides it anyway: the
 * chat view only renders a non-`user` sourced message when its content carries
 * tool-addition/removal blocks, so the reminder stays invisible to the client.
 */
const SOURCE_KIND = 'dsh-throwtomatoes';

/**
 * Reminders handed to the loop, one per agent.
 *
 * A `WeakMap` keyed by the agent means a reminder can never leak into another
 * conversation and disappears with the agent it belongs to. A second throw
 * while the first one is still waiting in the inbox merges into it, so a burst
 * reads as one stronger note instead of a stack of near-identical ones.
 *
 * @type {WeakMap<object, { id: string, hits: number, heavy: boolean, at: number }>}
 */
const delivered = new WeakMap();

/** Two presses closer than this are one throw, not two reflections. */
const MERGE_WINDOW_MS = 15_000;

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		const timer = setTimeout(() => {
			settle(reject, Object.assign(new Error('body read timed out'), { status: 408 }));
			req.destroy();
		}, 5_000);
		timer.unref?.();
		let done = false;
		const settle = (fn, value) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			fn(value);
		};
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				settle(reject, Object.assign(new Error('request body too large'), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8').trim();
			if (raw.length === 0) {
				settle(resolve, {});
				return;
			}
			try {
				settle(resolve, JSON.parse(raw));
			} catch (error) {
				settle(reject, error);
			}
		});
		req.on('error', (error) => { settle(reject, error); });
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

/**
 * The reminder the model reads. The agent loop commits this as a `user/message`
 * event so it joins the next request's derived history; the browser never
 * renders it because its source kind is not `user` (see `SOURCE_KIND`). It is
 * therefore invisible in the conversation while still being part of what the
 * model is sent — the user's own input and the model's own output are never
 * modified.
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
		time: Date.now(),
	};
}

function lightText(hits) {
	const opening = hits > 1
		? `🍅 用户朝你扔了 ${hits} 个番茄，表示刚才的做法不对。`
		: '🍅 用户朝你扔了一个番茄，表示刚才的做法不对。';
	return `【扔番茄】${opening}

用户对刚才的做法不满意。你手上正在做的那一步已经结束，请先停下后续动作，按下面的要求做：

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

/**
 * Withdraw the note that is still waiting in the loop's inbox.
 *
 * A note the loop already claimed is gone from the inbox, so this reports false
 * and the caller starts a fresh count instead of folding presses the model has
 * already been told about.
 *
 * @param {object} agent
 * @param {string} id
 */
function withdrawQueued(agent, id) {
	const inbox = agent?.inbox;
	if (inbox === undefined || inbox === null) return false;
	if (typeof inbox.remove !== 'function') return false;
	try {
		return inbox.remove(id) !== false;
	} catch {
		return false;
	}
}

/**
 * Hand the reminder to the next step boundary of the running loop.
 *
 * `inject` queues the message for the loop's next step and does not wake it: the
 * step in flight finishes first, then the reminder rides the very next model
 * request. That is what separates it from `followup`, which opens a whole new
 * turn and shows up in the client as a queued prompt.
 *
 * @param {object} agent
 * @param {object} message
 */
function handOver(agent, message) {
	if (typeof agent?.inject === 'function') {
		agent.inject(message);
		return true;
	}
	if (typeof agent?.steer === 'function') {
		agent.steer(message);
		return true;
	}
	return false;
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
	let stopped = false;
	if (heavy && agent.status === 'running') {
		// Same shape as the composer's own stop key, so queued user input survives.
		agent.cancel({ kind: 'user' }, { keepInbox: true });
		stopped = true;
	}
	// Fold a burst into one note while the earlier one is still waiting, so a
	// handful of presses reads as one reminder that counts them all instead of a
	// stack of near-identical notes the model has to wade through.
	const previous = delivered.get(agent);
	const mergeable = previous !== undefined
		&& Date.now() - previous.at <= MERGE_WINDOW_MS
		&& withdrawQueued(agent, previous.id);
	const totalHits = (mergeable ? previous.hits : 0) + hits;
	const totalHeavy = (mergeable ? previous.heavy : false) || heavy;
	const message = noticeMessage(
		(totalHeavy ? heavyText : lightText)(totalHits),
		totalHeavy ? `🍅 扔了 ${totalHits} 个番茄，已强行中断当前任务` : `🍅 扔了 ${totalHits} 个番茄`,
	);
	if (!handOver(agent, message)) {
		return { ok: false, heavy, stopped: false, error: 'agent-unavailable' };
	}
	delivered.set(agent, { id: message.id, hits: totalHits, heavy: totalHeavy, at: Date.now() });
	// A step boundary only exists inside a running turn. An idle loop would keep
	// the note in its inbox until the user spoke again, so wake it — one wake is
	// enough, because the pending note is what the loop needs to open the turn.
	if (agent.status === 'idle' && typeof agent.wakeDriver === 'function') {
		try {
			agent.wakeDriver();
		} catch {
			/* the loop refuses to open a turn right now; the note stays queued */
		}
	}
	return { ok: true, heavy: totalHeavy, stopped };
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
		} catch (error) {
			const status = typeof error?.status === 'number' ? error.status : 400;
			sendJson(res, status, { ok: false, error: status === 413 ? 'body-too-large' : 'bad-json' });
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
