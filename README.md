# Windmill

统一管理部署在 Talos 上的 Windmill 实例中的脚本、流程和应用代码。

## 目录

```text
f/              Windmill 文件夹，按业务或用途分组
wmill.yaml      Windmill CLI 同步配置
```

代码路径与 Windmill 路径保持一致，例如 `f/ops/healthcheck.ts` 对应
`f/ops/healthcheck`。将脚本源码及 CLI 生成的元数据和依赖锁文件一起提交。
流程和应用也保留 CLI 导出的原始结构。

Talos/Kubernetes 部署配置由基础设施仓库维护。

## 应用路径约定

每个应用使用固定的小写 kebab-case ID，例如 `daily-report`；`lib` 保留给公共模块。
代码文件夹名和存储使用同一个 ID，应用改名不会自动迁移旧文件。

| 内容 | 固定位置 |
| --- | --- |
| 应用代码、流程和界面 | `f/<app-id>/` |
| 应用存储入口 | `f/<app-id>/storage.ts` |
| 公共模块 | `f/lib/` |
| B2 应用根目录 | `apps/<app-id>/` |
| 持久数据 | `apps/<app-id>/data/` |
| 输入文件 | `apps/<app-id>/input/` |
| 输出文件 | `apps/<app-id>/output/` |
| 临时文件 | `apps/<app-id>/tmp/`，由应用负责清理 |

在 `f/daily-report/storage.ts` 中绑定一次应用 ID：

```ts
import { withAppStorage, type AppStorage } from "../lib/app_storage.ts";

export function withStorage<T>(run: (storage: AppStorage) => Promise<T>) {
  return withAppStorage("daily-report", run);
}
```

同一应用的其他脚本只引用这个入口：

```ts
import { withStorage } from "./storage.ts";

export async function main() {
  return withStorage(async (storage) => {
    await storage.writeJson("data/state.json", { cursor: 42 });
    return storage.readJson<{ cursor: number }>("data/state.json");
  });
}
```

实际文件固定写入 `apps/daily-report/data/state.json`。读、写、删除统一添加应用
前缀，拒绝绝对路径、`..`、反斜杠和空路径段；调用方无需拼接桶或应用根目录。
`storage.key(path)` 可取得完整对象 key，写入结果中的 `key` 也是完整 key；
继续调用读写接口时仍传相对路径。子目录名称是组织约定，应用根前缀由代码强制添加。
这属于代码层面的路径约束；应用之间的权限隔离仍取决于 B2 凭据权限。

## B2 通用模块

`f/lib/b2.ts` 沿用 Talos 会话中已验证的配置：从 `u/reonokiy/b2` 获取桶、
端点及区域，AWS SDK 默认凭据链读取 Worker 透传的
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`。无需在业务脚本中填写凭据。

业务代码优先使用上面的应用存储入口。底层 `f/lib/b2.ts` 提供以下接口，
供公共模块或需要访问既有完整 key 的维护代码使用：

```ts
import { withB2 } from "../lib/b2.ts";

