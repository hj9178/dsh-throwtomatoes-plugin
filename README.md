# dsh-throwtomatoes-plugin

朝模型扔番茄。当模型正在跑任务、而你的输入框是空的时候，输入框右下角的**发送/停止键会变成番茄键**。按下去不会停止任务，也不会发送任何东西——它扔出一个番茄砸向对话区，并让模型停下来反省刚才哪里做错了。

> 兼容 DeepSeek Harness `0.2.1-rc.2`（`dsh.compatibility.dshReleases` 已逐条声明）。

## 它长什么样

```
┌──────────────────────────────────────────┐
│  输入框（为空，正在跑任务）              │
│  +  权限 · 计划          模型 ▾   🍅  ← │
└──────────────────────────────────────────┘
```

- 草稿为空且当前回合运行中：主键位置被番茄键覆盖，点它只扔番茄。
- 一旦你开始打字（或任务结束），番茄键自动隐藏，主键恢复原样。
- 原按钮本身没有被替换、没有被删除、也没有被改状态机；番茄键只是一层盖在它上面的独立按钮，所以原按钮的停止/发送逻辑保持完好。

## 两种扔法

| 短时按的次数 | 效果 |
| --- | --- |
| **少**（1–2 次，1 秒窗口） | 轻扔。不打断当前任务，等这个任务结束后再向模型投递反思要求：承认错误 → 思考「不该这么做该怎么做」→ 用提问工具把替代方案交给你选 → 按你的答复继续。 |
| **多**（1 秒内连按 ≥ 3 次） | 猛扔。先**强制停止**当前任务，再投递同样的反思要求，让模型在干净的上下文里重新想。 |

无论哪种，都会播放「欢乐斗地主」式的丢番茄特效：番茄沿抛物线从按钮飞向对话区、命中后溅射红色粒子、弹出「啪！」、屏幕轻微颤动；音效是合成的破空声 + 命中闷响。特效和音效可以分别关掉。

一次对话里可以无限次使用，没有一次性限制。

## 设置页

「设置 → 扔番茄」里有：

- 🍅 自安装插件以来扔过的**番茄总数**（存在本机浏览器里）；
- **丢番茄特效**开关；
- **音效**开关；
- 「预览特效」和「重置计数」。

## 安装

```bash
# 从 npm（发布后）
dsh plugin add dsh-throwtomatoes-plugin

# 或直接从 GitHub
dsh plugin add github:<你的账号>/dsh-throwtomatoes-plugin
```

装完重启 DeepSeek Harness。插件通过 `cordis.patch.yml` 自动进入 profile 的 bundle 栈，不需要手改配置。

## 它改动了什么（以及没改什么）

- **不改**你的输入：草稿文本、附件、选区都不碰，插件只读取 `contenteditable` 的 `textContent` 判断是否为空。
- **不改**模型输出：不接管渲染、不注入消息、不改轨迹。
- 唯一「新增」的对话内容是模型收到一条由番茄键触发的提醒（`mode: 'queue'`），它出现在对话流里，口气是「用户朝你扔了 N 个番茄」。这是需求本身，也是模型能反思的唯一途径。
- 番茄键是 `position: fixed` 的覆盖层，盖在原生主键上；按下时 `preventDefault + stopPropagation`，原生按钮收不到这次点击。

## 实现要点

- 浏览器半边（`lib/client.js`）按 DSH 客户端模块系统约定注册为 lazy-CJS factory：`window.__ModuleLoader__.load({ id, factory })`，不依赖打包器注入的 `import`。
- 通过 `slots.inject('conversation.input.overlay', …)` 挂一个不可见的「座位」组件，读 `props.sessionId` 并把 `[data-composer-card]` 和会话 id 关联起来。
- 主键定位：取 composer card 内最后一个 `<button>`，并用几何校验（位于卡片右下、尺寸合理）确认它是主键；用 SVG 里有没有 `<rect>` 判断它当前是「停止」还是「发送」。
- 投递：优先 `ctx.get('sessions').binding(sessionId).session.prompt(content, 'queue')` / `.cancel()`；服务不可用时退回 `ctx.get('remote').session.prompt(...)`。
- 设置页通过 `slots.inject('settings.section', …)` 注册，计数与开关存在 `localStorage`。

## 开发

```bash
pnpm install
node --test test/*.test.mjs
```

测试用 jsdom 造一个和 InputBar 同构的 composer DOM（含停止态/发送态、空/非空草稿），按 DSH 的方式加载 bundle，覆盖：模块契约、两个 slot 的注册、显隐条件、不转发点击、轻扔/猛扔的投递与警告文案、可重复使用、特效开关。

## License

MIT
