# 地理底图与空间口径

## 美国州级底图

- 原始边界：美国人口普查局 **2017 Cartographic Boundary Files**，用于州级统计展示。
- 分发包：[topojson/us-atlas](https://github.com/topojson/us-atlas)，固定版本 **3.0.1**。
- 输入：[states-albers-10m.json](https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/states-albers-10m.json)。源文件 SHA-256 保存在生成资产 `source.sourceSha256` 中。
- 官方背景：[Census cartographic boundary files](https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html)。
- 投影：Albers USA 等积复合投影；阿拉斯加和夏威夷采用内嵌图，位置与比例不表示其与美国本土的真实距离。
- 覆盖：50 个州和哥伦比亚特区。海外领地未纳入此版地图。
- us-atlas 使用 ISC 许可，完整许可保存在 [us-atlas-LICENSE.txt](./us-atlas-LICENSE.txt)。

## 处理与复现

执行 `node scripts/build-us-state-geometry.mjs`，下载固定版本 TopoJSON，将增量编码的共享边界解码成 SVG 路径。对整张底图等比例缩放到 975 × 610，并将坐标四舍五入到 0.1 SVG 单位；不手绘边界、不分别调整州的位置。源数据已包含制图简化，本项目不进一步抽稀。

生成文件 `lib/industry/us-state-geometry.json` 不需要浏览器下载地图瓦片或加载地图服务。每个州保存 FIPS、邮政代码、英文名称、SVG 路径、包围盒及最大陆地区块的面积质心。质心用于州级标注，不能作为项目园区位置。

## 数据叠加约定

地图上的统计对象以数据披露的地理口径为准。州级电价对应整个州的统计口径；电网市场或平衡区单独标注名称和来源。地区缺值保持空缺，不当作零或低热度。只有明确披露到州的项目可以进入州级统计，公司整体收入、投资和资本开支不映射到总部所在州。

项目计数、投运容量和在建容量只描述当前已收录的公开样本。采用已披露容量时，必须保留容量定义和建设状态；规划容量、IT 负载和供电容量不可未经说明直接合并。
