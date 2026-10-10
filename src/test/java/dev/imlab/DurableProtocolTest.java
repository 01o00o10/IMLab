package dev.imlab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/** 真实端口、真实 WebSocket、真实 H2；端到端确认协议和持久化边界。 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "imlab.durable.jdbc-url=jdbc:h2:mem:durable-protocol;DB_CLOSE_DELAY=-1",
        "imlab.durable.relay-delay-ms=3600000"
})
class DurableProtocolTest {
    @LocalServerPort int port;
    private final ObjectMapper mapper = new ObjectMapper();

    class Peer implements WebSocket.Listener, AutoCloseable {
        final BlockingQueue<String> messages = new LinkedBlockingQueue<>();
        final CompletableFuture<Integer> closed = new CompletableFuture<>();
        final StringBuilder buffer = new StringBuilder();
        final WebSocket socket;

        Peer() {
            socket = HttpClient.newHttpClient().newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws/durable"), this).join();
        }
        @Override public void onOpen(WebSocket socket) { socket.request(1); }
        @Override public CompletionStage<?> onText(WebSocket socket, CharSequence text, boolean last) {
            buffer.append(text);
            if (last) { messages.add(buffer.toString()); buffer.setLength(0); }
            socket.request(1);
            return null;
        }
        @Override public CompletionStage<?> onClose(WebSocket socket, int code, String reason) {
            closed.complete(code);
            return null;
        }
        void send(String type, String extra) {
            socket.sendText("{\"type\":\"" + type + "\",\"id\":\"req-" + java.util.UUID.randomUUID() + "\"" + extra + "}", true).join();
        }
        JsonNode next(String type) throws Exception {
            String raw = messages.poll(5, TimeUnit.SECONDS);
            assertNotNull(raw, "等待 " + type + " 超时");
            JsonNode packet = mapper.readTree(raw);
            assertEquals(type, packet.path("type").asText(), raw);
            return packet;
        }
        void login(String user) throws Exception {
            send("LOGIN", ",\"payload\":{\"userId\":\"" + user + "\"}");
            next("LOGIN_OK");
        }
        @Override public void close() { if (!socket.isOutputClosed()) socket.sendClose(1000, "test finished").join(); }
    }

    @Test
    void offlineSendDedupSyncAndReadAreReal() throws Exception {
        try (var alice = new Peer(); var bob = new Peer()) {
            alice.login("offline_alice");
            alice.send("RELAY", ",\"payload\":{\"action\":\"resume\"}");
            alice.next("RELAY_STATUS");
            String chat = ",\"requestKey\":\"key-1\",\"from\":\"forged\",\"to\":\"offline_bob\",\"payload\":{\"text\":\"offline hello\"}";
            alice.send("CHAT", chat);
            JsonNode original = alice.next("ACK");
            assertEquals("persisted", original.path("status").asText());
            assertFalse(original.path("duplicate").asBoolean());
            alice.send("CHAT", chat);
            JsonNode retry = alice.next("ACK");
            assertTrue(retry.path("duplicate").asBoolean());
            assertEquals(original.path("messageId"), retry.path("messageId"));
            alice.send("CHAT", chat.replace("offline hello", "changed"));
            assertEquals("KEY_CONFLICT", alice.next("ERROR").path("code").asText());
            bob.login("offline_bob");
            bob.send("SYNC", ",\"payload\":{\"cursor\":\"\",\"limit\":1}");
            JsonNode sync = bob.next("SYNC_RESULT");
            assertEquals(1, sync.path("messages").size());
            JsonNode message = sync.path("messages").get(0);
            assertEquals("offline_alice", message.path("from").asText());
            assertEquals(original.path("messageId"), message.path("messageId"));
            bob.send("SYNC", ",\"payload\":{\"cursor\":\"" + sync.path("nextCursor").asText() + "\"}");
            assertTrue(bob.next("SYNC_RESULT").path("messages").isEmpty());
            String read = ",\"payload\":{\"messageId\":\"" + message.path("messageId").asText() + "\"}";
            alice.send("READ", read);
            assertEquals("INVALID_RECEIPT", alice.next("ERROR").path("code").asText());
            bob.send("READ", read);
            long readAt = bob.next("READ_ACK").path("readAt").asLong();
            assertEquals(readAt, alice.next("RECEIPT").path("readAt").asLong());
            bob.send("READ", read);
            assertEquals(readAt, bob.next("READ_ACK").path("readAt").asLong());
            alice.next("RECEIPT");
            alice.send("INSPECT", "");
            JsonNode snapshot = alice.next("SNAPSHOT").path("database");
            assertEquals(1, snapshot.path("messages").size());
            assertEquals("DONE", snapshot.path("outbox").get(0).path("state").asText());
        }
    }

    @Test
    void committedAckLossAndRelayCheckpointLossRecoverWithoutNewMessage() throws Exception {
        String chat = ",\"requestKey\":\"lost-ack\",\"to\":\"fault_bob\",\"payload\":{\"text\":\"committed\",\"fault\":\"AFTER_COMMIT\"}";
        try (var first = new Peer()) {
            first.login("fault_alice");
            first.send("CHAT", chat);
            assertEquals(1011, first.closed.get(5, TimeUnit.SECONDS));
            assertTrue(first.messages.isEmpty()); // 没收到 ACK，数据库仍然已经提交。
        }
        try (var recovered = new Peer(); var bob = new Peer()) {
            recovered.login("fault_alice");
            recovered.send("CHAT", chat);
            assertTrue(recovered.next("ACK").path("duplicate").asBoolean());
            recovered.send("INSPECT", "");
            assertEquals("PENDING", recovered.next("SNAPSHOT").path("database").path("outbox").get(0).path("state").asText());
            recovered.send("RELAY", ",\"payload\":{\"action\":\"resume\"}");
            recovered.next("RELAY_STATUS");
            recovered.send("CHAT", ",\"requestKey\":\"checkpoint-loss\",\"to\":\"fault_bob\",\"payload\":{\"text\":\"replay\",\"fault\":\"AFTER_INBOX\"}");
            recovered.next("ACK");
            recovered.send("INSPECT", "");
            JsonNode before = recovered.next("SNAPSHOT");
            assertTrue(before.path("relayPaused").asBoolean());
            JsonNode failed = null;
            for (JsonNode event : before.path("database").path("outbox")) if (event.path("state").asText().equals("PENDING")) failed = event;
            assertNotNull(failed);
            assertEquals(1, failed.path("attempts").asInt());
            recovered.send("RELAY", ",\"payload\":{\"action\":\"resume\"}");
            recovered.next("RELAY_STATUS");
            recovered.send("INSPECT", "");
            JsonNode after = recovered.next("SNAPSHOT");
            for (JsonNode event : after.path("database").path("outbox")) {
                if (event.path("eventId").equals(failed.path("eventId"))) {
                    assertEquals(2, event.path("attempts").asInt());
                    assertEquals("DONE", event.path("state").asText());
                }
            }
            bob.login("fault_bob");
            bob.send("SYNC", "");
            assertEquals(2, bob.next("SYNC_RESULT").path("messages").size());
        }
    }

    @Test
    void invalidRequestsAndCrossUserCursorDoNotLeakData() throws Exception {
        try (var peer = new Peer()) {
            peer.send("SYNC", "");
            assertEquals("NOT_LOGGED_IN", peer.next("ERROR").path("code").asText());
            peer.login("validation_user");
            peer.send("SYNC", ",\"payload\":{\"cursor\":\"v1.other.0\"}");
            assertEquals("INVALID_CURSOR", peer.next("ERROR").path("code").asText());
            peer.send("SYNC", ",\"payload\":{\"limit\":1.5}");
            assertEquals("INVALID_LIMIT", peer.next("ERROR").path("code").asText());
            peer.send("CHAT", ",\"to\":\"bob\",\"payload\":{\"text\":\"missing key\"}");
            assertEquals("INVALID_KEY", peer.next("ERROR").path("code").asText());
            peer.send("INSPECT", "");
            assertTrue(peer.next("SNAPSHOT").path("database").path("messages").isEmpty());
        }
    }
}
