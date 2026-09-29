# Codex 网关共享客户端

`codex.ts` 封装 `https://api.nokiy.net/codex/v1` 的 Responses 调用、Keygate
鉴权、模型目录和 reasoning effort 映射。业务代码无需维护地址或兼容参数。
Windmill job 自动使用集群内私有 Gateway，不读取 gateway key，也不发送 Authorization。
访问边界由 Talos 的 Cilium Pod 身份策略控制；Gateway 注入后端凭据。
本地调用走公网，仍需 Keygate API key；不会在内部失败后回退公网鉴权。

仅在 Windmill 内使用时，可直接 `createCodexClient()`，无需配置 secret。
同时支持本地开发的应用在自己的 `secrets.ts` 中绑定一次本地凭据：

```ts
// f/my-app/secrets.ts
import { createSecrets } from "../lib/secrets.ts";
import { createCodexClient } from "../lib/codex.ts";

const secrets = createSecrets({
  gatewayKey: { windmill: "u/reonokiy/my_app_gateway_key", env: "CODEX_API_KEY" },
});
export const codex = createCodexClient(secrets);
```

业务代码只选择模型与参数，返回的配置可用于现有 pi Agent：

```ts
import { Agent } from "@mariozechner/pi-agent-core";
import { codex } from "./secrets.ts";

const llm = await codex.model({
  model: "gpt-6-luna",
  effort: "highest",
  timeoutMs: 120_000,
});
const agent = new Agent({
  initialState: { model: llm.model, systemPrompt: "请用中文回答。", tools: [] },
  getApiKey: () => llm.apiKey,
  streamFn: llm.streamFn,
});
await agent.prompt("你的业务问题");
```

也可直接调用 `llm.streamFn(llm.model, context)` 获取 pi 消息流，并用
`await (await llm.streamFn(llm.model, context)).result()` 获取最终消息。
工具执行循环由 Agent 管理。不要记录整个 `llm` 对象，因为其中含有 API key。

参数：

- `model`：模型目录中的准确 ID，必填，不固定为美股应用使用的 Luna。
- `effort`：默认 `highest`；也可指定 `minimal/low/medium/high/xhigh/max/ultra`。
  每次创建模型配置时检查实际目录；不支持的档位报错，不静默降级。
- `reasoningSummary`：可选 `auto/detailed/concise`，由 Responses provider 默认处理。
- `timeoutMs`：每次模型请求的超时；Agent 整轮运行期限由应用控制。
- `maxRetries`：默认 0；需要重试时显式配置。

必须把返回的 `streamFn` 传给 Agent，才能保持指定 effort 和网关兼容行为。
库不会向网关发送不支持的 `temperature` 或 `max_output_tokens`；token 预算由上游
控制。应用仍需自行限制最终文本长度。模型元数据中的 cost 为 0 占位，不代表费用估算。
库不存储凭据、不修改环境变量、不执行工具、不发送通知。
