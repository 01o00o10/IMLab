package dev.imlab; // 声明包名：Spring Boot 默认从这个包向下扫描组件。

import org.springframework.scheduling.annotation.EnableScheduling; // 启用 Outbox 周期扫描。
import org.springframework.boot.SpringApplication; // 导入 Spring Boot 的启动工具。
import org.springframework.boot.autoconfigure.SpringBootApplication; // 导入自动配置、组件扫描和配置类的组合注解。

@EnableScheduling // 定时恢复 PENDING Outbox 事件。
@SpringBootApplication // 让 Spring 创建应用容器，并自动配置内嵌 HTTP 服务器等组件。
public class Application { // 应用启动入口；具体 WebSocket 配置放在独立的 WebSocketConfig 中。

    public static void main(String[] args) { // JVM 从 main 方法开始运行；args 是命令行参数。
        SpringApplication.run(Application.class, args); // 启动 Spring 容器和内嵌 Tomcat，加载网页及 WebSocket 服务。
    } // main 方法结束；服务器仍由它的工作线程持续运行。
} // Application 类结束。
