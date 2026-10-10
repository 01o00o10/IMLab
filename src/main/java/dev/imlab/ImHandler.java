package dev.imlab; // 声明 IM WebSocket 处理器所属的包。

import com.fasterxml.jackson.core.JsonProcessingException; // 导入 JSON 解析异常，只捕获确实属于 JSON 格式的问题。
import com.fasterxml.jackson.databind.JsonNode; // 导入 JSON 树节点，用于读取请求字段。
import com.fasterxml.jackson.databind.ObjectMapper; // 导入 JSON 编解码工具，用于解析文本和序列化响应。
import com.fasterxml.jackson.databind.node.ObjectNode; // 导入可修改的 JSON 对象节点，用于组装响应。
import org.springframework.stereotype.Component; // 导入组件注解，让 Spring 管理处理器实例。
import org.springframework.web.socket.CloseStatus; // 导入 WebSocket 关闭状态，包括关闭码与原因。
import org.springframework.web.socket.TextMessage; // 导入 WebSocket 文本消息类型。
import org.springframework.web.socket.WebSocketSession; // 导入会话类型；一个会话代表一条 WebSocket 连接。
import org.springframework.web.socket.handler.TextWebSocketHandler; // 导入处理文本 WebSocket 消息的基类。

import java.io.IOException; // 导入发送消息或关闭连接时可能发生的 I/O 异常。
import java.util.Map; // 导入键值映射接口，用于索引用户、会话和消息。
import java.util.UUID; // 导入 UUID 工具，用于生成响应 ID 与聊天消息 ID。
import java.util.concurrent.ConcurrentHashMap; // 导入并发映射；多步业务操作仍需要额外的同步保护。
import java.util.regex.Pattern; // 导入正则表达式类型，提前编译用户 ID 的校验规则。

// 本类处理教学用 JSON IM 应用协议；LOGIN、CHAT、ACK 并不是 WebSocket 标准规定的命令。
// 阅读主线：handleTextMessage → 具体业务方法 → createPacket / sendPacket → afterConnectionClosed。
// 同一 Spring 组件会被多条连接共享，所以用户、会话和待确认消息是服务端共享状态。
// 本例只在内存中路由消息；登录只绑定 userId，不验证密码或 token，也不保存离线消息。
@Component // 注册为 Spring 组件，WebSocketConfig 会通过构造器注入它。
public class ImHandler extends TextWebSocketHandler { // 继承文本消息处理器，重写收消息及关闭连接的回调。

    private static final int MAX_REQUEST_ID_LENGTH = 128; // 请求 ID 的长度上限，按 Java 字符串 length() 计算。
    private static final int MAX_TEXT_LENGTH = 2000; // 聊天文本的长度上限；这是业务限制，不是 WebSocket 帧长度。
    private static final Pattern USER_ID_PATTERN = Pattern.compile("[a-zA-Z0-9_-]{1,32}"); // 用户 ID 允许 1–32 位字母、数字、下划线或短横线。

    private final ObjectMapper objectMapper; // 使用 Spring 提供的 JSON 工具，不在每次收消息时创建新实例。
    private final Map<String, WebSocketSession> sessionsByUserId = new ConcurrentHashMap<>(); // userId → 当前在线连接，用于路由聊天消息。
    private final Map<String, String> userIdsBySessionId = new ConcurrentHashMap<>(); // sessionId → 已登录 userId，用于确定真实发送者。
    private final Map<String, MessageDelivery> pendingDeliveriesByMessageId = new ConcurrentHashMap<>(); // messageId → 投递双方，用于验证已读权限。

    public ImHandler(ObjectMapper objectMapper) { // 构造器注入 ObjectMapper，由 Spring 自动提供依赖。
        this.objectMapper = objectMapper; // 保存 JSON 工具，供解析和发送方法共享。
    } // 构造器结束；处理器的共享状态在实例创建时初始化。

