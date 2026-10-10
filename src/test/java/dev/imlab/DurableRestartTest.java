package dev.imlab;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

/** 两次启动真实应用容器，复用文件库，验证新实例定时恢复待处理事件。 */
class DurableRestartTest {
    @TempDir Path directory;

    private ServletWebServerApplicationContext start(String jdbc) {
        return (ServletWebServerApplicationContext) SpringApplication.run(Application.class,
                "--server.port=0", "--server.address=127.0.0.1",
                "--imlab.durable.jdbc-url=" + jdbc, "--imlab.durable.relay-delay-ms=50",
                "--spring.main.banner-mode=off", "--logging.level.root=WARN");
    }

    @Test
    void applicationRestartAutomaticallyRecoversPendingOutbox() throws Exception {
        String jdbc = "jdbc:h2:file:" + directory.resolve("application-restart") + ";WRITE_DELAY=0";
        String messageId;
        // 第一次运行真实提交，注入中继故障后关闭整个应用上下文。
        try (var first = start(jdbc)) {
            var handler = first.getBean(DurableImHandler.class);
            var store = first.getBean(DurableStore.class);
            synchronized (handler) {
                var commit = store.accept("restart_alice", "restart_bob", "restart-key", "survives restart", true);
                messageId = commit.message().messageId();
                // 收件箱先提交，中继故障使扫描暂停；用实际定时器发现故障。
            }
            long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
            while (store.inspect("restart_alice").outbox().get(0).attempts() < 1 && System.nanoTime() < deadline) {
                Thread.sleep(20);
            }
            assertEquals("PENDING", store.inspect("restart_alice").outbox().get(0).state());
            assertEquals(1, store.inspect("restart_alice").outbox().get(0).attempts());
        }
        // 新处理器不继承旧的内存暂停开关，从同一文件中重放事件。
        try (var second = start(jdbc)) {
            var store = second.getBean(DurableStore.class);
            long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
            while (!store.pendingEvents(10).isEmpty() && System.nanoTime() < deadline) Thread.sleep(20);
            assertTrue(store.pendingEvents(10).isEmpty());
            var page = store.sync("restart_bob", "", 10);
            assertEquals(1, page.messages().size());
            assertEquals(messageId, page.messages().get(0).messageId());
            assertEquals(2, store.inspect("restart_alice").outbox().get(0).attempts());
        }
    }
}
