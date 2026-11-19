# Agent Note: worker 头像改用 blobatar

Status: implemented

## Problem

minidenticons 在 20px 下是一块彩色噪点，没有主体和五官，同屏多个 worker / leader 不成一族；63 个 seed 的池子还会在 worker 多时撞图。头像需要一张能读成「一个 agent 在说话」的确定性小图，同时不能给客户端产物加运行时依赖。

## Decision

头像改用 `blobatar@2.7.0`（MIT、零依赖，构建期内联）。它用身份名哈希出「一个填充身体 + 两只胶囊眼」，同名跨渲染、跨会话、跨重启恒定；`agentAvatarSeed` 与 63 seed 池删除，blobatar 直接拿名字做 seed。

只开放 round / organic / boxy / droplet / hexagon 五种形状（shape band `[0.11, 0.35, 0.54, 0.9, 0.93]`）。capsule 宽高比 1.66 是扁条，triangle 偏小且锐利，nub / cloud / sun 的 1–9 个圆凸起在 20px 下会连成串，留在白名单里只会让身份更难认。颜色只取 tone `[0.4, 0.8]` 的 mid / bright 两档：pastel、pale、ink 在深色气泡上会退成灰点或暗块。

身体按同色相 sRGB 分量 ×0.62 画 2.5 单位描边，不铺底色块——深色主题由亮身体承担轮廓，浅色主题靠描边，避免出现一个个白方块。五种形状的 core 与 body.r 都有随机范围，按可见面积（π·r²）反推缩放并搬到 viewBox 中心，统一到半径 34/100；不折算会让 boxy 偏小、六边形面积只剩同半径圆的 83%。droplet 的 taper 与椭圆在原始 viewBox 里重叠，直接相加会把重叠区算两次、头像缩到 32.4 左右；两条 path 的并集轮廓是凸包，按凸包面积反推，并只输出一条描边 path，顺带消掉接缝。

头像以内联 SVG 渲染，眼睛分组带固定类名，气泡 CSS 在 hover 时做一次 520ms 的 `scaleY` 眨眼；不引 blobatar 的 motion / gaze 入口，`prefers-reduced-motion: reduce` 下不播动画。

## Alternatives considered

- **继续用 minidenticons**：20px 下没有可读主体，且 63 seed 的撞图概率随 worker 数上升；这正是要解决的问题。
- **开放全部十种 blobatar 形状**：capsule / triangle / nub / cloud / sun 在 20px 下会糊成扁条、尖角或一串凸起，牺牲身份识别换形状多样性，不值得。
- **保留 `agentAvatarSeed` 作为稳定别名**：名字已经是稳定身份，再维护一层 seed 池只会多一份会漂移的映射；撞图也不会因为池子而消失。
- **给头像铺底色块**：深色主题上会出现白方块；描边已经能立住浅色主题的轮廓，不必再加一层容器。

## Consequences

头像不再有池子撞图，形状与颜色由名字直接决定；五种形状的视觉面积一致，深色与浅色主题都有轮廓。客户端产物因此净增约 15.6 kB，`blobatar` 的 MIT 全文进产物 banner 与 `THIRD_PARTY_LICENSE`。头像从 `<img>` 改为内联 SVG 后，20px 渲染不再走图片解码，hover 动效由本地 CSS 完成，`prefers-reduced-motion` 下退化为静态。代价是形状只能出现五种，头像本身不再有 minidenticons 的像素图案风格。收益：20px 下有可读的主体与五官，同屏 agent 更容易区分。

## Testing

`tests/worker-report-avatar.test.js` 钉住同名字节一致、五种 shape band 的实际覆盖、`data-shape` 与 blobatar layout 一致、扫描线并集面积等效半径 34±0.1（5000 个 name 覆盖全部 droplet，另四种各 3 个）、宽高比 0.926–1.087、三组对比度、name 不进 SVG；`tests/e2e/avatar.e2e.js` 在真实宿主里断言内联 SVG、hover 眨眼与 reduced-motion 退化；`tests/client-build.test.js` 校验产物 banner 的 blobatar 版权行。双向验证：把 shape band 换成单个值，覆盖五种形状的用例变红；把描边系数改回 1，浅色描边对比度用例变红；把 droplet 的并集改回两条 path 求和，5000 个 name 的用例变红（worker-17 的可见半径 32.399）。
