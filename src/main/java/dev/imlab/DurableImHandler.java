package dev.imlab; // 声明本地 IM 实战代码所属的包。

import com.fasterxml.jackson.core.JsonProcessingException; // 导入 JsonProcessingException，供下方实现使用。
import com.fasterxml.jackson.databind.JsonNode; // 导入 JsonNode，供下方实现使用。
import com.fasterxml.jackson.databind.ObjectMapper; // 导入 ObjectMapper，供下方实现使用。
import com.fasterxml.jackson.databind.node.ObjectNode; // 导入 ObjectNode，供下方实现使用。
import org.slf4j.Logger; // 导入 Logger，供下方实现使用。
import org.slf4j.LoggerFactory; // 导入 LoggerFactory，供下方实现使用。
import org.springframework.scheduling.annotation.Scheduled; // 导入 Scheduled，供下方实现使用。
import org.springframework.stereotype.Component; // 导入 Component，供下方实现使用。
import org.springframework.web.socket.CloseStatus; // 导入 CloseStatus，供下方实现使用。
import org.springframework.web.socket.TextMessage; // 导入 TextMessage，供下方实现使用。
import org.springframework.web.socket.WebSocketSession; // 导入 WebSocketSession，供下方实现使用。
import org.springframework.web.socket.handler.TextWebSocketHandler; // 导入 TextWebSocketHandler，供下方实现使用。

import java.io.IOException; // 导入 IOException，供下方实现使用。
import java.sql.SQLException; // 导入 SQLException，供下方实现使用。
import java.util.HashMap; // 导入 HashMap，供下方实现使用。
import java.util.Map; // 导入 Map，供下方实现使用。
import java.util.UUID; // 导入 UUID，供下方实现使用。
import java.util.regex.Pattern; // 导入 Pattern，供下方实现使用。

/**
 * /ws/durable：真实 JDBC 事务 + 真实 WebSocket 的独立学习端点。
 * LOGIN 仍只绑定演示身份；不提供密码认证、群聊或多设备路由。
 * synchronized 适用于单进程演示，不能用本例的吞吐代表生产服务。
 */
@Component // 声明框架组件、生命周期或定时回调的约定。
public class DurableImHandler extends TextWebSocketHandler { // 定义由 Spring 管理的真实持久化业务实现。
    private static final Logger LOGGER = LoggerFactory.getLogger(DurableImHandler.class); // 定义共享常量或日志工具，避免在每个请求中重复创建。
    private static final Pattern USER = Pattern.compile("[a-zA-Z0-9_-]{1,32}"); // 定义共享常量或日志工具，避免在每个请求中重复创建。
    private final ObjectMapper mapper; // 保存构造后不再替换的依赖或本进程共享状态。
    private final DurableStore store; // 保存构造后不再替换的依赖或本进程共享状态。
    private final Map<String, WebSocketSession> sessions = new HashMap<>(); // 保存构造后不再替换的依赖或本进程共享状态。
    private final Map<String, String> identities = new HashMap<>(); // 保存构造后不再替换的依赖或本进程共享状态。
    private boolean relayPaused; // 仅此开关在内存中；重启默认恢复扫描耐久 Outbox。

    public DurableImHandler(ObjectMapper mapper, DurableStore store) { // 定义本段业务操作的入口，依赖与状态由所属实例持有。
        this.mapper = mapper; // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        this.store = store; // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
    } // 结束当前作用域。

