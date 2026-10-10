/**
 * 本地字节编码工具：只生成实验数据，不向 Java 服务发送构造出的帧。
 * Protobuf schema：Chat { string to = 1; string text = 2; }。
 * 阅读顺序：varint → encode → frame。
 */
(() => {
    const encoder = new TextEncoder(); // 将 JavaScript 字符串转换为 UTF-8 Uint8Array。
    const MAX_SHORT_PAYLOAD_LENGTH = 125; // WebSocket 小于 126 字节的长度直接写入第二个字节。
    const MAX_EXTENDED_PAYLOAD_LENGTH = 65535; // 此实验仅实现短长度与 16 位扩展长度。
    const TEXT_FRAME_HEADER = 0x81; // 二进制 1000 0001：FIN=1、RSV=000、opcode=0001（文本）。
    const MASK_BIT = 0x80; // 第二个字节的最高位为 MASK 标志；客户端帧必须置 1。
    const STRING_WIRE_TYPE = 2; // Protobuf 字符串采用长度分隔 wire type。

    /**
     * 将非负长度编码为 varint：每字节用低 7 位存数据，最高位表示后面还有字节。
     * 例如 128 编码为 [0x80, 0x01]，对应两组七位数值 0 和 1。
     * 调用方仅传 UTF-8 数组长度，此方法不是通用的有符号或 64 位整数编码器。
     */
    function varint(value) {
        const bytes = []; // 保存逐步生成的普通字节数组。
        do {
            let byte = value & 0x7f; // 取当前数值的低 7 位，即模 128 的余数。
            value = Math.floor(value / 128); // 继续处理尚未编码的高位。
            if (value > 0) {
                byte |= 0x80; // 还有后续字节时，把当前字节的最高位置 1。
            }
            bytes.push(byte); // 当前字节编码完成，追加到结果中。
        } while (value > 0); // 0 也必须编码为一个字节，因此使用 do...while。
        return bytes;
    }

    /**
     * 对当前页面的 Chat schema 进行真实 Protobuf 编码。
     * 每个字符串字段 = tag + UTF-8 字节长度的 varint + UTF-8 内容。
     * 返回 bytes 供比较大小，parts 供页面逐字段解释；不实现通用 Protobuf 库。
     */
    function encode(to, text) {
        const entries = [
            [1, 'to', to], // 字段编号为 1；字段名只供页面解释，不写入二进制消息。
            [2, 'text', text], // 字段编号为 2，接收方需要相同 schema 才能还原名字。
        ];
        const bytes = []; // 保存整条 Protobuf 消息的字节。
        const parts = []; // 保存字段边界与结构，便于页面拆解。

        for (const [fieldNumber, fieldName, value] of entries) {
            if (value === '') {
                continue; // proto3 普通字符串的空值是默认值，这里省略不编码。
            }

            const body = encoder.encode(value); // 字节长度与 JavaScript 字符串 length 可能不同。
            const tag = (fieldNumber << 3) | STRING_WIRE_TYPE; // 高位放字段编号，低三位放 wire type。
            const lengthBytes = varint(body.length); // 这里记录 UTF-8 的字节数，不是字符数。
            const header = [tag, ...lengthBytes]; // ... 将长度数组展开为逐个字节。

            parts.push({
                name: fieldName,
                offset: bytes.length, // 本字段在完整消息中的起始字节偏移。
                tag,
                lengthBytes,
                body: Array.from(body), // 转为普通数组，方便页面展示和测试比较。
            });
            bytes.push(...header, ...body); // 依次连接字段头与内容；此 schema 的 tag 只需一个字节。
        }

        return { bytes: Uint8Array.from(bytes), parts }; // Uint8Array 的每个元素代表一个字节。
    }

    /**
     * 构造一个未分片、未压缩的客户端 WebSocket 文本帧。
     * 帧结构：header + 4 字节 masking key + masked payload。
     * masking 使用异或，可逆但不保密；TLS 才提供 WSS 内容加密。
     */
    function frame(text) {
        const payload = encoder.encode(text); // 把文本转成真正要放入帧的 UTF-8 字节。
        const key = crypto.getRandomValues(new Uint8Array(4)); // 每次生成新的随机 4 字节 masking key。
        const header = [TEXT_FRAME_HEADER]; // 第一字节包含 FIN、RSV 和 opcode。

        if (payload.length <= MAX_SHORT_PAYLOAD_LENGTH) {
            header.push(MASK_BIT | payload.length); // MASK=1，低 7 位直接写入长度。
        } else if (payload.length <= MAX_EXTENDED_PAYLOAD_LENGTH) {
            header.push(
                MASK_BIT | 126, // 低 7 位为 126，表示后面还有两个长度字节。
                payload.length >> 8, // 16 位长度的高字节先写入，即大端字节序。
                payload.length & 0xff, // 16 位长度的低字节后写入。
            );
        } else {
            throw new Error('此实验限 65535 字节'); // 更大的帧需要 64 位扩展长度，超出当前实验范围。
        }

        const masked = payload.map((byte, index) => byte ^ key[index % key.length]); // 四个 key 字节循环与 payload 异或。
        const bytes = Uint8Array.from([...header, ...key, ...masked]); // 按帧结构拼接为完整字节数组。
        return { bytes, header, key, payload, masked }; // 同时返回中间结果，供页面展示编码过程。
    }

    globalThis.IMLabCodec = { encode, varint, frame }; // 浏览器与 Node 测试都通过这个共享名称使用工具。
})(); // 立即执行函数建立私有作用域，内部常量不会污染页面全局变量。