export async function main() {
  return withB2(async (b2) => {
    await b2.writeJson("reports/daily.json", { count: 42 });
    return await b2.readJson<{ count: number }>("reports/daily.json");
  });
}
```

可用方法：

| 方法 | 用途 |
| --- | --- |
| `writeText` / `readText` | UTF-8 文本 |
| `writeJson` / `readJson<T>` | JSON 序列化及解析，泛型不做运行时校验 |
| `write` / `readBytes` | `Uint8Array` 二进制数据 |
| `delete` | 删除对象的当前版本；不清除历史版本 |

写入方法返回 `{ key, bucket, etag, versionId }`，可传入 `contentType` 和
`metadata`。相同 key 的写入遵循桶自身的覆盖／版本规则；读取不存在的对象、
权限错误及无效 JSON 都会抛出异常，不会伪装成空文件。

`withB2(callback, resourcePath?)` 自动释放连接；需要自己管理生命周期时使用
`getB2(resourcePath?)` 并在 `finally` 中调用 `destroy()`。Windmill 外的 Node.js
服务可直接导入 `createB2(config)`，通过环境变量或 AWS 默认凭据链认证。

当前读写在内存中处理完整文件，适合常规文本、JSON 和二进制文件；超大文件需要
另行使用流式下载和分段上传。同一个默认存储桶仍受 Windmill 的存储统计规则影响。

`f/lib/b2.ts` 没有 `main`，作为 Windmill 共享模块使用。同步后其他脚本可通过
[相对导入](https://www.windmill.dev/docs/advanced/dependencies_in_typescript)引用它。
更新依赖后应重新生成调用脚本的 Windmill 元数据和锁文件；根目录的
`package-lock.json` 用于本地检查，不替代 Windmill 的脚本锁文件。

## 本地开发与调试

使用 [mise](https://mise.jdx.dev/) 管理固定版本的 Node.js、Bun 和 Windmill CLI；
项目 npm 依赖通过 `package-lock.json` 锁定。

```sh
mise trust
mise install
mise run install
mise run verify
```

测试使用本地 S3 模拟服务，在 Node.js 和 Bun 下执行，不访问线上 B2。

需要调试实际 B2 时，复制 `.env.example` 为 `.env`，设置 `APP_ID`，填写 Resource 的连接信息
及本地使用的 B2 凭据。Bun 自动加载 `.env`；本机不会自动继承集群 Worker 的凭据。

```sh
cp .env.example .env
# 填写 .env 后读取已有对象，仅输出 key 和字节数
mise run b2:local -- read data/state.json
# 启动 Bun 调试器并等待连接，使用终端显示的调试地址
mise run b2:debug -- read data/state.json
# 可选：真实上传、读回并删除 apps/<APP_ID>/tmp/debug/ 下的随机对象
mise run b2:local -- roundtrip
```

`roundtrip` 会访问真实桶，删除只作用于当前对象版本，历史版本按桶的生命周期
策略保留。默认 `APP_ID=local-debug`，使用 `apps/local-debug/` 存放调试文件。
`scripts/` 和 `tests/` 不在 Windmill 同步范围内。

## 连接现有实例

安装 [Windmill CLI](https://www.windmill.dev/docs/advanced/cli)，在本机完成
`wmill workspace add` 的交互式配置，填写实例 URL、workspace ID 和访问令牌。
令牌仅保存在本机 CLI 配置中，不写入此仓库。

```sh
mise exec -- wmill workspace add
```

本仓库尚未绑定实例。配置完成后，在仓库根目录导出现有代码：

```sh
wmill sync pull
git status
git diff
```

首次拉取后检查内容，再提交到 Git。拉取会更新本地文件，后续拉取前先提交或
暂存本地修改。

## 自动同步与线上测试

`.github/workflows/windmill.yaml` 在 PR 上运行检查；推送到 `main` 后，检查通过才会
同步到 `https://windmill.nokiy.net` 的 `windmill` workspace，并执行
`f/storage-test/roundtrip`。也可以在 GitHub Actions 页面手动运行工作流。

一次性配置：在 Windmill **User settings → Tokens** 创建用于部署的用户令牌，
在本仓库 **Settings → Secrets and variables → Actions** 添加 `WMILL_TOKEN`。
令牌所属用户需要部署文件夹和脚本、执行测试、读取 `u/reonokiy/b2` 的权限；
当前文件夹 owner 为 `u/reonokiy`。GitHub 只保存 Windmill 令牌，B2 凭据仍由 Worker 提供。
令牌到期或撤销后，在 GitHub 更新 Secret 即可。

流水线通过 `wmill sync push --auto-metadata --keep-deleted` 生成元数据和依赖锁，
新增或更新仓库中的代码。远端独有的代码会保留；删除仓库文件不会自动删除线上对象。
变量、资源及凭据不会同步。生成文件保留在该次 CI 工作目录，不自动回写 Git。
本地登录后可运行 `mise exec -- wmill generate-metadata`，将元数据和锁文件纳入提交。

测试应用是完整的路径约定示例：`f/storage-test/storage.ts` 绑定应用名，
`roundtrip.ts` 通过该入口测试文本、JSON 和二进制读写，随后删除所有测试文件并确认
当前版本已不可读。每次使用 `apps/storage-test/tmp/<uuid>/`，不会覆盖业务文件。
任何读写或清理失败都会让任务失败。桶中的历史版本仍由 B2 生命周期策略清理。

本地配置 workspace 登录后，也可以单独执行线上测试：

```sh
mise run wmill:test
```

离线 `mise run verify` 会用本地 S3 模拟服务执行同一段测试逻辑，并验证 CI 配置。

## 日常开发

1. 从实例拉取代码，检查差异。
2. 在 `f/<app-id>/` 下编辑脚本、流程或应用，通过应用的 `storage.ts` 读写文件。
3. 脚本依赖或参数变更后，执行 `mise exec -- wmill generate-metadata` 更新元数据。
4. 检查差异并提交源码、元数据和依赖锁文件。
5. 确认本机选中的 workspace 后执行 `wmill sync push`，检查 CLI 的变更预览。

当前配置同步 `f/` 下的脚本、流程、应用及文件夹，跳过变量、资源及资源类型，
不启用调度和触发器同步。凭据通过 Windmill 实例中的资源和秘密变量引用。
如需纳入其他对象，显式调整 `wmill.yaml`。

参考：[同步命令](https://www.windmill.dev/docs/advanced/cli/sync)、
[同步配置](https://www.windmill.dev/docs/advanced/cli/wmill-yaml-reference)。
