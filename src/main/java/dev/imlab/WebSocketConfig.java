package dev.imlab; // 与启动类处于同一包，便于 Spring 自动发现配置。

import org.springframework.context.annotation.Configuration; // 导入声明 Spring 配置类的注解。
import org.springframework.web.socket.config.annotation.EnableWebSocket; // 导入启用原生 WebSocket 支持的注解。
import org.springframework.web.socket.config.annotation.WebSocketConfigurer; // 导入 WebSocket 注册配置接口。
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry; // 导入用于登记地址与处理器的注册表。

@Configuration // 告诉 Spring：这是一个需要在启动时加载的配置类。
@EnableWebSocket // 启用 Spring 原生 WebSocket 支持；这里没有使用 STOMP。
public class WebSocketConfig implements WebSocketConfigurer { // 实现接口，通过回调注册 WebSocket 端点。

    private static final String IM_ENDPOINT = "/ws/im"; // 定义客户端连接路径，例如 ws://localhost:8080/ws/im。

    private final DurableImHandler durableImHandler; // 独立持久化实战端点，不改变原有内存实验。
    private final ImHandler imHandler; // 保存 IM 处理器；final 表示构造后不能重新赋值。

    public WebSocketConfig(ImHandler imHandler, DurableImHandler durableImHandler) { // 构造器注入：Spring 自动传入它管理的 ImHandler 实例。
        this.durableImHandler = durableImHandler; // 保存新增处理器。
        this.imHandler = imHandler; // 把注入的处理器保存为字段，供注册方法使用。
    } // 构造器结束；只有一个构造器时，不需要额外写 @Autowired。

    @Override // 表示下方方法实现了 WebSocketConfigurer 定义的回调。
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) { // Spring 启动时调用此方法。
        registry.addHandler(durableImHandler, "/ws/durable"); // 注册真实文件库实验，沿用同源策略。
        registry.addHandler(imHandler, IM_ENDPOINT); // 把 /ws/im 映射到 ImHandler；默认保留 Spring 的同源校验。
    } // 端点注册结束；浏览器握手成功后，后续文本消息交给处理器。
} // WebSocketConfig 类结束。
