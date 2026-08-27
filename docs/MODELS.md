# MobileSAM 模型准备

MobileSAM 是 Natural Edit Agent 的**可选本地语义分割增强**。项目使用与 [MobileSAM 官方项目](https://github.com/ChaoningZhang/MobileSAM) 兼容的模型结构，但不在仓库、源码压缩包或 CCX 中分发模型权重。

## 当前可复现程度

必须区分“上游项目来源”和“本项目使用的 ONNX 文件来源”：

- MobileSAM 的公开上游源码与许可可以在官方仓库核对。
- 本项目 v0.9.8 使用两个拆分后的 ONNX 文件；它们不是 MobileSAM 上游仓库直接发布的标准下载文件。
- 当前仓库没有提供能够从某个固定上游提交和权重确定性生成这两个 ONNX 文件的导出脚本，因此目前**无法诚实地提供一条可重复的一键下载或导出命令**。
- 下面的文件大小和 SHA-256 只能证明文件与本项目已经验证过的兼容基线一致，不能代替来源证明，也不表示项目向用户授予模型权利。

在补齐固定上游提交、权重来源和确定性导出流程前，请只使用你有权取得、使用和转换的模型文件。不要从不明网盘或无法核验的第三方链接下载模型。

## 文件位置

```text
models/mobilesam/mobile_sam_image_encoder.onnx
models/mobilesam/sam_mask_decoder_single.onnx
```

v0.9.8 当前验证过的兼容基线为：

```text
mobile_sam_image_encoder.onnx
size:   28157093 bytes
SHA256: 580F5FB648EA1062C0AABC26217AED56921985F03F0CBBD852BBA81D760CC749

sam_mask_decoder_single.onnx
size:   16501323 bytes
SHA256: 93915FC7C993AB9D59AB8C9CCD3BCE37F7509C81AB4150A74ABD4D2ABBD8570D
```

## 安装依赖并校验

```powershell
python -m pip install -r requirements-segmentation.txt
powershell -ExecutionPolicy Bypass -File .\tools\Verify-MobileSAMModels.ps1
```

需要把缺少或不匹配的模型视为测试失败时，可以运行：

```powershell
npm run test:v98:bridge:strict
```

模型验证默认 fail-closed：文件缺失、大小不符或 SHA-256 不符都会失败。只有明确的本地实验才可使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\Verify-MobileSAMModels.ps1 -AllowUnverifiedModels
```

该开关只允许验证脚本打印未知文件的结果，不会把未知模型加入批准基线，也不应在公开发布或 CI 中使用。

## 不安装模型时

普通图层、文字、几何选区、蒙版、滤镜和文档操作仍可使用。公开离线回归会明确显示模型推理 `SKIP`；严格 bridge 测试会失败。依赖语义对象分割的运行时请求会返回模型不可用，不会退化成整块矩形修改。

## 许可与归属

MobileSAM 上游项目声明使用 Apache License 2.0；实际模型权重还可能受训练数据、原始权重来源或分发渠道的额外条款约束。使用者需要自行核验其取得的具体文件。详见 [第三方声明](../THIRD_PARTY_NOTICES.md)。
