# IM Lab · 实验与代码阅读指南

本指南的命令在项目根目录执行。项目定位与运行边界见 [README](../README.md)。

Java 17 + Spring Boot + 原生浏览器 WebSocket 的可运行学习项目。保留原有内存路由实验，并新增 H2 文件库、Outbox、离线同步与 IndexedDB 客户端的真实持久化实验。

## 启动

需要 JDK 17+、Maven 3.6+。

```sh
mvn spring-boot:run
```

打开 http://localhost:8080，点击「一键演示聊天流程」。也可以依次连接和登录 Alice、Bob，发送聊天，在 Bob 收到的消息中点击「标记已读」。支持心跳、手写 JSON、报文搜索、方向筛选和 JSON 导出。

```sh
mvn test
mvn package
java -jar target/websocket-learner-1.0.0.jar
```

默认仅监听本机 127.0.0.1:8080。同一身份的第二次登录会关闭旧连接，避免在多个标签页中重复登录同一个用户。

## 推荐实验

1. 一键演示：观察 CHAT → ACK → MESSAGE → READ → RECEIPT；点击每条报文查看字段。
2. 只连接不登录，发送原始 `{"type":"PING","id":"p1"}`，观察 NOT_LOGGED_IN。
3. 登录后发送同一条 PING，观察 PONG.refId 对应请求 id。
4. 断开 Bob 后让 Alice 发送消息，观察 USER_OFFLINE。
5. 手写 `{"type":"UNKNOWN","id":"x1"}`，观察 UNKNOWN_TYPE。
6. 打开浏览器开发者工具 Network → WS，查看 `/ws/im` 的真实握手和 Messages。

## 自定义 IM JSON 协议

WebSocket 是传输协议；以下是本项目自定义的应用协议，并非所有 IM 产品的通用标准。

客户端请求：

```json
{"type":"LOGIN","id":"login-1","timestamp":1720000000000,"payload":{"userId":"alice"}}
{"type":"CHAT","id":"chat-1","to":"bob","payload":{"text":"你好"}}
{"type":"PING","id":"ping-1"}
{"type":"READ","id":"read-1","payload":{"messageId":"服务端生成的消息ID"}}
```

| 请求 | 响应/推送 | 含义 |
|---|---|---|
| LOGIN | LOGIN_OK | 将 userId 绑定到连接 |
| CHAT | 发送方 ACK、接收方 MESSAGE | 服务端接受消息并向在线用户投递 |
| READ | 接收方 ACK、发送方 RECEIPT | 接收方主动确认已读 |
| PING | PONG | JSON 应用心跳 |
| 非法请求 | ERROR | code、detail 解释错误 |

`id` 标识报文，`refId` 关联请求，`messageId` 关联同一条聊天消息。`from` 由服务端生成，不能依靠客户端自报身份。ACK 的 accepted 不是已读确认；RECEIPT 的 read 才表示接收者主动标记已读。这一节描述的 `/ws/im` 内存实验没有自动重发、去重或离线存储。持久化实验的约定见下文 `/ws/durable`。

页面记录浏览器收发的应用层文本及连接事件，不是网络抓包器；不能监听其他应用的连接。浏览器 API 不直接暴露握手头、底层帧头或控制帧。PING/PONG 是 JSON，不是 WebSocket Ping/Pong 控制帧。

## 代码阅读顺序

- `src/main/java/dev/imlab/Application.java`：启动 Spring Boot 应用。
- `src/main/java/dev/imlab/WebSocketConfig.java`：通过构造器注入处理器，注册 `/ws/im` 与 `/ws/durable`。
- `src/main/java/dev/imlab/ImHandler.java`：登录、消息路由、确认、心跳、异常处理。
- `src/main/resources/static/app.js`：浏览器连接、收发记录、字段解释。
- `src/test/java/dev/imlab/ProtocolTest.java`：真实连接的完整消息链路及错误场景。

此项目用于本地教学：原有 `/ws/im` 仅内存路由、不保存离线消息；新增 `/ws/durable` 支持 H2 持久化、离线补拉、幂等与 Outbox 恢复。两个端点的 LOGIN 都只绑定演示身份，不验证密码或 token，不提供生产认证或分布式路由。

