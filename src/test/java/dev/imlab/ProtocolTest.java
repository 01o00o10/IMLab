package dev.imlab;

import com.fasterxml.jackson.databind.*;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import java.net.URI;
import java.net.http.*;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT, properties="imlab.durable.jdbc-url=jdbc:h2:mem:legacy-tests;DB_CLOSE_DELAY=-1")
class ProtocolTest {
    @LocalServerPort int port;
    final ObjectMapper mapper=new ObjectMapper();
    class Peer implements WebSocket.Listener {
        final BlockingQueue<String> messages=new LinkedBlockingQueue<>();
        final StringBuilder buffer=new StringBuilder();
        WebSocket socket;
        Peer() { socket=HttpClient.newHttpClient().newWebSocketBuilder().buildAsync(URI.create("ws://127.0.0.1:"+port+"/ws/im"),this).join(); }
        public void onOpen(WebSocket s) { s.request(1); }
        public CompletionStage<?> onText(WebSocket s,CharSequence text,boolean last) {
            buffer.append(text);if(last){messages.add(buffer.toString());buffer.setLength(0);}s.request(1);return null;
        }
        void send(String text) { socket.sendText(text,true).join(); }
        JsonNode next(String type) throws Exception {
            String raw=messages.poll(5,TimeUnit.SECONDS);assertNotNull(raw,"等待 "+type+" 超时");JsonNode data=mapper.readTree(raw);assertEquals(type,data.path("type").asText());return data;
        }
        void close() {socket.sendClose(1000,"test complete").join();}
    }
    @Test void servesObservationPage() throws Exception {
        var client=HttpClient.newHttpClient();
        for(String path:new String[]{"/","/app.js","/style.css","/protocols.js","/codec.js","/protocol-scenes.js","/business-scenes.js","/architecture-scenes.js","/architecture-labs.js","/production-scenes.js","/production-labs.js","/durable-storage.js","/durable-lab.js"}) {
            var response=client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+path)).build(),HttpResponse.BodyHandlers.ofString());
            assertEquals(200,response.statusCode());
            assertFalse(response.body().isBlank());
            if(path.equals("/"))assertTrue(response.body().contains("报文时间线"));
        }
    }
    @Test void httpEchoReturnsRealResponseAndRejectsInvalidText() throws Exception {
        var client=HttpClient.newHttpClient();
        var url=URI.create("http://127.0.0.1:"+port+"/api/lab/echo");
        var response=client.send(HttpRequest.newBuilder(url).header("Content-Type","application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{\"text\":\"你好 HTTP\"}")).build(),HttpResponse.BodyHandlers.ofString());
        assertEquals(200,response.statusCode());
        assertEquals("http-echo",response.headers().firstValue("X-IM-Lab").orElseThrow());
        assertEquals("你好 HTTP",mapper.readTree(response.body()).path("text").asText());
        assertEquals("real-http",mapper.readTree(response.body()).path("mode").asText());
        for(String body:new String[]{"{}","{\"text\":\"\"}","{\"text\":\""+"a".repeat(2001)+"\"}"}) {
            var invalid=client.send(HttpRequest.newBuilder(url).header("Content-Type","application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body)).build(),HttpResponse.BodyHandlers.ofString());
            assertEquals(400,invalid.statusCode());
            assertEquals("INVALID_TEXT",mapper.readTree(invalid.body()).path("code").asText());
        }
    }
    @Test void completeConversationAndErrors() throws Exception {
        Peer alice=new Peer(),bob=new Peer();
        try {
            alice.send("not json");assertEquals("INVALID_JSON",alice.next("ERROR").path("code").asText());
            alice.send("{\"type\":\"PING\",\"id\":\"pre\"}");assertEquals("NOT_LOGGED_IN",alice.next("ERROR").path("code").asText());
            alice.send("{\"type\":\"LOGIN\",\"id\":\"a1\",\"payload\":{\"userId\":\"alice\"}}");alice.next("LOGIN_OK");
            bob.send("{\"type\":\"LOGIN\",\"id\":\"b1\",\"payload\":{\"userId\":\"bob\"}}");bob.next("LOGIN_OK");
            alice.send("{\"type\":\"CHAT\",\"id\":\"chat1\",\"from\":\"fake\",\"to\":\"bob\",\"payload\":{\"text\":\"你好\"}}");
            JsonNode ack=alice.next("ACK"),msg=bob.next("MESSAGE");
            assertEquals("chat1",ack.path("refId").asText());assertEquals("accepted",ack.path("status").asText());assertEquals("alice",msg.path("from").asText());assertEquals("你好",msg.path("payload").path("text").asText());assertEquals(ack.path("messageId"),msg.path("messageId"));
            String id=msg.path("messageId").asText();
            alice.send("{\"type\":\"READ\",\"id\":\"fake-read\",\"payload\":{\"messageId\":\""+id+"\"}}");assertEquals("INVALID_RECEIPT",alice.next("ERROR").path("code").asText());
            bob.send("{\"type\":\"READ\",\"id\":\"read1\",\"payload\":{\"messageId\":\""+id+"\"}}");bob.next("ACK");assertEquals("read",alice.next("RECEIPT").path("status").asText());
            alice.send("{\"type\":\"PING\",\"id\":\"ping1\"}");assertEquals("ping1",alice.next("PONG").path("refId").asText());
            alice.send("{\"type\":\"CHAT\",\"id\":\"offline\",\"to\":\"nobody\",\"payload\":{\"text\":\"hi\"}}");assertEquals("USER_OFFLINE",alice.next("ERROR").path("code").asText());
        } finally {alice.close();bob.close();}
    }
}
