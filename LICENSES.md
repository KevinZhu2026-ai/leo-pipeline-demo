# 第三方资源与许可

本页为自研展示层，不使用任何 AGPL 代码。所用外部资源如下：

| 资源 | 版本 | 许可 | 用途 |
|---|---|---|---|
| three.js | 0.160.0 | MIT（见 `libs/three.LICENSE`） | 3D 渲染 |
| satellite.js | 5.0.0 | MIT（见 `libs/satellite.LICENSE`） | SGP4 精确递推、坐标变换 |
| NASA Blue Marble 地形/水深贴图 | 2004-12 | 公有领域（NASA GSFC，<https://visibleearth.nasa.gov/>） | 地球贴图 `assets/earth.jpg` |
| 编目数据 | 2026-03-09 快照 | 编目本身为公开数据（CelesTrak/Space-Track 上游） | `data/catalog.json.gz` |

卫星 3D 模型为本项目用 three.js 基础几何程序化生成，未使用第三方模型文件。