Spring WebSocket 官方文档：https://docs.spring.io/spring-framework/reference/web/websocket/server.html

## 常见协议可视化实验

基础协议部分有 12 个入口；加上业务、架构与生产链路，顶部导航现在共有 47 个入口，保留原有真实 WebSocket 双客户端。

| 入口 | 可观察内容 | 执行方式 |
|---|---|---|
| 协议全景 | 协议分层、搭配示例、跳转到对应实验 | 交互知识地图 |
| WebSocket 实战 | 登录、聊天、ACK、已读、心跳 | 真实 Java WebSocket |
| TCP | 三次握手、字节序号、拆包/粘包、长度前缀解码 | 教学模拟 |
| TLS / WSS | TLS 1.3 简化握手、证书校验、加密通道 | 教学模拟 |
| HTTP / HTTPS | POST 请求体、响应状态/头/内容、耗时、错误 | 真实 Java HTTP echo |
| XMPP | presence、message、IQ 请求/响应 | 教学模拟 |
| MQTT | 发布/订阅、QoS 0/1/2、会话恢复重传 | 教学模拟 |
| STOMP | CONNECT、SUBSCRIBE、SEND、MESSAGE、ACK、RECEIPT | 教学模拟 |
| 音视频 / WebRTC | SDP、ICE、STUN、TURN、DTLS-SRTP、直连与中继 | 教学模拟 |
| 可靠消息 | ACK 丢失重试、去重、离线同步、乱序缺口、心跳超时与退避重连 | 教学状态机 |
| JSON / Protobuf | 修改消息，比较实际 UTF-8 与 Protobuf 字节、varint、字段 tag | 本地真实编码 |
| WebSocket 帧 | FIN/opcode/MASK/长度、随机 masking key、逐字节异或 | 本地构造帧，不发送 |

模拟场景支持上一步、下一步、自动播放/暂停、重置、场景切换，展示参与方状态、报文方向、原始内容和解释。标准协议实验附官方规范链接。顶部标签支持左右方向键及 Home / End。

真实 HTTP 实验使用 `POST /api/lab/echo`，不提供登录、历史消息或文件上传。默认 Java 服务仍是 HTTP / WS，未配置 HTTPS / WSS。WebRTC 实验不使用摄像头，也不建立真实媒体通话；SDP 只展示结构摘录。Protobuf 编码只实现页面所示 `Chat { string to = 1; string text = 2; }` schema 的字符串字段，不是通用 Protobuf 编解码库。

运行 Java 集成测试与前端交互逻辑/编码测试：

```sh
mvn test
node --test scripts/test-lab.cjs
```

前端测试使用轻量 DOM 检查所有场景的播放、重置、切换、编码边界及异步 HTTP 结果隔离，不替代真实浏览器视觉测试。


## 逐行学习 WebSocket Java 代码

启动入口、WebSocket 配置、消息处理器三个文件的每个非空代码行都有中文注释，包括 import、注解、方法与代码块结束位置。推荐阅读顺序：

1. `Application.java`：理解应用启动和组件扫描。
2. `WebSocketConfig.java`：理解构造器注入、WebSocket 端点注册。
3. `ImHandler.handleTextMessage`：理解 JSON 解析、字段检查、身份检查和业务分发。
4. `handleLogin`、`handleHeartbeat`、`handleChat`、`handleRead`：分别学习登录、心跳、聊天和已读。
5. `createPacket`、`sendError`、`sendPacket`：理解报文公共字段与真实发送。
6. `afterConnectionClosed`、`MessageDelivery`：理解断线清理和有类型的投递记录。

三个映射表的含义：`sessionsByUserId` 查在线连接，`userIdsBySessionId` 查连接绑定身份，`pendingDeliveriesByMessageId` 查消息发送者与接收者。`MessageDelivery` 使用 Java 17 record，替代用冒号拼接再拆分身份的字符串。

处理器采用串行同步的教学模型，便于观察多张映射表如何保持一致；当前连接关闭时会清理涉及该用户的待已读记录，不补发离线回执。网页与既有报文格式保持兼容。


## 学习 JavaScript 代码

