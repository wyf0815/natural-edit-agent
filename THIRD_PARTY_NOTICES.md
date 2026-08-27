# Third-Party Notices

Natural Edit Agent includes integration code for third-party software and services. Their names, trademarks, code, model files, and services remain subject to their respective owners' licenses and terms.

## MobileSAM

Optional semantic object selection can use locally supplied ONNX files compatible with MobileSAM.

- Upstream project: https://github.com/ChaoningZhang/MobileSAM
- Upstream source-code license: Apache License 2.0
- MobileSAM source code and model files are not redistributed in this repository or in the CCX package.

The two ONNX files accepted by v0.9.8 are compatibility baselines, not official upstream release artifacts. Their hashes verify file identity only; they do not prove provenance or grant model rights. Users are responsible for obtaining, converting, and using model files lawfully and for following any terms that apply to the specific weights they use.

## Python runtime packages

Optional local segmentation uses packages listed in `requirements-segmentation.txt`, including NumPy, OpenCV, and ONNX Runtime. Those packages are installed separately and remain subject to their own licenses and notices.

## Adobe Photoshop and UXP

The plugin uses Adobe Photoshop UXP APIs. Natural Edit Agent is an independent project and is not sponsored, endorsed, or affiliated with Adobe.

Adobe, the Adobe logo, and Photoshop are either registered trademarks or trademarks of Adobe in the United States and/or other countries. Other trademarks are the property of their respective owners.

Adobe trademark information: https://www.adobe.com/legal/permissions/trademarks.html

## Model providers

The project contains adapters for third-party model APIs. No provider SDK, API key, account, or model output is bundled. Use of a provider is governed by that provider's current terms, privacy policy, account permissions, pricing, and model availability.