    // synchronized 锁住整个处理器实例，使收消息与断线清理串行执行，保证多张映射表的一致性。
    // 这是便于理解的教学实现：发送 I/O 也在锁内，多用户高并发时应进一步设计并发模型。
    @Override // 重写 TextWebSocketHandler 的文本消息回调。
    protected synchronized void handleTextMessage(WebSocketSession session, TextMessage message) throws IOException { // Spring 收到完整文本消息后调用；session 标识来源连接。
        JsonNode request; // 声明请求节点，解析成功后再赋值。

        try { // 尝试把 WebSocket 文本正文解析为 JSON 树。
            request = objectMapper.readTree(message.getPayload()); // getPayload() 返回文本内容，readTree() 把它转换为 JSON 节点。
        } catch (JsonProcessingException exception) { // JSON 语法不合法时进入此分支，不把所有异常都误报为格式错误。
            sendError(session, "", "INVALID_JSON", "报文必须是合法 JSON"); // 无法读出请求 ID，所以错误响应使用空 refId。
            return; // 当前报文无法继续处理，提前结束回调。
        } // JSON 解析分支结束。

        if (request == null || !request.isObject()) { // 空文本、JSON null、数组和字符串都不是本协议要求的对象。
            sendError(session, "", "INVALID_JSON", "报文必须是 JSON 对象"); // 返回对象结构校验失败的错误。
            return; // 拒绝不符合协议结构的请求。
        } // 顶层 JSON 对象检查结束。

        String requestId = request.path("id").asText(""); // 读取请求 id；字段不存在时返回空字符串，避免空指针。
        String messageType = request.path("type").asText(""); // 读取应用消息类型，决定调用哪一个业务处理方法。

        if (requestId.isBlank() || requestId.length() > MAX_REQUEST_ID_LENGTH) { // 所有请求必须携带长度合法的非空白 ID。
            sendError(session, requestId, "INVALID_ID", "id 必填且不超过 128 字符"); // 用 refId 关联能读取到的请求 ID。
            return; // 请求标识不合法，不执行任何业务操作。
        } // 请求 ID 校验结束。

        if ("LOGIN".equals(messageType)) { // 登录请求需要优先处理，因为此时连接还没有绑定身份。
            handleLogin(session, request, requestId); // 校验 userId，绑定当前连接，并回复 LOGIN_OK。
            return; // 登录已经处理完毕，不再进入需要登录的业务分支。
        } // 登录专用分支结束。

        String senderUserId = userIdsBySessionId.get(session.getId()); // 根据服务端记录查身份，不信任请求中自报的 from 字段。
        if (senderUserId == null) { // 没有绑定身份意味着该连接尚未成功登录。
            sendError(session, requestId, "NOT_LOGGED_IN", "请先发送 LOGIN"); // 提示客户端先完成应用层登录。
            return; // 未登录的连接不能聊天、发心跳或确认已读。
        } // 登录状态检查结束。

        switch (messageType) { // 按应用消息类型分发，每个业务分支保持独立。
            case "PING" -> handleHeartbeat(session, requestId); // JSON 应用心跳：返回与请求关联的 PONG。
            case "CHAT" -> handleChat(session, request, requestId, senderUserId); // 处理聊天请求，确认接受并向接收方投递。
            case "READ" -> handleRead(session, request, requestId, senderUserId); // 校验已读权限，记录确认并通知原发送者。
            default -> sendError(session, requestId, "UNKNOWN_TYPE", "支持 LOGIN / CHAT / PING / READ"); // 对未知类型返回明确错误。
        } // 消息类型分发结束；箭头 switch 不需要 break，也不会贯穿到下一个分支。
    } // 收到一条文本消息的主处理流程结束。

    private void handleLogin(WebSocketSession session, JsonNode request, String requestId) throws IOException { // 登录方法只负责身份绑定和登录响应。
        String userId = request.path("payload").path("userId").asText(""); // 读取嵌套字段 payload.userId；缺少字段时得到空字符串。
        if (!USER_ID_PATTERN.matcher(userId).matches()) { // 使用预编译的正则校验整个用户 ID。
            sendError(session, requestId, "INVALID_USER", "userId 使用 1–32 位字母、数字、下划线或短横线"); // 返回用户 ID 格式错误。
            return; // 身份不合法，不修改用户与连接的映射。
        } // 用户 ID 校验结束。

        String previousUserId = userIdsBySessionId.get(session.getId()); // 查出当前连接是否曾绑定另一个身份。
        if (previousUserId != null) { // 同一连接再次 LOGIN 时，先移除旧身份的在线路由。
            sessionsByUserId.remove(previousUserId, session); // 只有旧身份仍指向本连接时才删除，避免误删另一条连接。
        } // 当前连接的旧身份解绑结束。

        WebSocketSession previousSession = sessionsByUserId.put(userId, session); // 注册新在线连接，并取得此用户先前的连接。
        userIdsBySessionId.put(session.getId(), userId); // 记录反向映射，后续请求通过 sessionId 查用户身份。
        if (previousSession != null && previousSession != session) { // 同一用户在另一条连接登录时，采用新连接替换旧连接的策略。
            previousSession.close(new CloseStatus(1008, "User logged in elsewhere")); // 1008 表示策略违规；关闭旧连接，但保留新连接。
        } // 重复登录的旧连接处理结束。

        ObjectNode response = createPacket("LOGIN_OK", requestId); // 创建登录成功响应；refId 指向 LOGIN 的 id。
        response.put("userId", userId); // 明确告知客户端当前连接绑定的身份。
        sendPacket(session, response); // 把登录成功响应发送回请求来源连接。
    } // 登录流程结束；这是教学身份绑定，不是生产环境的用户认证。