全部浏览器脚本与 `scripts/test-lab.cjs` 已统一为四空格缩进、分号、明确的代码块和中文注释；`.prettierrc.json` 保存格式约定。原先挤在一行里的回调、条件与模板已展开，复杂操作拆成独立函数。

建议按下面顺序阅读：

1. `src/main/resources/static/app.js`：真实 WebSocket 客户端。先看 `initializePage` 和 `initializeClients`，再看 `connect` 的四类回调、`transmit` 与 `handleIncomingMessage`，最后看时间线、已读与一键演示。
2. `src/main/resources/static/codec.js`：真实字节编码。`varint` 编码长度，`encode` 组装当前 Chat schema 的 Protobuf，`frame` 演示帧头和 masking。
3. `src/main/resources/static/protocol-scenes.js`：独立的协议教学数据。`createStep` 定义发送方、接收方、报文、解释、参与方状态和字段说明；各协议只提供场景，不发出真实请求。
4. `src/main/resources/static/protocols.js`：页面导航和播放器。`initializeNavigation` 创建标签，`switchTab` 选择页面，`renderScene` 创建控件，`updateScene` 更新当前步骤；特殊页面分别处理分层地图、编码和真实 HTTP。
5. `scripts/test-lab.cjs`：Node 测试与测试替身，验证编码边界、播放器、真实脚本加载顺序和 WebSocket 页面回调。

浏览器脚本加载顺序为 `app.js → codec.js → protocol-scenes.js → business-scenes.js → architecture-scenes.js → production-scenes.js → production-labs.js → architecture-labs.js → durable-storage.js → durable-lab.js → protocols.js`。这是无需前端构建工具的普通 script 项目：`app.js` 提供 `$` 查询工具，后两类工具通过 `globalThis.IMLabCodec`、`globalThis.IMLabScenes` 显式共享。实际协议文本使用 `textContent` 或文本节点显示，不作为 HTML 执行。


## IM 业务进阶可视化

这 10 个主题全部使用教学模拟，支持逐步播放、回看、暂停、重置、场景切换、端点状态和原始示例报文。这些主题本身不执行认证、数据库、群聊、推送或密码学操作；独立的 Java 持久化实战页执行下文说明的数据库事务。

| 主题 | 场景 |
|---|---|
| 认证与权限 | 凭据验证、token 过期与刷新轮换、伪造身份与越权拒绝 |
| 消息生命周期 | 发送、接受、保存、设备送达、用户已读；断线后的结果未知 |
| 持久化与崩溃 | 消息与 Outbox 原子提交、提交后崩溃恢复、事务回滚重试 |
| 同步与历史 | 分批增量追赶、历史分页、访问范围与权限拒绝 |
| 多设备同步 | 多设备投递、账号已读与设备游标、未读数计算与跨设备合并 |
| 群聊与成员 | 成员权限、群投递、成员级已读、移除成员与版本更新 |
| 消息类型与事件 | 附件上传后引用、编辑/引用/撤回、输入状态的过期清理 |
| 协议版本与错误 | 能力协商、可选字段兼容、未知命令、版本冲突与限流 |
| 移动离线推送 | 平台接受与设备到达、打开后同步、通知合并、无效设备目标 |
| 端到端加密 | TLS 与正文加密边界、设备身份、MLS 移除成员与 epoch 更新 |

在「协议全景」中可以使用学习地图直接进入每个主题。每个主题有本节要点和一道可反复选择的理解检查题；「消息生命周期」另有随步骤推进的状态条。

新增数据位于 `src/main/resources/static/business-scenes.js`，每个主题和场景保留中文注释、展开后的报文定义与官方参考链接。它在基础场景加载后、播放器执行前扩展 `globalThis.IMLabScenes`。

OAuth、Matrix、APNs/FCM、MLS 链接用于进一步阅读。示例业务命令并非这些标准的完整实现；上述模拟场景中的 SQL 不会执行，token / 设备凭据 / 密钥 / 密文都是占位说明，密码学过程不产生真实安全保证。


## 大规模 IM 与社交架构

