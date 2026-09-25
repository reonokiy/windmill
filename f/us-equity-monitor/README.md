# 美股 Telegram 提醒

每五分钟由 Windmill 触发 pi agent，按需查询 Finnhub 行情和新闻，生成 2–4 句
中文意见，与股票价格、涨跌幅、报价时间一起发送到 Telegram。
不生成报告文件，不读写 B2，也不保留上一轮分析。Windmill 自身仍会记录运行结果。
默认股票池：SPY、QQQ、AAPL、MSFT、NVDA、AMZN、GOOGL、META、TSLA。

## 配置

1. `mise run install` 安装依赖，`mise run pi:login` 完成模型 OAuth 登录。
2. 在 Windmill 创建 secret variable `u/reonokiy/us_equity_pi_auth`，值为本地
   `.pi-auth.json` 的完整 JSON；运行身份需有读取和更新权限，以保存刷新后的凭据。
   该凭据只供此任务使用，配置完成后删除本地临时副本。
3. 创建 secret variable `u/reonokiy/us_equity_finnhub_key`，填写 Finnhub API key。
4. 创建 secret variable `u/reonokiy/us_equity_telegram_bot_token` 和
   `u/reonokiy/us_equity_telegram_chat_id`。机器人必须有向目标聊天发送消息的权限。
5. 同步代码，手动运行 `f/us-equity-monitor/monitor`，检查 Telegram 实际收信。
6. 将 `every-five-minutes.schedule.yaml` 的 `enabled` 改为 `true` 后同步。

当前调度保持禁用；cron 为 `0 */5 * * * *`，全天每五分钟运行。
`no_flow_overlap: true` 防止定时任务重叠，不要同时手动执行并共用 OAuth 凭据。
默认模型为 `openai-codex` / `gpt-5.3-codex`，可通过 schedule 参数修改。
每轮最多 12 次模型调用、240 秒；flow 超时 270 秒；HTTP 超时 15 秒。

## 消息与失败处理

行情行由程序根据查询结果生成，不由模型填写价格。保留每只股票的报价时间，
超过 15 分钟的数据标为过期，无效数据明确标注。市场状态查询失败时显示未知。
意见目标为 300 字以内，最多接受 1000 字符，整条消息最多 4096 字符；超长直接失败，
不截断风险条件。没有获取完整股票池行情或任何新闻查询结果、模型失败、超时、
空输出时均不发送。新闻为空时模型应说明证据不足。

通过 Telegram sendMessage 发送纯文本，关闭链接预览。不自动重试发送；网络超时
时可能已送达，应先检查聊天再重跑。API 错误不会输出含 token 的 URL 或响应正文。
行情实时性取决于数据源；不推断用户持仓。

## 本地运行

在 `.env` 配置 `PI_AUTH_JSON`（完整 pi 认证 JSON）、`FINNHUB_API_KEY`、
`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`，
然后执行 `mise run equity:local -- AAPL MSFT NVDA`。这会实际发送一次 Telegram 消息。
`mise run pi:login` 输出的 `.pi-auth.json` 可用于设置 `PI_AUTH_JSON`；运行时只读
环境变量，不自动读取认证文件。可用 `PI_PROVIDER`、`PI_MODEL`、`EQUITY_HORIZON`
覆盖默认设置。本应用无需任何 B2 凭据。

`f/lib/finnhub.ts` 封装 Finnhub 行情和新闻查询；模型仅在调用工具后获得数据。
本地与 Windmill 共用 `analyzeAndNotify()`，发送结果返回 messageId 和消息文本。
`mise run verify` 执行类型检查、离线测试和 CI lint，不发送真实消息。

Telegram API 参考：https://core.telegram.org/bots/api#sendmessage

## 统一凭据接口

`secrets.ts` 将逻辑名称 `auth`、`finnhub`、`telegramBot`、`telegramChat` 映射到
Windmill secret variable 和对应环境变量。是否存在 `WM_JOB_ID` 决定读取来源；
业务函数无需选择后端，本地仅配置 Windmill CLI 凭据不会误读远程 secrets。

本地环境变量只读，`set/setJson` 明确拒绝，不修改进程环境或 `.env`。
本地 OAuth 凭据过期后需重新登录并更新 `PI_AUTH_JSON`，程序不会尝试无法保存的刷新。
远程 OAuth 刷新通过 `setJson()` 保存回 Windmill secret；读取失败不会回退到本地。
