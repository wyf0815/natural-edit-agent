# Natural Edit Agent for Adobe Photoshop

Natural Edit Agent 是一个面向 Windows 的开源 UXP 插件与本地桥接服务。它把自然语言要求转换成受约束的 JSON 计划，由已注册、可预检、可回读验收的 Photoshop 能力执行实际修改。

> 当前版本：v0.9.8 Beta。项目仍需要在不同 Photoshop 版本和真实 PSD 上继续验证，不应把离线测试通过理解为所有文档都能无差别自动处理。

> Natural Edit Agent 是独立开源项目，与 Adobe 没有隶属、赞助或官方合作关系。Adobe、Adobe 徽标和 Photoshop 是 Adobe 在美国和/或其他国家的注册商标或商标。

## 先了解这三件事

- **它不是独立应用。** 面板运行在 Adobe Photoshop 内部。
- **CCX 不是完整运行环境。** CCX 只包含 UXP 面板；模型请求、令牌管理和可选的本地分割都依赖仓库中的本地 bridge，因此使用插件时必须同时运行启动脚本。
- **MobileSAM 是可选增强。** 不安装 MobileSAM 时，普通图层、文字、几何选区、蒙版、滤镜和文档操作仍可使用；依赖语义对象分割的能力不可用。

## v0.9.8 的主要能力

- 读取当前文档、图层、选区和画面摘要，再生成受约束的编辑计划。
- 执行前展示计划、目标范围和风险提示，用户确认后才修改文档。
- 优先自动生成候选选区；低置信度时可通过面板点选、自由套索或 Photoshop 原生选区工具修正。
- 锁定人工确认后的权威选区，执行时不会重新跑模型覆盖人工结果。
- 对目标结果和未授权区域进行回读验收；失败时尝试回滚并报告能够确认的状态。
- 通过带随机令牌的本地 bridge 转发模型请求，并限制本地服务的允许来源和请求规模。
- 可选使用本机 MobileSAM 对搜索区域做对象分割，不把整张原图交给分割服务。

## 系统要求

- Windows 10 或 Windows 11
- Adobe Photoshop 2024（版本 25.0）或更新版本
- Node.js 18 或更新版本
- Windows PowerShell 5.1 或 PowerShell 7
- 一个受支持模型服务的 API Key
- Python 3.10 或更新版本：仅在启用 MobileSAM 时需要

当前安装脚本默认写入 `Program Files`，通常需要使用“以管理员身份运行”的 PowerShell。也可以给 `Install-UxpV98.ps1` 的 `-Target` 参数传入有写权限的 UXP 开发目录。

## 从 GitHub 安装

### 1. 下载项目

```powershell
git clone https://github.com/wyf0815/natural-edit-agent.git
cd natural-edit-agent
```

没有 Git 时，也可以从 GitHub 的 **Code → Download ZIP** 下载并解压到一个长期保留的目录。启动 bridge 后不能删除或移动这个目录。

### 2. 安装面板

在管理员 PowerShell 中运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-UxpV98.ps1
```

如果你从 GitHub Release 下载并安装了 CCX，可以跳过这一项，但仍需保留本项目目录并完成下一步。**仅安装 CCX 无法单独使用 Natural Edit Agent。**

### 3. 启动本地 bridge 和 Photoshop

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-PhotoshopAgentV98.ps1
```

脚本会在 `%LOCALAPPDATA%\PhotoshopNaturalAgent\v9.8` 创建随机 bridge 令牌并启动本地服务，然后尝试打开 Photoshop。打开 Natural Edit Agent 面板，填写模型厂商和 API Key，再运行“环境自检”。

API Key 当前以明文形式保存在 UXP 插件的本机 `localStorage` 中；bridge 令牌保存在 `%LOCALAPPDATA%\PhotoshopNaturalAgent\v9.8`，并由安装或启动脚本注入已安装面板。它们不会被写入源码仓库，但能够读取相应本机文件的程序仍可能取得它们。详见 [安全策略](SECURITY.md) 和 [隐私说明](docs/PRIVACY.md)。

## 可选：启用 MobileSAM

先安装本地分割依赖：

```powershell
python -m pip install -r requirements-segmentation.txt
```

然后将两个兼容的 ONNX 文件放到 `models/mobilesam/`，并运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\Verify-MobileSAMModels.ps1
```

模型权重不随仓库或 CCX 分发。当前可验证的是一组已知兼容文件的大小与 SHA-256；项目暂未提供从上游权重一键、确定性导出这两个 ONNX 文件的公开流程。来源、限制和校验值见 [MobileSAM 模型准备](docs/MODELS.md)。

## 选区工作流

1. 系统生成候选选区，并在 Photoshop 中显示候选结果。
2. 高置信度候选也可以人工检查；中置信度建议检查；低置信度必须修正或明确接受。
3. 可以使用面板点选、面板自由套索，或 Photoshop 原生选区工具修正。
4. 点击“采用 Photoshop 当前选区”或“这个选区正确”，将结果锁定为执行时的权威选区。
5. 确认计划后执行，并对结果与未授权区域进行回读验收。

`selection.subject_region` 是“Photoshop 选择主体后与搜索范围求交”的兼容能力，不等同于 Photoshop 对象选择。Adobe 没有提供一个适用于所有目标版本、可由本插件静默触发对象选择或选择人物的稳定公开 UXP 接口，因此相关场景会明确交给用户修正，而不会假装全自动完成。

## 开发与验证

以下命令都在当前 `package.json` 中定义：

```powershell
npm test
npm run check
npm run test:v98:bridge
npm run release:audit
```

- `npm test`：运行 v0.9.8 公开离线回归。
- `npm run check`：检查 v0.9.8 面板与 bridge 的 JavaScript 语法。
- `npm run test:v98:bridge`：运行 bridge 集成测试；缺少 MobileSAM 模型时会明确跳过真实分割。
- `npm run release:audit`：检查公开文件清单、敏感内容和版本入口；Git 仓库自身的 `.git` 元数据不属于发布内容。

真实 Photoshop 行为仍需在目标 Photoshop 版本中人工验收。

## 项目文档

- [系统架构](docs/ARCHITECTURE.md)
- [已知限制](docs/LIMITATIONS.md)
- [MobileSAM 模型准备](docs/MODELS.md)
- [隐私说明](docs/PRIVACY.md)
- [安全策略](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)

## 许可

Natural Edit Agent 的项目代码使用 [MIT License](LICENSE)。MobileSAM、模型权重、Adobe Photoshop 和各模型服务分别受其许可或服务条款约束；模型文件、API Key、用户文档和用户图片均不包含在本仓库中。