当前共有 **47 个入口**：12 个基础入口、10 个业务主题、16 个架构主题、8 个生产链路模拟主题、1 个 Java 持久化实战入口。架构层新增 **37 个场景、158 个步骤**，都支持报文示意、参与方状态、逐步播放、回退、重置和理解题。顶部可按「传输与编码 / 业务机制 / 规模化架构 / 生产链路」筛选或搜索，学习地图可以直接跳转。

| 主题 | 可以观察的内容 |
| --- | --- |
| 读、写、混合扩散 | 一份正文与收件箱引用、阅读时聚合、冷热用户混合、参数成本对比 |
| 朋友圈 / 信息流 | 发布、权限变化、删除、点赞评论、稳定游标分页 |
| 社交关系 | 双向好友确认、关注与黑名单、权限版本 |
| 单元化 / Cell | 路由归属、故障范围、跨 Cell 桥接与确认 |
| 网关会话路由 | 用户设备目录、租约、旧连接清理与版本保护 |
| 分库分表与热点 | 虚拟桶、热点拆分、快照与增量追赶、迁移切换 |
| 容量与横向扩展 | 连接预算、热点、共享依赖、带宽瓶颈、队列积压 |
| 队列与背压 | 分区顺序、重放去重、慢客户端、限速与死信 |
| 存储分层归档 | 权威事实与派生视图、冷热层、归档校验、删除保留 |
| 缓存一致性 | 失效与旧值回填竞态、版本、缓存击穿与热点保护 |
| 一致性与写入权 | 单写者、fencing、会话顺序、因果依赖 |
| 多地域容灾 | 异步复制、RPO / RTO、旧主隔离、切换与回切 |
| 可观测与 SLO | 链路等待、端到端指标、错误预算、故障演练 |
| 灰度与兼容迁移 | 长连接排空、重连、扩展迁移收缩、回滚窗口 |
| 限流风控租户隔离 | 分层预算、投递成本、异步审核与可靠消息边界 |
| 搜索派生视图 | 索引水位、权限复查、删除、重建切换 |

朋友圈采用通用社交信息流设计，不声称还原微信内部实现。场景里的 JSON、SQL、命令和指标是教学示意，不是本 Java 服务提供的新接口。相关架构资料在对应页面链接。

### 两个可交互的参数模型

- **扩散成本**：每条消息保存一份正文；写扩散为每位收件人写一条引用，混合扩散只预写选定比例。行写入/秒分别为 `M×(1+N)`、`M`、`M×(1+N×A)`；额外索引空间为 `M×N×86400×索引字节`，混合方案再乘比例 `A`。读扩散读取路数为刷新速度乘相关日志数量；路数不等于 RPC 或 CPU 成本，也不包含每路扫描长度。
- **容量瓶颈**：把单元写入、共享依赖、热点单元、投递任务和出口带宽都换算成原始消息/秒，取最小预算。队列增长为 `max(到达速度−预算,0)`；只有预算高于到达速度时，已有积压才按差额清空。连接数量另外核算。整数 Cell 数和热点占比需符合边界。

模型明确显示单位和假设，拒绝空值、无穷与越界输入。它们不是生产容量承诺：副本、压缩、重试、突发、迁移等成本需要实际压测。横向增加 Cell 也不能自动消除共享依赖或单个热点，因此这里演示的是有资源边界的横向扩展，不承诺无限容量。

代码：`architecture-scenes.js` 保存场景；`architecture-labs.js` 保存独立数学函数和可视化。均采用展开格式和中文注释。Java 继续提供原有真实 WebSocket / HTTP 实验；这些分布式架构实验在浏览器中模拟，不需要安装数据库或消息队列。

验证：`node --test scripts/test-lab.cjs` 覆盖全部主题播放、筛选搜索、模型边界与原有交互；`mvn test` 验证静态资源、真实 HTTP 和 WebSocket 通讯。


## 生产链路与可操作故障实验

新增 **8 个主题、16 个场景、80 个步骤**，学习地图按业务、架构、生产链路分章显示。

