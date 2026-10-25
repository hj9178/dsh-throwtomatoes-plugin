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
 * Reminders waiting for the next request of one agent.
 *
 * A `WeakMap` keyed by the agent means a reminder can never leak into another
 * conversation and disappears with the agent it belongs to. A second throw
 * before the first one landed merges into it, so a burst reads as one stronger
 * note instead of a stack of near-identical ones.
 *
 * @type {WeakMap<object, { text: string, summary: string, hits: number, heavy: boolean, at: number, timer?: ReturnType<typeof setTimeout> }>}
 */
const armed = new WeakMap();

/**
 * A reminder that nobody ever claimed is dropped after this long.
 *
 * The window has to outlast the running task: a light throw only lets the
 * current turn finish, which can legitimately take minutes.
 */
const ARM_TTL_MS = 30 * 60_000;

/** How long to wait before checking again whether the loop can be woken. */
const RETRY_MS = 400;

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

/**
 * Arm a reminder for the next request of one agent, merging an unclaimed one.
 *
 * Two tomatoes thrown before the first one landed must read as one stronger
 * reminder, not as "whatever was thrown last". A hard throw in the pair has
 * already interrupted the turn, so the merged notice keeps saying so.
 */
function arm(agent, notice) {
	const pending = armed.get(agent);
	const alive = pending !== undefined && Date.now() - pending.at <= ARM_TTL_MS;
	const hits = (alive ? pending.hits : 0) + notice.hits;
	const heavy = alive ? pending.heavy || notice.heavy : notice.heavy;
	const item = {
		text: (heavy ? heavyText : lightText)(hits),
		summary: heavy ? `🍅 扔了 ${hits} 个番茄，已强行中断当前任务` : `🍅 扔了 ${hits} 个番茄`,
		hits,
		heavy,
		at: alive ? pending.at : Date.now(),
		timer: alive ? pending.timer : undefined,
	};
	armed.set(agent, item);
	return item;
}

/**
 * Take the reminder armed for the agent entering this step, if any.
 *
 * The dispatch injects `agent` into every agent event payload, so the reminder
 * is found by identity — it can never be handed to a different conversation.
 * The turn/step check keeps it to the step that opens a turn: a light throw
 * must let the running task finish, and the wake below opens exactly that turn.
 *
 * @param {{ agent?: object, turn?: number, step?: number }} payload
 */
function claimArmed(payload) {
	const agent = payload?.agent;
	if (agent === undefined || agent === null) return null;
	const item = armed.get(agent);
	if (item === undefined) return null;
	if (Date.now() - item.at > ARM_TTL_MS) {
		armed.delete(agent);
		return null;
	}
	const phase = agent.phase;
	if (phase?.kind !== 'running') return null;
	if (phase.turn !== payload.turn || phase.step !== payload.step - 1) return null;
	if (item.timer !== undefined) clearTimeout(item.timer);
	armed.delete(agent);
	return item;
}

/**
 * Open the turn that will carry the reminder, once the loop is free.
 *
 * `wakeDriver` on an idle loop starts a turn boundary synchronously, which is
 * what turns "the moment the task ends" into "the next model request". Two
 * states cannot honour a wake right away, and both are common during heavy
 * work:
 *
 *   - a running phase, which only latches the wake and never replays it for a
 *     reminder that lives outside the inbox;
 *   - a maintenance phase (context compaction, housekeeping). Its status reads
 *     `idle`, so no `agent/status` transition will ever announce its end, and
 *     its own replay is guarded by `inbox.hasPending`, which is false for us.
 *
 * So a wake that does not actually flip the phase to `running` is retried on a
 * short timer, bounded by the arm TTL rather than by a counter: a long task is
 * a legitimate wait, a wedged loop is not.
 *
 * @param {object} agent
 */
function wakeNow(agent) {
	const pending = armed.get(agent);
	if (pending === undefined) return;
	if (typeof agent?.wakeDriver !== 'function') return;
	if (pending.timer !== undefined) {
		clearTimeout(pending.timer);
		pending.timer = undefined;
	}
	if (Date.now() - pending.at > ARM_TTL_MS) {
		armed.delete(agent);
		return;
	}
	// A running phase must be allowed to finish; `agent/status` and `whenIdle`
	// both bring us back here when it does.
	if (agent.status !== 'idle') return;
	// A maintenance phase is idle from the outside, so it needs the timer.
	if (agent.phase?.kind !== 'idle') {
		scheduleRetry(agent, RETRY_MS);
		return;
	}
	try {
		agent.wakeDriver();
	} catch {
		scheduleRetry(agent, RETRY_MS);
		return;
	}
	// `wakeDriver` opens the phase synchronously; anything else means the wake
	// was latched somewhere that will not replay it.
	if (agent.phase?.kind !== 'running') scheduleRetry(agent, RETRY_MS);
}

/**
 * Retry a wake after a short delay, replacing any earlier retry.
 * @param {object} agent
 * @param {number} delay
 */
function scheduleRetry(agent, delay) {
	const pending = armed.get(agent);
	if (pending === undefined) return;
	if (pending.timer !== undefined) clearTimeout(pending.timer);
	const timer = setTimeout(() => wakeNow(agent), delay);
	timer.unref?.();
	pending.timer = timer;
}

/**
 * Ask for a wake from outside the loop's own tick.
 *
 * Waking from inside the `agent/status` emit would start a driver while the
 * previous one is still unwinding its `finally` block, so the wake is deferred
 * by a macrotask and re-checks the phase it finds.
 *
 * @param {object} agent
 */
function wakeSoon(agent) {
	const pending = armed.get(agent);
	if (pending === undefined) return;
	if (pending.timer !== undefined) clearTimeout(pending.timer);
	const timer = setTimeout(() => wakeNow(agent), 0);
	timer.unref?.();
	pending.timer = timer;
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
	const item = arm(agent, { hits, heavy });
	// The reminder never enters the inbox: an inbox message would be rendered as
	// a turn trigger by the chat view. Arming it and opening the next turn means
	// the model reads it inside its next request, and the client shows nothing.
	if (agent.status === 'idle') wakeNow(agent);
	else if (typeof agent.whenIdle === 'function') {
		try {
			Promise.resolve(agent.whenIdle()).then(() => wakeSoon(agent), () => wakeSoon(agent));
		} catch {
			wakeSoon(agent);
		}
	}
	return { ok: true, heavy: item.heavy, stopped };
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
	// Merge the armed reminder into the very next model request of that agent.
	// `prepend` keeps this ahead of the stock runtime-context provider so the
	// reminder reads last inside the assembled request.
	ctx.on('agent/pre-step', async (payload, next) => {
		const decision = await next();
		if (decision?.kind === 'reject' || payload?.signal?.aborted === true) return decision;
		// Only the first step of a turn carries the reminder. A light throw has
		// to let the running task finish, and the wake opens exactly that turn;
		// injecting mid-turn would change what the model is already doing.
		if (payload?.step !== 1) return decision;
		const item = claimArmed(payload);
		if (item === null) return decision;
		const messages = Array.isArray(decision.messages) ? decision.messages : [];
		return {
			...decision,
			messages: [...messages, noticeMessage(item.text, item.summary)],
		};
	}, { prepend: true });

	// The moment a turn releases the loop, retry the wake. Waiting for it from
	// the throw itself is not enough: a run that is long, aborted or wrapped in
	// maintenance can go idle in between the two observations.
	ctx.on('agent/status', ({ agent, status }) => {
		if (status !== 'idle') return;
		if (!armed.has(agent)) return;
		wakeSoon(agent);
	});

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
