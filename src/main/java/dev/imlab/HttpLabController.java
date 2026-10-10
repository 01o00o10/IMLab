package dev.imlab;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.Map;

/** 可观测的真实 HTTP 请求；独立于聊天消息，不提供认证或历史存储。 */
@RestController
@RequestMapping("/api/lab")
public class HttpLabController {
    public record EchoRequest(String text) {}
    @PostMapping("/echo")
    public ResponseEntity<Map<String, Object>> echo(@RequestBody EchoRequest request) {
        if (request.text() == null || request.text().isBlank() || request.text().length() > 2000) {
            return ResponseEntity.badRequest().body(Map.of("code", "INVALID_TEXT", "detail", "请输入 1–2000 字符"));
        }
        return ResponseEntity.ok().header("X-IM-Lab", "http-echo")
                .body(Map.of("text",request.text(),"receivedAt",System.currentTimeMillis(),"mode","real-http"));
    }
}