| 主题 | 实验覆盖 |
| --- | --- |
| 发送事务与 Outbox | 幂等键、原子提交、ACK 丢失、中继重放、消费去重 |
| 图片视频与文件 | 分片上传、完整性校验、异步处理、授权下载、断点续传与清理 |
| 音视频呼叫状态 | 多设备接听、取消竞态、SDP / ICE、网络切换与重连 |
| 机器人与 Webhook | 验签、耐久接收、回调重试、外部幂等、授权与循环抑制 |
| 删除、保留与备份 | 删除作用域、派生清理、共享附件、恢复时重放删除记录 |
| 在线与正在输入 | 多设备租约、状态过期、输入事件合并、会话列表投影 |
| 客户端本地库与恢复 | 耐久待发队列、固定请求键、入站正文与游标原子提交、账号隔离 |
| 故障注入与验收 | 提交边界故障、逐条对账、权限不变量、长连接与恢复风暴压测 |

进入「生产链路 → 发送事务与 Outbox」，场景下方还有独立的**提交边界故障实验**。可以选方案、一次性故障位置，再手动发送、运行中继、消费事件、恢复进程或重置。

建议尝试两组对照：

1. 选择「提交后立即崩溃」，按发送 → 恢复 → 同键重试 → 中继 → 消费。在 Outbox 方案下能恢复分发；故意省略耐久分发任务的直接写入对照会留下已提交正文但无投递的缺口。
2. 选择「发布后中继检查点丢失」，按发送 → 中继 → 恢复 → 中继 → 消费两次。可看到发布次数为 2，收件箱引用仍为 1。再用「消费提交后确认丢失」观察消费侧去重。

它使用 `production-labs.js` 中的纯状态转换，所有操作都是浏览器内存模拟，不是 Java 数据库事务或真实队列。假设本地事务原子、未确认事件可重投、去重与收件箱同事务；这些边界在页面明确展示。对照方案不是所有直接发送设计的结论，增加耐久恢复日志或 CDC 也能修补缺口。外部系统副作用仍需单独的幂等设计。

`production-scenes.js` 保存新场景，所有新增 JS 已展开格式并配中文说明。Java 的静态资源集成测试同时覆盖这两个新文件。前端测试覆盖所列的一次性故障位置、重复事件最终副作用和方案对照验证。


## Java 持久化实战（真实运行）

在顶部「生产链路」章节中进入 **Java 持久化实战**，或在学习地图点击绿色实战入口。该页与模拟 Outbox 页面是两个独立实验。

