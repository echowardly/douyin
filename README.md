# douyin — 抖音私信自动回复机器人

基于 **Playwright + Node.js/TypeScript** 的浏览器自动化机器人：登录抖音网页版，盯住指定用户（默认是你自己）的私信，
看懂对方发来的 **视频 / 图集 / 图片 / 文字 / 其他卡片**，用多模态大模型生成回复并自动发送。

LLM 同时支持 **Grok（xAI）** 和 **任意 OpenAI 兼容接口**，通过环境变量切换。

> ⚠️ 当前为 **脚手架阶段**：项目结构、登录、LLM 调用、视频抽帧、去重、轮询循环已可运行；
> **抖音私信页的 DOM 选择器尚未在真实页面验证**（见 `src/douyin/messages.ts` 中的 `TODO(probe)`）。
> 下一步是登录后执行 `npm run probe` 抓取真实 DOM / 接口，再补全选择器。

## 工作原理

```
Playwright 持久化浏览器（保存登录态）
   └─ 打开私信页 → 列出会话 → 过滤目标用户 → 读取新消息
         ├─ 文字 / 链接 / 表情：直接解析
         ├─ 图片 / 图集：下载 → base64 → 多模态模型理解
         └─ 视频：下载 → ffmpeg 均匀抽 N 帧 → 多模态模型理解
   └─ 拼接「最近聊天 + 新消息 + 媒体内容理解」→ LLM 生成回复 → 输入框模拟打字发送
   └─ 已处理消息 id 记录在 data/seen.json，避免重复回复
```

## 目录结构

```
src/
  config.ts                 环境变量（zod 校验）
  index.ts                  CLI：login | probe | once | watch
  state.ts                  已处理消息去重
  providers/
    types.ts                LLMProvider 接口、多模态消息类型
    openai-compatible.ts    OpenAI 兼容 /chat/completions 实现
    grok.ts                 Grok（xAI，https://api.x.ai/v1）
    index.ts                createProvider() 工厂
  douyin/
    browser.ts              启动持久化 Chromium、登录态检测
    login.ts                打开抖音，等待扫码登录
    messages.ts             会话列表 / 读消息 / 发消息 / probe（选择器待探测）
    media.ts                媒体下载、视频抽帧、多模态理解
  agent/
    reply.ts                构造 prompt 并调用模型生成回复
```

## 环境要求

- Node.js ≥ 20
- `ffmpeg` / `ffprobe`（视频抽帧用；Debian/Ubuntu：`sudo apt install ffmpeg`，macOS：`brew install ffmpeg`）
- 一个有图形界面的环境用于首次扫码登录（远程机器可通过远程桌面操作）

## 安装

```bash
npm install          # 会自动执行 playwright install chromium
cp .env.example .env # 然后编辑 .env
npm run typecheck    # 可选：类型检查
```

Linux 若缺少浏览器系统依赖：`npx playwright install --with-deps chromium`。

## 登录流程

1. `.env` 中保持 `HEADLESS=false`
2. 运行 `npm run login`，会弹出 Chromium 打开抖音首页
3. 点击右上角「登录」，用抖音 App 扫码（可能需要短信 / 滑块验证，手动完成即可）
4. 检测到 `sessionid` cookie 后自动保存登录态到 `.douyin-profile/`，之后无需重复登录
5. 登录态过期时重新执行 `npm run login`

> `.douyin-profile/` 含账号 cookie，等同于登录凭证，已被 `.gitignore` 忽略，**切勿提交或分享**。

## 使用

| 命令 | 作用 |
| --- | --- |
| `npm run login` | 扫码登录并保存登录态 |
| `npm run probe` | 打开私信页 30 秒（可手动点开会话），把 HTML、截图、私信相关 JSON 响应保存到 `data/probe/<时间>/`，用于确定选择器 |
| `npm run once` | 扫描一次目标会话并回复 |
| `npm run watch` | 持续轮询自动回复（Ctrl+C 退出） |
| `npm run build && npm start` | 编译后以 `watch` 模式运行 |

