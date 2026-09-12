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

## 连接现有实例

安装 [Windmill CLI](https://www.windmill.dev/docs/advanced/cli)，在本机完成
`wmill workspace add` 的交互式配置，填写实例 URL、workspace ID 和访问令牌。
令牌仅保存在本机 CLI 配置中，不写入此仓库。

```sh
npm install -g windmill-cli
wmill workspace add
```

本仓库尚未绑定实例。配置完成后，在仓库根目录导出现有代码：

```sh
wmill sync pull
git status
git diff
```

首次拉取后检查内容，再提交到 Git。拉取会更新本地文件，后续拉取前先提交或
暂存本地修改。

## 日常开发

1. 从实例拉取代码，检查差异。
2. 在 `f/<业务或用途>/` 下编辑脚本、流程或应用。
3. 脚本依赖或参数变更后，执行 `wmill script generate-metadata` 更新元数据。
4. 检查差异并提交源码、元数据和依赖锁文件。
5. 确认本机选中的 workspace 后执行 `wmill sync push`，检查 CLI 的变更预览。

当前配置同步 `f/` 下的脚本、流程、应用及文件夹，跳过变量、资源及资源类型，
不启用调度和触发器同步。凭据通过 Windmill 实例中的资源和秘密变量引用。
如需纳入其他对象，显式调整 `wmill.yaml`。

参考：[同步命令](https://www.windmill.dev/docs/advanced/cli/sync)、
[同步配置](https://www.windmill.dev/docs/advanced/cli/wmill-yaml-reference)。