    @Override // 声明框架组件、生命周期或定时回调的约定。
    protected synchronized void handleTextMessage(WebSocketSession session, TextMessage message) throws IOException { // 定义本段业务操作的入口，依赖与状态由所属实例持有。
        JsonNode request; // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        try { // 进入受控操作范围；资源在离开时自动关闭或异常由后续分支处理。
            request = mapper.readTree(message.getPayload()); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        } catch (JsonProcessingException failure) { // 捕获失败并执行回滚或明确的错误报告。
            error(session, "", "INVALID_JSON", "报文必须是合法 JSON 对象"); // 返回明确业务错误，并关联到当前请求。
            return; // 提前结束当前处理，避免执行后续不适用的逻辑。
        } // 结束当前作用域。
        if (request == null || !request.isObject()) { // 检查当前状态或输入边界，满足条件才继续对应操作。
            error(session, "", "INVALID_JSON", "报文必须是 JSON 对象"); // 返回明确业务错误，并关联到当前请求。
            return; // 提前结束当前处理，避免执行后续不适用的逻辑。
        } // 结束当前作用域。
        String id = text(request, "id"); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        if (id.isBlank() || id.length() > 128) { // 检查当前状态或输入边界，满足条件才继续对应操作。
            error(session, "", "INVALID_ID", "id 必填且不超过 128 字符"); // 返回明确业务错误，并关联到当前请求。
            return; // 提前结束当前处理，避免执行后续不适用的逻辑。
        } // 结束当前作用域。
        try { // 进入受控操作范围；资源在离开时自动关闭或异常由后续分支处理。
            String type = text(request, "type"); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
            if ("LOGIN".equals(type)) { // 检查当前状态或输入边界，满足条件才继续对应操作。
                login(session, request, id); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
                return; // 提前结束当前处理，避免执行后续不适用的逻辑。
            } // 结束当前作用域。
            String user = identities.get(session.getId()); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
            if (user == null) throw new DurableStore.ProtocolFault("NOT_LOGGED_IN", "请先 LOGIN"); // 检查当前状态或输入边界，满足条件才继续对应操作。
            switch (type) { // 按类型或动作选择唯一的处理路径。
                case "CHAT" -> chat(session, request, id, user); // 按自定义应用协议类型执行对应业务分支。
                case "SYNC" -> sync(session, request, id, user); // 按自定义应用协议类型执行对应业务分支。
                case "READ" -> read(session, request, id, user); // 按自定义应用协议类型执行对应业务分支。
                case "INSPECT" -> { // 按自定义应用协议类型执行对应业务分支。
                    ObjectNode response = packet("SNAPSHOT", id); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
                    response.set("database", mapper.valueToTree(store.inspect(user))); // 写入协议字段或服务端映射；字段含义见所在业务方法。
                    response.put("relayPaused", relayPaused); // 写入协议字段或服务端映射；字段含义见所在业务方法。
                    response.put("scope", "当前用户相关记录，每类最多 100 条"); // 写入协议字段或服务端映射；字段含义见所在业务方法。
                    send(session, response); // 通过真实 WebSocket 发送本次响应；网络成功不等于对方已读。
                } // 结束当前作用域。
                case "RELAY" -> { // 按自定义应用协议类型执行对应业务分支。
                    String action = text(request.path("payload"), "action"); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
                    int processed = 0; // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
                    switch (action) { // 按类型或动作选择唯一的处理路径。
                        case "pause" -> relayPaused = true; // 按自定义应用协议类型执行对应业务分支。
                        case "resume" -> { relayPaused = false; processed = drain(); } // 按自定义应用协议类型执行对应业务分支。
                        case "run" -> processed = drain(); // 按自定义应用协议类型执行对应业务分支。
                        default -> throw new DurableStore.ProtocolFault("INVALID_ACTION", "支持 pause / resume / run"); // 拒绝未定义的业务类型或动作，避免静默接受。
                    } // 结束当前作用域。
                    ObjectNode response = packet("RELAY_STATUS", id); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
                    response.put("relayPaused", relayPaused); // 写入协议字段或服务端映射；字段含义见所在业务方法。
                    response.put("processed", processed); // 写入协议字段或服务端映射；字段含义见所在业务方法。
                    send(session, response); // 通过真实 WebSocket 发送本次响应；网络成功不等于对方已读。
                } // 结束当前作用域。
                case "PING" -> send(session, packet("PONG", id)); // 按自定义应用协议类型执行对应业务分支。
                default -> throw new DurableStore.ProtocolFault("UNKNOWN_TYPE", "支持 LOGIN / CHAT / SYNC / READ / INSPECT / RELAY / PING"); // 拒绝未定义的业务类型或动作，避免静默接受。
            } // 结束当前作用域。
        } catch (DurableStore.ProtocolFault failure) { // 捕获失败并执行回滚或明确的错误报告。
            error(session, id, failure.code(), failure.getMessage()); // 返回明确业务错误，并关联到当前请求。
        } catch (SQLException failure) { // 捕获失败并执行回滚或明确的错误报告。
            // 不把 SQL 或正文回传浏览器；客户端以相同键查询/重试未知提交结果。
            LOGGER.error("持久化操作失败，SQLState={}", failure.getSQLState()); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
            error(session, id, "STORAGE_ERROR", "存储操作未得到成功结果；请使用相同 requestKey 重试"); // 返回明确业务错误，并关联到当前请求。
        } // 结束当前作用域。
    } // 结束当前作用域。

    private void login(WebSocketSession session, JsonNode request, String id) throws IOException { // 定义本段业务操作的入口，依赖与状态由所属实例持有。
        String user = text(request.path("payload"), "userId"); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        if (!USER.matcher(user).matches()) throw new DurableStore.ProtocolFault("INVALID_USER", "userId 使用 1–32 位字母、数字、下划线或短横线"); // 检查当前状态或输入边界，满足条件才继续对应操作。
        String oldUser = identities.put(session.getId(), user); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        if (oldUser != null) sessions.remove(oldUser, session); // 检查当前状态或输入边界，满足条件才继续对应操作。
        WebSocketSession old = sessions.put(user, session); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        if (old != null && old != session) old.close(new CloseStatus(1008, "User logged in elsewhere")); // 检查当前状态或输入边界，满足条件才继续对应操作。
        ObjectNode response = packet("LOGIN_OK", id); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        response.put("userId", user); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        response.put("initialCursor", DurableStore.cursor(user, 0)); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        response.put("mode", "real-jdbc-websocket"); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        send(session, response); // 通过真实 WebSocket 发送本次响应；网络成功不等于对方已读。
    } // 结束当前作用域。

    private void chat(WebSocketSession session, JsonNode request, String id, String sender) throws SQLException, IOException { // 定义本段业务操作的入口，依赖与状态由所属实例持有。
        String recipient = text(request, "to"); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        String body = text(request.path("payload"), "text"); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        String key = text(request, "requestKey"); // 每次报文 id 可变，逻辑发送请求键必须稳定。
        String fault = text(request.path("payload"), "fault"); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        if (!USER.matcher(recipient).matches()) throw new DurableStore.ProtocolFault("INVALID_USER", "接收用户格式不合法"); // 检查当前状态或输入边界，满足条件才继续对应操作。
        if (body.isBlank() || body.length() > 2000) throw new DurableStore.ProtocolFault("INVALID_TEXT", "正文需要为 1–2000 字符"); // 检查当前状态或输入边界，满足条件才继续对应操作。
        if (key.isBlank() || key.length() > 128) throw new DurableStore.ProtocolFault("INVALID_KEY", "requestKey 必填且不超过 128 字符"); // 检查当前状态或输入边界，满足条件才继续对应操作。
        if (!fault.isEmpty() && !fault.equals("AFTER_COMMIT") && !fault.equals("AFTER_INBOX")) { // 检查当前状态或输入边界，满足条件才继续对应操作。
            throw new DurableStore.ProtocolFault("INVALID_FAULT", "支持 AFTER_COMMIT / AFTER_INBOX"); // 将失败交给上层；业务错误与数据库故障分别处理。
        } // 结束当前作用域。
        DurableStore.Commit commit = store.accept(sender, recipient, key, body, fault.equals("AFTER_INBOX")); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        if (!commit.duplicate() && fault.equals("AFTER_COMMIT")) { // 检查当前状态或输入边界，满足条件才继续对应操作。
            relayPaused = true; // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
            session.close(new CloseStatus(1011, "Demo: committed before ACK")); // 真正关闭连接，已提交数据保留。
            return; // 提前结束当前处理，避免执行后续不适用的逻辑。
        } // 结束当前作用域。
        ObjectNode ack = packet("ACK", id); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        ack.put("messageId", commit.message().messageId()); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        ack.put("requestKey", key); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        ack.put("duplicate", commit.duplicate()); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        ack.put("status", "persisted"); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        send(session, ack); // 通过真实 WebSocket 发送本次响应；网络成功不等于对方已读。
        if (!relayPaused) drain(); // 离线用户也会得到耐久收件箱，无需在线才能发送。
    } // 结束当前作用域。

    private void sync(WebSocketSession session, JsonNode request, String id, String user) throws SQLException, IOException { // 定义本段业务操作的入口，依赖与状态由所属实例持有。
        JsonNode payload = request.path("payload"); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        JsonNode limitNode = payload.path("limit"); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        int limit = limitNode.isMissingNode() ? 20 : limitNode.asInt(-1); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        if ((!limitNode.isMissingNode() && (!limitNode.isIntegralNumber() || !limitNode.canConvertToInt())) || limit < 1 || limit > 100) { // 检查当前状态或输入边界，满足条件才继续对应操作。
            throw new DurableStore.ProtocolFault("INVALID_LIMIT", "limit 必须为 1–100 的整数"); // 将失败交给上层；业务错误与数据库故障分别处理。
        } // 结束当前作用域。
        JsonNode cursorNode = payload.path("cursor"); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        if (!cursorNode.isMissingNode() && !cursorNode.isTextual()) throw new DurableStore.ProtocolFault("INVALID_CURSOR", "cursor 必须是字符串"); // 检查当前状态或输入边界，满足条件才继续对应操作。
        DurableStore.Page page = store.sync(user, text(payload, "cursor"), limit); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        ObjectNode response = packet("SYNC_RESULT", id); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        response.set("messages", mapper.valueToTree(page.messages())); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        response.put("nextCursor", page.nextCursor()); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        response.put("hasMore", page.hasMore()); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        send(session, response); // 客户端正文和游标本地提交后，才用新游标请求下一页。
    } // 结束当前作用域。

    private void read(WebSocketSession session, JsonNode request, String id, String user) throws SQLException, IOException { // 定义本段业务操作的入口，依赖与状态由所属实例持有。
        DurableStore.Message message = store.read(user, text(request.path("payload"), "messageId")); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        ObjectNode ack = packet("READ_ACK", id); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        ack.put("messageId", message.messageId()); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        ack.put("readAt", message.readAt()); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        send(session, ack); // 通过真实 WebSocket 发送本次响应；网络成功不等于对方已读。
        ObjectNode receipt = packet("RECEIPT", id); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        receipt.put("messageId", message.messageId()); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        receipt.put("from", user); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        receipt.put("readAt", message.readAt()); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        push(message.from(), receipt); // 离线发送者可通过自己的 INSPECT 观察耐久已读状态。
    } // 结束当前作用域。

    /** 定时中继与手动中继共用串行逻辑，重启后自动继续 PENDING 记录。 */
    @Scheduled(fixedDelayString = "${imlab.durable.relay-delay-ms:1000}") // 声明框架组件、生命周期或定时回调的约定。
    public synchronized void scheduledRelay() { // 定义本段业务操作的入口，依赖与状态由所属实例持有。
        if (relayPaused) return; // 检查当前状态或输入边界，满足条件才继续对应操作。
        try { drain(); } // 进入受控操作范围；资源在离开时自动关闭或异常由后续分支处理。
        catch (SQLException failure) { LOGGER.error("Outbox 扫描失败，保留待处理任务，SQLState={}", failure.getSQLState()); } // 捕获失败并执行回滚或明确的错误报告。
    } // 结束当前作用域。

    private int drain() throws SQLException { // 定义本段业务操作的入口，依赖与状态由所属实例持有。
        int processed = 0; // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        for (String event : store.pendingEvents(100)) { // 按当前批次顺序处理记录，不把客户端时间当作同步顺序。
            DurableStore.Delivery delivery = store.materialize(event); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
            if (delivery == null) continue; // 检查当前状态或输入边界，满足条件才继续对应操作。
            processed++; // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
            if (delivery.checkpointLost()) { // 检查当前状态或输入边界，满足条件才继续对应操作。
                relayPaused = true; // 模拟中继停机，不对操作系统或 JVM 执行破坏性操作。
                break; // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
            } // 结束当前作用域。
            ObjectNode packet = packet("MESSAGE", ""); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
            packet.set("message", mapper.valueToTree(delivery.message())); // 写入协议字段或服务端映射；字段含义见所在业务方法。
            packet.put("delivery", "live-hint"); // 写入协议字段或服务端映射；字段含义见所在业务方法。
            push(delivery.message().to(), packet); // 推送只是提示；遗漏或重复由耐久 SYNC + 客户端去重处理。
        } // 结束当前作用域。
        return processed; // 返回本次结果；调用方据此构造响应或决定下一步。
    } // 结束当前作用域。

    private void push(String user, ObjectNode packet) { // 定义本段业务操作的入口，依赖与状态由所属实例持有。
        WebSocketSession session = sessions.get(user); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        if (session == null || !session.isOpen()) return; // 检查当前状态或输入边界，满足条件才继续对应操作。
        try { send(session, packet); } // 进入受控操作范围；资源在离开时自动关闭或异常由后续分支处理。
        catch (IOException | RuntimeException failure) { // 捕获失败并执行回滚或明确的错误报告。
            LOGGER.warn("实时推送失败，用户可通过 SYNC 恢复"); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
            sessions.remove(user, session); // 不回滚耐久收件箱，也不把推送失败当作消息丢失。
        } // 结束当前作用域。
    } // 结束当前作用域。

    private String text(JsonNode node, String field) { // 定义本段业务操作的入口，依赖与状态由所属实例持有。
        JsonNode value = node.path(field); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        return value.isTextual() ? value.asText() : ""; // 返回本次结果；调用方据此构造响应或决定下一步。
    } // 结束当前作用域。

    private ObjectNode packet(String type, String refId) { // 定义本段业务操作的入口，依赖与状态由所属实例持有。
        ObjectNode node = mapper.createObjectNode(); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        node.put("type", type); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        node.put("id", UUID.randomUUID().toString()); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        node.put("refId", refId); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        node.put("timestamp", System.currentTimeMillis()); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        return node; // 返回本次结果；调用方据此构造响应或决定下一步。
    } // 结束当前作用域。

    private void error(WebSocketSession session, String id, String code, String detail) throws IOException { // 定义本段业务操作的入口，依赖与状态由所属实例持有。
        ObjectNode node = packet("ERROR", id); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        node.put("code", code); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        node.put("detail", detail); // 写入协议字段或服务端映射；字段含义见所在业务方法。
        send(session, node); // 通过真实 WebSocket 发送本次响应；网络成功不等于对方已读。
    } // 结束当前作用域。

    private void send(WebSocketSession session, ObjectNode packet) throws IOException { // 定义本段业务操作的入口，依赖与状态由所属实例持有。
        synchronized (session) { // 续写当前表达式或声明，保持完整操作的参数顺序。
            if (session.isOpen()) session.sendMessage(new TextMessage(mapper.writeValueAsString(packet))); // 检查当前状态或输入边界，满足条件才继续对应操作。
        } // 结束当前作用域。
    } // 结束当前作用域。

    @Override // 声明框架组件、生命周期或定时回调的约定。
    public synchronized void afterConnectionClosed(WebSocketSession session, CloseStatus status) { // 定义本段业务操作的入口，依赖与状态由所属实例持有。
        String user = identities.remove(session.getId()); // 保存本次计算、查询或协议处理的结果，供后续步骤使用。
        if (user != null) sessions.remove(user, session); // 只清路由，不删除消息或已读事实。
    } // 结束当前作用域。
} // 结束当前作用域。
