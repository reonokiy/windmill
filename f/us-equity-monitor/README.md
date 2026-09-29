# 美股 Telegram 提醒

每十分钟由 Windmill 触发 pi agent，按需查询 Finnhub 行情和新闻，生成以最新新闻
催化、超短线买入观察、卖出/回避条件和风险为重点的中文意见。
分析置顶，后附个股涨跌幅和报价时间，不展示绝对股价；指数仅作背景。
不生成报告文件，不读写 B2，也不保留上一轮分析。Windmill 自身仍会记录运行结果。
默认指数参考：SPY、QQQ。默认个股：NVDA、AMD、AVGO、TSM、ASML、AAPL、MSFT、
AMZN、GOOGL、META、TSLA。默认周期为日内至下一个交易日。

## 配置

1. `mise run install` 安装依赖。
2. Windmill 内部调用无需 gateway key：集群 DNS 指向私有 Gateway，Cilium
   限制调用 Pod，Gateway 自动注入后端凭据。模型 OAuth 由网关管理。
3. 创建 secret variable `u/reonokiy/us_equity_finnhub_key`，填写 Finnhub API key。
4. 创建 secret variable `u/reonokiy/us_equity_telegram_bot_token` 和
   `u/reonokiy/us_equity_telegram_chat_id`，以及目标话题的
   `u/reonokiy/us_equity_telegram_thread_id`。机器人必须有向目标话题发送消息的权限。
   本应用要求话题 ID；缺失或无效时停止，不回退到群默认话题。
5. 同步代码，手动运行 `f/us-equity-monitor/monitor`，检查 Telegram 实际收信。
6. 将 `every-five-minutes.schedule.yaml` 的 `enabled` 改为 `true` 后同步。

调度启用；cron 为 `0 */10 * * * *`，全天每十分钟运行。
保留原调度路径 `every-five-minutes`，避免创建重复任务；实际频率以 cron 为准。
`no_flow_overlap: true` 防止定时任务重叠。
默认 provider 为 `codex-gateway`，模型为 `gpt-6-luna`，使用
`https://api.nokiy.net/codex/v1/responses`。每轮从 `/codex/codex/models`
读取模型支持的最高 reasoning effort；2026-09-29 实测 Luna 的最高档为 `max`。
pi 的 `xhigh` 映射到目录中的最高档，不会把 `max` 静默降成 `high`。
接入统一使用 [`f/lib/codex.ts`](../lib/codex.ts)，复用方法见
[共享客户端说明](../lib/codex.md)。凭据在本应用 `secrets.ts` 绑定，业务只选择模型和参数。
网关不接受 `max_output_tokens`，由上游管理 token 预算；应用仍限制意见和消息长度。
每轮最多 100 次模型调用、10 分钟；flow 超时 11 分钟，为凭据读取、模型目录查询
和通知发送预留时间；行情与 Telegram HTTP 超时 15 秒。

## 消息与失败处理

涨跌幅由程序根据查询结果生成，不展示绝对股价。保留每只股票的报价时间，
超过 15 分钟的数据标为过期，无效数据明确标注。运行、报价和新闻展示时间统一使用 UTC+8，
不追加行情来源说明。市场状态查询失败时显示未知。
意见目标为 4–6 行、600 字以内，最多接受 1000 字符，整条消息最多 4096 字符；超长直接失败，
不截断风险条件。没有获取完整股票池行情或任一个股的新闻查询结果、模型失败、超时、
空输出时均不发送。新闻为空时模型应说明证据不足。

通过 Telegram sendMessage 发送纯文本，关闭链接预览。不自动重试发送；网络超时
时可能已送达，应先检查聊天再重跑。API 错误不会输出含 token 的 URL 或响应正文。
行情实时性取决于数据源；不推断用户持仓。
新闻优先最近 24 小时，旧闻须注明时间，不把已知事件或重发新闻包装为新催化。
消息不包含新闻 ID 或 URL，引用仅保留来源名称和发布时间。
现有工具没有分钟K线、成交量、盘口和 VWAP；输出只能给待确认条件，不能把报价
快照伪装成已确认的超短线入场信号。没有明确催化或证据不足时允许全部观望。

## 本地运行

在 `.env` 配置 `CODEX_API_KEY`（Keygate API key）、`FINNHUB_API_KEY`、
`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`TELEGRAM_THREAD_ID`，
然后执行 `mise run equity:local -- AAPL MSFT NVDA`。这会实际发送一次 Telegram 消息。
默认网关模式无需 `PI_AUTH_JSON` 或单独的 Codex OAuth 登录。运行时只读
环境变量。可用 `PI_PROVIDER`、`PI_MODEL`、`EQUITY_HORIZON`
覆盖默认设置。本应用无需任何 B2 凭据。

本地调试也可以直接读取 Windmill 已保存的业务 secrets：

```sh
mise run equity:remote-secrets -- AAPL MSFT
```

该命令通过 OpenBao/fnox 注入 Windmill 连接凭据，并启用 `windmill-readonly`
模式。Finnhub 和 Telegram secrets 只读取到内存，不复制到 `.env`，不允许更新。
本地模型调用仍走公网，因此 `CODEX_API_KEY` 继续从本地环境读取。
如果已自行注入 `WM_TOKEN`、`WM_WORKSPACE`、`BASE_INTERNAL_URL`，也可执行
`mise run equity:local -- --windmill-secrets AAPL MSFT`。两种命令都会实际发送消息。

`f/lib/finnhub.ts` 封装 Finnhub 行情和新闻查询；模型仅在调用工具后获得数据。
本地与 Windmill 共用 `analyzeAndNotify()`，发送结果返回 messageId 和消息文本。
`mise run verify` 执行类型检查、离线测试和 CI lint，不发送真实消息。

Telegram API 参考：https://core.telegram.org/bots/api#sendmessage

## 统一凭据接口

`secrets.ts` 将逻辑名称 `gatewayKey`、`auth`、`finnhub`、`telegramBot`、`telegramChat`、`telegramThread` 映射到
Windmill secret variable 和对应环境变量。默认根据 `WM_JOB_ID` 决定读取来源；
业务函数无需选择后端，本地仅配置 Windmill CLI 凭据不会误读远程 secrets。

本地环境变量只读，`set/setJson` 明确拒绝，不修改进程环境或 `.env`。
只有显式选择旧的 OAuth provider 时才读取 `PI_AUTH_JSON` / `us_equity_pi_auth`。
本地 OAuth 凭据过期后需重新登录并更新 `PI_AUTH_JSON`，程序不会尝试无法保存的刷新。
仅 Windmill job 的可写模式支持 OAuth 刷新并通过 `setJson()` 保存回 secret；
本地远程只读模式也不会刷新或保存 OAuth 凭据。读取失败不会回退到本地。