    private void handleHeartbeat(WebSocketSession session, String requestId) throws IOException { // 单独处理应用心跳，便于与聊天逻辑区分。
        ObjectNode response = createPacket("PONG", requestId); // 用 refId 关联 PING，客户端可据此计算往返时间。
        sendPacket(session, response); // 在同一条连接返回 JSON PONG；这不是 WebSocket 控制帧。
    } // 心跳处理结束；此处没有自动调度或超时检测。

    private void handleChat(WebSocketSession session, JsonNode request, String requestId, String senderUserId) throws IOException { // 处理一条已登录用户的聊天请求。
        String recipientUserId = request.path("to").asText(""); // 读取目标用户 ID，接收方由客户端选择。
        String text = request.path("payload").path("text").asText(""); // 读取聊天正文 payload.text。
        if (text.isBlank() || text.length() > MAX_TEXT_LENGTH) { // 拒绝空白内容与超出业务长度上限的文本。
            sendError(session, requestId, "INVALID_TEXT", "消息长度需要为 1–2000 字符"); // 返回文本校验错误。
            return; // 文本不合法，不生成聊天消息，也不发送投递事件。
        } // 聊天正文校验结束。

        WebSocketSession recipientSession = sessionsByUserId.get(recipientUserId); // 从在线表寻找接收者的真实连接。
        if (recipientSession == null || !recipientSession.isOpen()) { // 用户未登录或连接已关闭都按离线处理。
            sendError(session, requestId, "USER_OFFLINE", "接收方未在线；本演示不存储离线消息"); // 当前示例不支持持久化离线投递。
            return; // 接收方不可用，终止这次聊天请求。
        } // 接收方在线状态检查结束。

        String messageId = UUID.randomUUID().toString(); // 为聊天实体生成 ID，后续 MESSAGE、READ 和 RECEIPT 共用此 ID。
        ObjectNode incomingMessage = createPacket("MESSAGE", requestId); // 为接收方创建推送事件；事件 id 与聊天 messageId 含义不同。
        incomingMessage.put("messageId", messageId); // 写入聊天实体 ID，用于关联投递与已读。
        incomingMessage.put("from", senderUserId); // 发送者来自服务端登录记录，忽略客户端伪造的 from。
        incomingMessage.put("to", recipientUserId); // 写入接收者身份，帮助客户端识别目标会话。
        incomingMessage.putObject("payload").put("text", text); // 创建 payload 子对象，再填入聊天正文。

        MessageDelivery delivery = new MessageDelivery(senderUserId, recipientUserId); // 用有类型的记录表示双方，代替 "接收者:发送者" 字符串拼接。
        pendingDeliveriesByMessageId.put(messageId, delivery); // 保存待已读记录，以便 READ 时验证接收者身份。

        ObjectNode acknowledgement = createPacket("ACK", requestId); // 为发送者创建接受确认，refId 对应 CHAT 请求。
        acknowledgement.put("messageId", messageId); // 将服务端生成的聊天 ID 返回给发送者。
        acknowledgement.put("status", "accepted"); // accepted 仅表示服务端接受了消息，不表示接收者收到或已读。
        sendPacket(session, acknowledgement); // 先向发送者返回 ACK，与原有演示顺序保持一致。
        sendPacket(recipientSession, incomingMessage); // 再向接收方推送 MESSAGE；跨连接到达顺序仍由实际调度决定。
    } // 聊天处理结束；没有自动重试、幂等去重或持久化保证。

    private void handleRead(WebSocketSession session, JsonNode request, String requestId, String readerUserId) throws IOException { // 当前请求者是读消息的人，即原接收者。
        String messageId = request.path("payload").path("messageId").asText(""); // 读取客户端希望确认已读的聊天 ID。
        MessageDelivery delivery = pendingDeliveriesByMessageId.get(messageId); // 查找这条消息的投递双方。
        if (delivery == null || !delivery.recipientUserId().equals(readerUserId)) { // 只有记录存在且当前用户是接收者，才允许确认已读。
            sendError(session, requestId, "INVALID_RECEIPT", "只能确认发送给自己的消息"); // 拒绝未知消息、重复确认或越权回执。
            return; // 未通过权限检查，不修改已读记录，也不通知发送者。
        } // 已读请求的身份与消息检查结束。

        pendingDeliveriesByMessageId.remove(messageId); // 移除待确认记录；本演示用移除表示这次已读已经处理。
        ObjectNode acknowledgement = createPacket("ACK", requestId); // 给读消息的客户端创建 READ 请求确认。
        acknowledgement.put("status", "read-recorded"); // 表示服务端已处理已读；这里只是内存状态，不是数据库持久化。
        acknowledgement.put("messageId", messageId); // 明确本次确认对应哪一条聊天消息。
        sendPacket(session, acknowledgement); // 回复 READ 的来源连接，让接收者知道请求已被处理。

        WebSocketSession senderSession = sessionsByUserId.get(delivery.senderUserId()); // 查找原发送者目前的在线连接。
        if (senderSession != null && senderSession.isOpen()) { // 原发送者仍在线时，才发送已读推送。
            ObjectNode receipt = createPacket("RECEIPT", requestId); // 创建已读事件；refId 对应接收者发出的 READ 请求。
            receipt.put("messageId", messageId); // 发送者主要通过 messageId 将已读事件关联到聊天消息。
            receipt.put("from", readerUserId); // 标明是哪位接收者确认了已读。
            receipt.put("status", "read"); // read 是业务已读状态，与 CHAT 的 accepted 不同。
            sendPacket(senderSession, receipt); // 将已读事件推送给原发送者。
        } // 原发送者不在线时，本例不会缓存或补发已读事件。
    } // 已读处理结束。

