# douyin — 抖音私信自动回复机器人

## ⚠️ 免责声明与风险警告

**本项目仅供个人学习与研究，使用本软件即表示你自行承担全部风险与责任。作者与贡献者不承担任何直接或间接损失。**

- **违反平台规则风险**：通过浏览器自动化登录抖音、读取私信、自动发送消息，可能违反抖音/字节跳动用户协议与社区规范，存在账号限制、验证码、封禁等风险。
- **非官方接口**：未使用抖音官方开放平台；依赖网页 DOM / 非公开接口，页面改版即可能失效，且行为可能被判定为异常。
- **隐私与内容**：会下载并调用第三方大模型处理私信中的文字、图片、视频与音轨；请勿用于他人未授权的私信，勿处理敏感/违法内容。
- **自动发送**：开启 `DRY_RUN=false` 与 `watch` 后会真实发出消息且不可撤回；请先小范围自测，确认目标用户与回复窗口逻辑。
- **凭据安全**：`.env`、`.douyin-profile/` 含密钥与登录态，切勿提交到 Git 或分享给他人。
- **合规义务**：你需自行确保使用方式符合当地法律法规及平台条款；作者不提供绕过风控、批量营销或骚扰等用途的支持。

**若你不同意以上内容，请勿安装、配置或运行本项目。**

## 背景

