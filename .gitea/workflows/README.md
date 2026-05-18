# Gitea Actions — Release pipelines

四个 release workflow，每个 package 独立。统一约定：**打 git tag 即触发**，tag 命名规则为 `<package>-v<semver>`。每个 workflow 也允许在 Gitea UI 中通过 `workflow_dispatch` 手动触发（需手工填写 version）。

| Workflow | Tag 形式 | 产物 |
|---|---|---|
| `release-happy-cli.yml` | `happy-cli-vX.Y.Z` | 5 个 standalone tarball（含预编译 node-pty）+ 1 个 npm `.tgz` + 1 个 source tarball |
| `release-happy-agent.yml` | `happy-agent-vX.Y.Z` | 1 个 npm `.tgz` + 1 个 source tarball |
| `release-happy-server.yml` | `happy-server-vX.Y.Z` | 多架构 Docker 镜像推到 `open-1.kfafa.cn:30011/claude-relay/happy-server` |
| `release-happy-app.yml` | `happy-app-vX.Y.Z` | 多架构 Docker (Web) 推到 `open-1.kfafa.cn:30011/claude-relay/happy-app` + Android APK + Web 静态包 |

所有产物（除 Docker 镜像外）作为 asset 附加到 Gitea Release。

---

## 必需的 Gitea Secrets

在 Gitea **仓库 Settings → Secrets and Variables → Actions** 下添加：

| Secret 名 | 用于 | 必需性 |
|---|---|---|
| `RELEASE_TOKEN` | Gitea PAT（`write:repository` 权限），用于创建 Release 和上传 asset | **所有 workflow 必需** |
| `DOCKER_REGISTRY_USER` | `open-1.kfafa.cn:30011` 的镜像仓库账号 | server + app 必需 |
| `DOCKER_REGISTRY_PASSWORD` | 镜像仓库密码或 robot token | server + app 必需 |
| `ANDROID_KEYSTORE_BASE64` | Android 签名 keystore（`base64 -i my.jks` 输出） | app（不填则用 debug keystore，APK 不能上 Play 但可内测） |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 | app（与上同 optional） |
| `ANDROID_KEY_ALIAS` | key alias 名 | app（与上同 optional） |
| `ANDROID_KEY_PASSWORD` | key 密码 | app（与上同 optional） |

> `RELEASE_TOKEN` 怎么生成：登录 Gitea → 头像 → Settings → Applications → Generate New Token，scope 勾 `write:repository`。

---

## 触发示例

打 tag 触发：

```bash
# 发布 happy-cli 1.1.10
git tag happy-cli-v1.1.10
git push origin happy-cli-v1.1.10

# 发布 happy-server
git tag happy-server-v0.3.0
git push origin happy-server-v0.3.0
```

UI 手动触发：在 Gitea 仓库的 **Actions → 选择对应 workflow → Run workflow**，填入 version（不含 `v`）。

---

## 平台与 runner 约定

**本仓库 runner 标签为 `test`**（act_runner 注册时用的 label）。所有非平台特异的 job (`runs-on:`) 都指向 `test`。

| 标签 | Runner OS | 实际用途 | 状态 |
|---|---|---|---|
| `test` | linux/amd64 | server / agent / app / cli prepare 等非平台特异 job | ✅ 已配置 |
| `ubuntu-latest` | linux/amd64 | happy-cli bundle 矩阵 linux/x64 子任务 | ⚠️ 需在 act_runner 上加 label 别名，或把矩阵改成 `test` |
| `ubuntu-24.04-arm` | linux/arm64 | happy-cli bundle 矩阵 linux/arm64 子任务 | ⚠️ 同上 |
| `macos-13` | darwin/x64 (Intel) | happy-cli bundle 矩阵 macos/x64 子任务 | ⚠️ 需自建 macOS runner |
| `macos-14` | darwin/arm64 | happy-cli bundle 矩阵 macos/arm64 子任务 | ⚠️ 需自建 macOS runner |
| `windows-latest` | windows/amd64 | happy-cli bundle 矩阵 windows 子任务 | ⚠️ 需自建 Windows runner |

**已知影响**：

1. **server / agent / app workflow 立即可用** —— 全部 `runs-on: test`，单 Linux x64 runner 就跑得动。
2. **cli workflow 暂时跑不通** —— 矩阵需要 5 个平台的 runner。如果你只想发 Linux 单平台 CLI，把 `.gitea/workflows/release-happy-cli.yml` 的 `bundle.strategy.matrix.include` 只保留第一行并把 `runner: ubuntu-latest` 改成 `runner: test`。
3. **Docker 多架构构建**（server / app 镜像 linux/amd64 + linux/arm64）：`test` runner 必须支持 buildx + qemu。容器化部署的 act_runner 要 `--privileged` 才能装 binfmt handler。