    private ObjectNode createPacket(String messageType, String requestId) { // 统一创建服务端报文的公共字段，避免各业务方法重复代码。
        ObjectNode packet = objectMapper.createObjectNode(); // 创建一个可修改的空 JSON 对象。
        packet.put("type", messageType); // 写入响应或推送的业务类型。
        packet.put("id", UUID.randomUUID().toString()); // 每一条服务端报文都有自己的唯一 ID。
        packet.put("refId", requestId); // 关联触发它的客户端请求 ID，便于网页配对请求与响应。
        packet.put("timestamp", System.currentTimeMillis()); // 写入服务端生成时间：Unix 毫秒时间戳，不用于保证消息顺序。
        return packet; // 返回公共报文，调用方继续添加业务字段。
    } // 公共报文创建结束。

    private void sendError(WebSocketSession session, String requestId, String errorCode, String detail) throws IOException { // 统一构造和发送业务错误。
        ObjectNode error = createPacket("ERROR", requestId); // ERROR 也使用公共字段和关联请求的 refId。
        error.put("code", errorCode); // 错误码用于程序分支判断，例如 NOT_LOGGED_IN。
        error.put("detail", detail); // 可读说明用于网页展示和学习排查。
        sendPacket(session, error); // 发送普通 JSON 文本报文；业务错误通常不需要关闭连接。
    } // 错误响应处理结束。

    private void sendPacket(WebSocketSession session, ObjectNode packet) throws IOException { // 所有业务报文都通过这个方法发送。
        synchronized (session) { // 对同一连接串行发送；底层标准 WebSocketSession 不保证支持并发发送。
            if (session.isOpen()) { // 发送前检查连接状态；检查后仍可能断线，所以仍需声明 IOException。
                String json = objectMapper.writeValueAsString(packet); // 将 JSON 对象序列化为紧凑文本。
                session.sendMessage(new TextMessage(json)); // 包装为文本消息，实际 WebSocket 帧由 Spring 与 Tomcat 生成。
            } // 已关闭的连接直接跳过发送；此方法不代表持久化或送达保证。
        } // 离开同步块，释放该会话对象上的锁。
    } // 报文发送方法结束。

    @Override // 重写连接关闭后的生命周期回调。
    public synchronized void afterConnectionClosed(WebSocketSession session, CloseStatus status) { // 与收消息共用处理器锁；status 是关闭码与原因，本例不按原因区分清理。
        String userId = userIdsBySessionId.remove(session.getId()); // 移除反向映射，并取得这条连接此前绑定的用户身份。
        if (userId != null) { // 未登录连接没有用户状态，只需结束回调。
            sessionsByUserId.remove(userId, session); // 仅当在线表仍指向关闭的连接时移除，不误删重复登录后的新连接。
            pendingDeliveriesByMessageId.entrySet().removeIf(entry -> entry.getValue().involves(userId)); // 清理涉及此用户的待已读记录，延续本演示断线后不恢复回执的策略。
        } // 已登录连接的内存清理结束。
    } // 连接关闭回调结束；没有实现离线消息或断线同步。

    private record MessageDelivery(String senderUserId, String recipientUserId) { // Java 17 record：不可变投递记录，自动生成构造器与字段访问方法。

        private boolean involves(String userId) { // 判断某个用户是否属于这次投递的任意一方。
            return senderUserId.equals(userId) || recipientUserId.equals(userId); // 直接比较字段，避免字符串分隔符与前后缀匹配问题。
        } // 投递关联用户的判断方法结束。
    } // MessageDelivery 记录结束；它只在 ImHandler 内部使用。
} // ImHandler 类结束。