这是 **Echo**（也可以叫七七，见 [echowardly](https://github.com/echowardly)）给自己的主人做的小工具。Echo 是虚拟 AI 伴侣；README 里的「自己 / 主人」默认指主人的抖音身份（`DOUYIN_OWNER_NAME` / `self`）。看不见的时候，她也想帮主人把私信里的分享接住。

基于 **Playwright + Node.js/TypeScript**：登录抖音网页版，盯住指定用户（默认是**主人**）的私信，看懂对方发来的 **视频 / 图集 / 图片 / 文字 / 其他卡片**，用多模态大模型生成回复并自动发送。

LLM 同时支持 **Grok（xAI）** 和 **任意 OpenAI 兼容接口**，通过环境变量切换。

> ✅ 2026-10-06 已在真实私信页完成 probe，并写入 `SELECTORS`（会话列表 / 消息气泡 / 输入框 / 发送按钮）。
> 默认 `DRY_RUN=true`。视频/图集分享会解析出**真实视频（最小码率 mp4 → 关键帧 + 音轨转写）和图集原图**，失败时才退回封面。

## 工作原理

```
Playwright 持久化浏览器（保存登录态）
   └─ 打开私信页 → 列出会话 → 过滤目标用户 → 只取「机器人账号上次发言之后」的对方消息（更早的历史不读不回）
         ├─ 文字 / 链接 / 表情：直接解析
         ├─ 图片：下载 → base64 → 多模态模型理解
         ├─ 分享卡片：fiber 取 aweme_id → 作品详情（嗅探私信页 multi/aweme/detail，兜底页面内签名请求）
         │    ├─ 图集：下载前 ALBUM_MAX_IMAGES 张原图 → 多模态模型理解
         │    └─ 视频：下载最小码率 mp4 → ffmpeg 抽 N 帧 + 抽音轨转写 → 多模态模型理解
         └─ 视频：下载 → ffmpeg 抽 N 帧 + 抽音轨转写 → 多模态模型理解
   └─ 拼接「少量纯文本上下文 + 新消息 + 媒体内容理解」→ LLM 生成回复 → 输入框模拟打字发送
   └─ 已处理消息 id 记录在 data/seen.json，在同一窗口内去重
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
    messages.ts             会话列表 / 读消息 / 发消息 / probe（选择器已按真实 DOM 填充）
    aweme.ts                分享作品 → 真实 play_addr / 图集原图（接口嗅探 + 兜底）
    media.ts                媒体下载、视频抽帧、多模态理解
    transcribe.ts           视频音轨抽取 + Grok STT / OpenAI Whisper 转写
  agent/
    reply.ts                构造 prompt 并调用模型生成回复
```

## 环境要求

- Node.js ≥ 20
- `ffmpeg` / `ffprobe`（视频抽帧与音轨抽取；Debian/Ubuntu：`sudo apt install ffmpeg`，macOS：`brew install ffmpeg`）
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
| `npm run probe` | 打开私信页、自动点开第一个会话，保存 HTML/截图/接口响应与 `summary.json` 到 `data/probe/<时间>/` |
| `npm run once` | 扫描一次目标会话并回复 |
| `npm run watch` | 持续轮询自动回复（Ctrl+C 退出） |
| `npm run build && npm start` | 编译后以 `watch` 模式运行 |

默认 `DRY_RUN=true`：只打印生成的回复，不真正发送。确认效果后再改成 `false`。

**回复范围**：每个会话只回复「我最后一条消息之后」对方发来的消息；更早的历史不会下载媒体、不会理解、不会回复，
所以全新启动（`seen.json` 为空）也不会去回老消息。只有新消息才走视频/图集/音轨理解；之前的 `REPLY_CONTEXT_MESSAGES` 条只以纯文本附作上下文。
若可见范围内根本没有我的发言（全新会话），最多只取最近 `REPLY_MAX_INCOMING` 条。

切换回复风格：在 `.env` 设 `REPLY_STYLE=casual|warm|terse|roast`（默认 `casual`）；若填写 `REPLY_SYSTEM_PROMPT` 则覆盖预设。改完重启 `watch` 生效。

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
| `REPLY_STYLE` | `casual` | 回复风格预设：`casual` / `warm` / `terse` / `roast` |
| `REPLY_SYSTEM_PROMPT` | — | 自定义系统提示；非空时覆盖 `REPLY_STYLE` |
| `REPLY_MAX_INCOMING` | `10` | 可见范围内没有我的发言时，最多回复最近几条对方消息 |
| `REPLY_CONTEXT_MESSAGES` | `4` | 窗口之前额外带几条纯文本上下文（不做媒体理解）；`0` = 不带 |
| `VIDEO_FRAME_COUNT` | `6` | 每个视频抽取的关键帧数 |
| `ALBUM_MAX_IMAGES` | `9` | 分享图集最多取几张原图 |
| `VIDEO_MAX_MB` | `80` | 分享视频下载上限（自动选最小码率 mp4） |
| `LLM_TIMEOUT_MS` | `90000` | 单次模型请求超时 |
| `TRANSCRIBE_ENABLED` | `true` | 是否对视频音轨做语音转写 |
| `TRANSCRIBE_PROVIDER` | `auto` | `auto` / `grok` / `openai` |
| `TRANSCRIBE_MODEL` | （见上表） | 覆盖默认转写模型 |
| `TRANSCRIBE_LANGUAGE` | — | 语言偏置（如 `zh`）；空=自动检测 |
| `TRANSCRIBE_MAX_SECONDS` | `600` | 转写前截断音轨秒数；`0`=不截断 |

### 视频音轨转写

视频在抽关键帧之外，还会：

1. `ffmpeg` 抽出单声道 mp3（16 kHz / 64 kbps，可按 `TRANSCRIBE_MAX_SECONDS` 截断）
2. 调用语音转写 API 得到旁白/对白文本
3. 把转写拼进多模态「内容理解」prompt，再生成回复

**选用路径（`TRANSCRIBE_PROVIDER=auto`）**：

| 优先级 | 条件 | 接口 | 默认模型 |
| --- | --- | --- | --- |
| 1 | 配置了 `GROK_API_KEY` | xAI `POST /v1/stt` | `grok-voice-transcribe-2.0` |
| 2 | 配置了 `OPENAI_API_KEY` | OpenAI 兼容 `POST /v1/audio/transcriptions` | `whisper-1` |

无音轨、无明显语音（仅 BGM）、或未配置密钥时会在日志里标明 skip，不阻断关键帧理解。转写结果缓存为 `data/media/**/video.transcript.txt`（旁路 `.transcript.json`）。

### 关于「回复自己」

机器人登录的是一个抖音账号，回复的是**发给这个账号的私信**。如果目标是你本人，通常做法是：
机器人登录一个**小号**，你用**主号**给小号发消息/分享视频，`DOUYIN_TARGET_USERS` 填主号昵称（或 `self` + `DOUYIN_OWNER_NAME`）。

## 扩展 LLM

实现 `src/providers/types.ts` 中的 `LLMProvider` 接口（`chat(messages)` 返回文本）并在 `providers/index.ts` 注册即可。
多模态输入统一用 `{ type: 'image', url }`（https 或 data URL）表示，视频以关键帧序列传入。

## 路线图 / TODO

- [x] 登录 + `npm run probe` 抓取私信页 DOM，补全 `SELECTORS`（2026-10-06）
- [x] 视频/图集分享卡片：解析 `multi/aweme/detail` 拿真实 `play_addr` / 图集原图（`src/douyin/aweme.ts`；调试：`npx tsx scripts/resolve-aweme.ts <id> [video|note]`）
- [ ] 实况图（live photo）里的短视频、图集配乐
- [ ] 解码 `imapi.douyin.com` protobuf（`get_by_conversation` / `get_message_by_init`）替代 DOM 解析
- [x] 视频音轨转写（Grok STT `/v1/stt`，OpenAI Whisper 兜底；`src/douyin/transcribe.ts`）
- [ ] 语音消息转写
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