默认 `DRY_RUN=true`：只打印生成的回复，不真正发送。确认效果后再改成 `false`。

## 配置（.env）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DOUYIN_TARGET_USERS` | `self` | 需要自动回复的用户，逗号分隔，昵称或抖音号；`self` 表示你自己 |
| `DOUYIN_OWNER_NAME` | — | 你自己的昵称/抖音号，用于把 `self` 匹配到具体会话 |
| `DOUYIN_CHAT_URL` | `https://www.douyin.com/chat` | 私信页入口（以探测结果为准） |
| `DOUYIN_PROFILE_DIR` | `.douyin-profile` | 浏览器登录态目录 |
| `HEADLESS` | `false` | 无头模式；首次登录必须为 false |
| `POLL_INTERVAL_MS` | `15000` | 轮询间隔（自动加 ±30% 随机抖动） |
| `DRY_RUN` | `true` | 只生成不发送 |
| `DATA_DIR` | `data` | 媒体、去重记录、probe 输出 |
| `PROVIDER` | `grok` | `grok` 或 `openai` |
| `GROK_API_KEY` / `GROK_BASE_URL` / `GROK_MODEL` | — / `https://api.x.ai/v1` / `grok-4` | Grok 配置（模型需支持图片输入） |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | — / `https://api.openai.com/v1` / `gpt-4o` | 任意 OpenAI 兼容接口 |
| `REPLY_SYSTEM_PROMPT` | 内置 | 自定义回复人设/风格 |
| `VIDEO_FRAME_COUNT` | `6` | 每个视频抽取的关键帧数 |
| `LLM_TIMEOUT_MS` | `90000` | 单次模型请求超时 |

### 关于「回复自己」

机器人登录的是一个抖音账号，回复的是**发给这个账号的私信**。如果目标是你本人，通常做法是：
机器人登录一个**小号**，你用**主号**给小号发消息/分享视频，`DOUYIN_TARGET_USERS` 填主号昵称（或 `self` + `DOUYIN_OWNER_NAME`）。

## 扩展 LLM

实现 `src/providers/types.ts` 中的 `LLMProvider` 接口（`chat(messages)` 返回文本）并在 `providers/index.ts` 注册即可。
多模态输入统一用 `{ type: 'image', url }`（https 或 data URL）表示，视频以关键帧序列传入。

## 路线图 / TODO

- [ ] **登录 + `npm run probe` 抓取私信页 DOM 与接口**，补全 `SELECTORS`（会话项、未读角标、消息项、是否自己发送、输入框、发送按钮）
- [ ] 视频/图集分享卡片：打开作品页拦截真实媒体地址（`play_addr` / 图集图片列表）
- [ ] 考虑改为监听私信接口 JSON（`page.on('response')`）而非解析 DOM，更稳定
- [ ] 语音消息、视频音轨转写（Whisper 等）
- [ ] 每个会话的长期记忆 / 人设
- [ ] 回复频率限制、夜间静默、人工接管开关

## 限制与风险

- **违反平台规则风险**：自动化操作抖音可能违反《抖音用户服务协议》，存在被限流、私信功能受限、甚至封号的风险。建议使用小号，控制频率，仅用于自己的账号之间。
- **风控与验证码**：抖音对自动化浏览器有检测，无头模式下常出现「验证码中间页」（实测在服务器上无头访问首页即触发）。建议有界面运行、复用登录态、保持低频轮询；遇到验证码需人工处理。
- **页面改版**：网页版 DOM 和接口随时变化，选择器需要定期维护。
- **网页版能力限制**：部分消息类型在网页版可能显示不全或无法获取原始媒体。
- **隐私**：聊天内容和媒体会发送给你配置的 LLM 服务商；`data/` 下保存了下载的媒体，注意清理。
- **登录凭证**：`.douyin-profile/` 等同账号凭证，不要放在共享或不受信任的机器上。

## License

MIT