启动仍使用 `mvn spring-boot:run` 或 `java -jar target/websocket-learner-1.0.0.jar`，默认创建 `data/imlab.mv.db`。H2 2.2.224 嵌入当前 Java 进程，无需安装数据库，不启动 H2 Console 或数据库监听端口。数据文件已经加入 `.gitignore`。文件库路径可通过 `--imlab.durable.jdbc-url=jdbc:h2:file:/absolute/path/imlab;WRITE_DELAY=0` 配置；在 shell 中请把包含分号的完整参数用单引号包住。文件与事务行为可进一步阅读 [H2 官方说明](https://h2database.github.io/html/features.html)。

### 三段实际事务 / 状态

1. **发送事务**：`durable_message` 中的正文与 `(sender_id,request_key)` 唯一键，以及 `durable_outbox` 事件在同一 JDBC 事务提交，之后才返回 `ACK persisted`。相同用户同键同正文返回原 messageId；改变正文或接收人返回 `KEY_CONFLICT`。
2. **收件箱事务**：中继把事件物化到 `durable_inbox`；消息 ID 和事件 ID 的唯一约束让重放不增加第二条引用。收件箱先提交，Outbox 的 DONE 检查点随后提交。DONE 表示耐久收件箱落地，不表示浏览器已收到或用户已读。没有额外 Kafka / Redis 服务。
3. **浏览器事务**：`durable-storage.js` 用 IndexedDB 保存待发请求。入站批次中的正文与 nextCursor 在同一事务提交；实时 MESSAGE 只作为可重复、可遗漏的提示，不单独推进同步游标。所有账号记录分作用域保存。

默认在每批扫描完成后间隔 1 秒，下一批最多读取 100 条 PENDING 事件；也可暂停、运行一批或恢复自动中继。暂停开关只在内存中，服务重启默认恢复扫描。观察快照通过当前已登录 WebSocket 查询，按用户过滤，每类最多 100 条，不开放任意 SQL。

### 页面上直接做的实验

- **离线收件人**：只连接 Alice，发给未登录 Bob，看到 ACK persisted；之后连接 Bob，自动 SYNC 补拉并展示本地消息。
- **离线发送队列**：不连接客户端也可以「保存请求并发送」；请求先进入浏览器耐久 pending 队列，连接后用原 requestKey 自动发送。
- **幂等重试**：点击「重试最后请求」，观察新的报文 id、相同 requestKey、相同 messageId 与 duplicate=true。
- **提交后断线**：选 AFTER_COMMIT，真实提交后服务端以 1011 关闭该 WebSocket，不发 ACK，并暂停中继。再次连接时客户端自动重试原键；运行一批中继或恢复自动中继后，原事件继续处理。
- **收件箱后中断中继**：选 AFTER_INBOX，收件箱已提交，Outbox 仍 PENDING、attempts=1。再次运行中继后变 DONE、attempts=2，但收件箱仍一条引用。
- **服务重启恢复**：暂停中继后发送，查看 PENDING；停止并重新启动 Java，使用同一个文件库，再连接客户端。新服务自动处理遗留任务，浏览器从原耐久游标继续补拉。
- **已读持久化**：接收方点已读，收到 READ_ACK；在线发送者收到 RECEIPT。重复 READ 保留原 readAt；离线发送者重连后可通过数据库快照查看已读状态，当前没有独立的离线回执增量流。
- **重置本地入站缓存**：只清当前账号的 IndexedDB 消息与游标，保留发送请求和 Java 数据库，之后从头补拉。若替换服务端数据库导致旧游标失效，也可用此操作恢复。

### 自定义 `/ws/durable` 报文

```json
{"type":"LOGIN","id":"login-a","payload":{"userId":"durable_alice"}}
{"type":"CHAT","id":"attempt-1","requestKey":"stable-key-1","to":"durable_bob","payload":{"text":"你好","fault":""}}
{"type":"SYNC","id":"sync-1","payload":{"cursor":"","limit":10}}
{"type":"READ","id":"read-1","payload":{"messageId":"<服务端消息ID>"}}
{"type":"INSPECT","id":"inspect-1"}
{"type":"RELAY","id":"relay-1","payload":{"action":"resume"}}
```

SYNC 返回 messages / nextCursor / hasMore。游标形如 `v1.durable_bob.42`，绑定用户；只获取该用户的收件箱，按落地 seq 递增分页。这是可读的教学游标，没有签名或加密；seq 不是会话序号，不提供严格的跨会话发送顺序。limit 限制为 1–100。MESSAGE 推送中的实体位于 `message` 字段，与旧 `/ws/im` 的平铺格式不同。

### 对照代码阅读

- `src/main/java/dev/imlab/DurableStore.java`：accept → materialize → sync → read / inspect；包含 JDBC 事务、参数绑定与逐行中文注释。
- `src/main/java/dev/imlab/DurableImHandler.java`：LOGIN / CHAT / SYNC → scheduledRelay → 推送；包含逐行中文注释。
- `src/main/resources/static/durable-storage.js`：浏览器待发记录、消息与游标事务、去重与账号隔离。
- `src/main/resources/static/durable-lab.js`：双客户端、真实报文日志、数据库快照、故障控制和导出。

### 验证与边界

`mvn test` 共 11 项：原有 3 项，新增 JDBC 事务/重放/分页/权限 4 项、真实 WebSocket 协议 3 项、完整应用容器关闭再启动后的自动中继恢复 1 项。测试使用内存库或临时文件库，不读写默认学习数据。

`node --test scripts/test-lab.cjs` 共 21 项：包括本地事务失败时正文与游标一起回滚、同键重试、旧实时提示不跳过离线消息，以及页面重建后的 pending 请求恢复。浏览器测试使用 DOM / WebSocket / IndexedDB 事务替身，不替代浏览器实机兼容性验证。

这个实战入口是单 Java 进程 + 本机文件库；方法串行化以突出事务边界，没有连接池、多实例协调、自动网络重连、生产权限、群聊和历史编辑增量。故障注入真实关闭连接或暂停中继，不执行 JVM 崩溃或机器断电；测试证明本例的提交与恢复路径，不代表已验证所有断电、磁盘或跨地域故障。
