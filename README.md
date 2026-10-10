# IM Lab · 即时通讯学习实验室

使用 Java 17、Spring Boot 和原生 JavaScript，通过报文、状态变化和故障实验学习 IM。覆盖常见协议与架构机制，定位为本地教学项目。

## 能做什么

| 实验 | 执行方式 | 范围 |
| --- | --- | --- |
| WebSocket 聊天 | 真实 Java 服务 `/ws/im` | 在线路由、应用心跳、接受确认与主动已读；消息仅在内存中 |
| Java 持久化实战 | 真实 `/ws/durable` + H2 + IndexedDB | 消息与 Outbox 事务、离线补拉、幂等重试、耐久已读与恢复 |
| HTTP | 真实 `POST /api/lab/echo` | 请求与响应观测；默认未配置 HTTPS |
| JSON / Protobuf / WebSocket 帧 | 浏览器本地编码 | 指定 Chat schema 的编码与帧构造；构造的帧不发送到网络 |
| 协议、业务与架构场景 | 教学模拟 | TCP、TLS、XMPP、MQTT、STOMP、WebRTC、群聊、信息流、单元化、容灾等 |

页面观察本项目客户端的应用层报文，不是网络抓包器。LOGIN / CHAT / SYNC 等 JSON 命令是本项目自定义协议，不代表行业通用标准或完整标准协议实现。

## 启动

需要 JDK 17+ 和 Maven。在项目根目录执行：

```sh
mvn spring-boot:run
```

打开 http://localhost:8080。建议先点击「一键演示聊天流程」，再进入「生产链路 → Java 持久化实战」。

默认监听 `127.0.0.1:8080`；文件数据库位于当前工作目录的 `data/imlab.mv.db`。启动持久化实验无需另装数据库或消息队列。浏览器需要支持 IndexedDB。

也可打包运行：

```sh
mvn package
java -jar target/websocket-learner-1.0.0.jar
```

## 关键语义与边界

- **身份**：LOGIN 只绑定演示 userId，不验证密码或 token；一个用户在每个端点仅保留一条连接。数据按绑定用户过滤，不构成生产鉴权。
- **确认**：`/ws/im` 的 ACK accepted 表示内存接受；`/ws/durable` 的 ACK persisted 在 JDBC 提交后返回。Outbox DONE 表示收件箱已落地，均不等于用户已读。
- **幂等**：持久化端点按 `(发送者, requestKey)` 去重，同键不同正文或接收人会冲突。重复事件可重放，收件箱唯一约束避免重复引用；不承诺网络恰好交付一次。
- **同步与恢复**：游标绑定用户，按收件箱落地序号分页；浏览器原子保存消息与游标。支持手动重连后补拉、待发重试和服务重启后的 Outbox 扫描；没有自动网络重连或严格会话发送顺序保证。
- **模拟与容量**：架构流程和参数计算不部署真实分布式系统，也不代表生产压测结果。朋友圈使用通用信息流设计；横向扩展有热点和共享依赖等边界。

Java 实战为单进程、本机文件库与串行处理模型。故障按钮关闭连接或暂停中继，不执行 JVM 崩溃、磁盘故障或断电。请将服务用于本机学习，不直接作为公网生产 IM 服务部署。

## 阅读与验证

- [实验与代码阅读指南](docs/learning-guide.md)：各主题、协议字段、故障操作与参数假设。
- [ImHandler.java](src/main/java/dev/imlab/ImHandler.java)：内存路由。
- [DurableStore.java](src/main/java/dev/imlab/DurableStore.java)：JDBC 事务、去重与同步。
- [DurableImHandler.java](src/main/java/dev/imlab/DurableImHandler.java)：持久化协议与 Outbox 中继。

Java 学习代码保留逐行中文注释，JavaScript 使用四空格缩进和中文说明。

```sh
mvn test
node --test scripts/test-lab.cjs
```

前端测试需 Node.js 20+。Java 测试覆盖真实 HTTP / WebSocket、数据库事务及应用实例重启恢复；Node 测试使用 DOM、WebSocket 和 IndexedDB 事务替身。测试范围不等于生产安全、性能或浏览器实机兼容性认证。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。第三方依赖遵循各自的许可证。