---

## 关于 Gitea Actions 与 GitHub Actions 的兼容性

这套 workflow 用了以下 action，全部已知在 Gitea Actions 上工作：

| Action | 来源 |
|---|---|
| `actions/checkout@v4` | GitHub Marketplace（Gitea 默认从 github.com 镜像） |
| `actions/setup-node@v4` | 同上 |
| `actions/setup-java@v4` | 同上 |
| `pnpm/action-setup@v4` | 同上 |
| `docker/setup-qemu-action@v3` | 同上 |
| `docker/setup-buildx-action@v3` | 同上 |
| `docker/login-action@v3` | 同上 |
| `docker/build-push-action@v5` | 同上 |
| `android-actions/setup-android@v3` | 同上 |
| `actions/upload-artifact@v3` / `download-artifact@v3` | 同上 |
| `https://gitea.com/actions/release-action@main` | Gitea 官方（**已显式指定 URL** 而非短名，避免 Gitea 解析为 GitHub） |

**如果你的 Gitea 不能访问 github.com**，需要在 `app.ini` 配置：
```ini
[actions]
DEFAULT_ACTIONS_URL = https://gitea.com   ; 或你自己 mirror 的地址
```
然后把 workflow 里所有 `uses: x/y@v` 改写为 `uses: https://gitea.com/x/y@v` 的完整形式，或将 action 镜像到你自己的 Gitea 仓库。

---

## 已知限制（写在前面省得踩坑）

1. **`actions/upload-artifact@v3`**：Gitea Actions 1.21+ 才内置 artifact storage。如果你的 Gitea 版本更低，把这部分换成"直接产出到 workspace 然后用 Release action 上传"——但目前的 workflow 已经分了 job 之间通过 artifact 传递文件，所以低版本 Gitea 上需要合并 jobs。

2. **`actions/upload-artifact@v4`** 在 Gitea 上**有 bug**（截至 Gitea 1.22）。强烈建议保持 v3。

3. **Android APK 大小**：Expo 默认 release APK 80~120MB（含 Hermes + JS bundle）。如果 Gitea Release asset 有大小限制，需要在 `app.ini` 调 `MAX_FILE_SIZE`。

4. **macOS runner**：Gitea Actions 没有官方托管的 macOS runner，必须自建。如果没有真机，移除矩阵中的 macos 行——用户在 macOS 用 `npm i URL.tgz`（npm tarball）即可，会本地编译 node-pty。

5. **happy-cli 的 `pnpm --filter happy deploy`**：依赖 pnpm 8.x+ 的 deploy 子命令。本仓库锁定 pnpm@10.11.0，兼容。如果项目降级 pnpm 版本，需要换成其他打包方式（如 `--shamefully-hoist` 全量安装后裁剪）。

6. **PTY 模式自检**：每个 standalone bundle 构建完会跑 `find ... -name "*.node"` 确认 node-pty native binding 存在。如果失败说明该平台上 node-gyp 缺少 build chain（Linux: `apt install python3 build-essential`；Windows: `windows-build-tools`），workflow 会直接 fail-fast。

---

## 发布前清单

第一次发布前请逐项确认：

- [ ] `RELEASE_TOKEN` 已配置且未过期
- [ ] 各 package 的 `package.json` 的 `version` 字段已与你要打的 tag 对齐（tag 与 package.json 不同步会让用户混乱）
- [ ] Docker 镜像目标 registry (`open-1.kfafa.cn:30011/claude-relay/`) 可写
- [ ] (happy-app) keystore 已就绪并 base64 上传为 secret
- [ ] act_runner 池里有 ubuntu / macos / windows / linux-arm64 标签的 runner
- [ ] (可选) 如果你的 Gitea 在内网无法访问 github.com，已镜像所有用到的 actions

---

## 修改后本地校验语法

Gitea Actions 与 GitHub Actions 共享 YAML schema，可以用 [act](https://github.com/nektos/act) 本地干跑：

```bash
brew install act
cd /Volumes/ZHITAI-2T-01/Code/claude-remote/happy-remote
# 列出所有 workflow，确认能解析
act -l -W .gitea/workflows/
# 干跑 release-happy-agent（不实际推送，但跑步骤）
act push -W .gitea/workflows/release-happy-agent.yml -e <(echo '{"ref":"refs/tags/happy-agent-v0.1.0"}')
```
