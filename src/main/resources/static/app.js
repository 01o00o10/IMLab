/**
 * 真实 WebSocket 实验的浏览器入口。
 * 阅读顺序：initializeClients → connect → handleIncomingMessage → transmit → record。
 * 每个客户端对象对应一条独立连接；教学模拟由 protocols.js 负责。
 * 此文件通过普通 script 加载，$ 这个 DOM 查询工具也供 protocols.js 使用。
 */

// 一、页面工具、客户端状态和协议说明。
const $ = (id) => document.getElementById(id); // 按 HTML id 获取元素，例如 $('logs')。
const MAX_EVENT_COUNT = 1500; // 限制时间线的内存占用；超过上限时移除最早的事件。
const TOAST_DURATION_MS = 3500; // 提示信息显示 3.5 秒，单位是毫秒。
const RESPONSE_TIMEOUT_MS = 6000; // 一键演示等待连接或响应的最长时间。
const POLL_INTERVAL_MS = 60; // 等待条件时每 60 毫秒检查一次，避免阻塞页面。

const clients = [
    { name: 'Alice', user: 'alice', to: 'bob' }, // user 是固定的元素 ID 后缀；登录身份从输入框读取。
    { name: 'Bob', user: 'bob', to: 'alice' }, // ws 和 logged 会在建立连接时添加到对象中。
];

let events = []; // 收发报文及连接事件，按页面观察到的时间顺序保存。
let selected = null; // 当前选中事件的 seq；seq 是页面事件 ID，不是 TCP 序号。
let running = false; // 防止用户同时启动多次一键演示。
let toastTimer = null; // 保存提示信息的定时器，便于新提示覆盖旧提示。

// 应用消息与连接事件的说明；这些文字显示在右侧“报文解剖”中。
const meanings = {
    LOGIN: '客户端提交身份。教学示例只绑定 userId，实际系统应验证 token。',
    LOGIN_OK: '服务端确认登录成功，现在可以发送业务消息。',
    CHAT: '客户端请求给指定用户发送文本，服务端根据已登录连接确定 from。',
    ACK: '服务端接收确认。accepted 只表示服务端接受了消息，不表示对方已读。',
    MESSAGE: '服务端推送给接收者的消息，messageId 标识这一条消息。',
    READ: '接收者明确点击已读后发出的业务确认。',
    RECEIPT: '服务端把已读状态转发给发送者。',
    PING: 'JSON 应用心跳请求，用于观察连接往返；不是底层控制帧。',
    PONG: '应用心跳响应，refId 指向对应 PING。',
    ERROR: '服务端拒绝请求，code 和 detail 解释原因。',
    OPEN: '浏览器报告连接成功：HTTP 握手已经升级为 WebSocket。',
    CLOSE: '连接关闭，包含关闭码和原因。',
    CONNECT: '开始握手。真实握手头请在浏览器 Network → WS 中查看。',
    TRANSPORT_ERROR: '浏览器报告连接异常。检查 Java 服务是否运行及连接地址。',
};

// JSON 字段说明；业务消息 ID、报文 ID 和请求关联 ID 各有不同职责。
const fields = {
    type: '业务报文类型，决定服务端的处理分支。',
    id: '本条请求或事件的唯一标识。',
    refId: '关联请求的 id，用于配对请求与响应。',
    timestamp: 'Unix 毫秒时间戳；客户端发送时间或服务端生成时间。',
    from: '发送者身份，由服务端根据登录状态生成。',
    to: '目标接收用户 ID。',
    payload: '业务内容：userId 为登录身份，text 为文本，messageId 为已读目标。',
    messageId: '服务端生成的消息 ID，关联投递与已读回执。',
    status: 'accepted = 接受；read-recorded = 已记录；read = 对方已读。',
    code: '错误码，用于程序判断错误类型。',
    detail: '可读的错误原因。',
    userId: '绑定到当前连接的教学用户身份。',
};

/** 显示一条短暂提示；textContent 将输入视为文本，不作为 HTML 执行。 */
function toast(message) {
    $('toast').textContent = message; // 写入可读的提示信息。
    $('toast').style.display = 'block'; // 让提示框可见。
    clearTimeout(toastTimer); // 取消上一次提示的关闭任务。
    toastTimer = setTimeout(() => {
        $('toast').style.display = 'none'; // 到期后隐藏提示，不移除 DOM 元素。
    }, TOAST_DURATION_MS);
}

// 二、事件记录与页面展示；这里只观察应用层文本，不捕获底层网络帧。

/** 记录一次 OUT / IN / SYSTEM 事件，并刷新时间线与详情。 */
function record(client, direction, data) {
    const event = {
        seq: crypto.randomUUID(), // 为页面上的这一条事件生成标识。
        time: Date.now(), // 浏览器观察到事件的时间，与报文 timestamp 分开保存。
        client: client.name, // 区分 Alice 和 Bob 的独立连接。
        dir: direction, // OUT=发送，IN=接收，SYSTEM=连接事件。
        data, // 保存原始应用报文或连接事件信息。
    };

    events.push(event); // 新事件追加到列表尾部。
    if (events.length > MAX_EVENT_COUNT) {
        events.shift(); // 超出容量时移除最早的事件。
    }

    renderLogs(); // 按当前搜索条件重新绘制时间线。
    selectEvent(event.seq); // 默认选中新事件，展示它的字段和关联信息。
    return event; // 返回记录，便于调用方继续使用事件信息。
}

/** 根据方向筛选和搜索词，生成可点击的报文时间线。 */
function renderLogs() {
    const searchTerm = $('search').value.toLowerCase(); // 搜索忽略大小写。
    const directionFilter = $('filter').value; // all 表示不按方向过滤。
    const visibleEvents = events.filter((event) => {
        const matchesDirection = directionFilter === 'all' || event.dir === directionFilter;
        const matchesSearch = JSON.stringify(event).toLowerCase().includes(searchTerm);
        return matchesDirection && matchesSearch; // 两个条件都满足才显示。
    });

    $('count').textContent = `${events.length} 条事件`; // 显示总事件数，而不是筛选后的条数。
    const container = $('logs'); // 取得滚动列表容器。
    container.replaceChildren(); // 清除旧行，避免重复追加相同事件。

    if (visibleEvents.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'empty';
        emptyState.textContent = events.length ? '没有匹配的报文' : '◎ 等待第一条报文';
        container.append(emptyState);
        return; // 空列表不需要继续构建报文行。
    }

    visibleEvents.forEach((event) => {
        container.append(createLogRow(event)); // 每条事件独立构建为一个按钮。
    });
    container.scrollTop = container.scrollHeight; // 让新报文自动出现在可视区域内。
}

/** 创建一行报文；拆开 DOM 构建代码，便于逐步学习每列的用途。 */
function createLogRow(event) {
    const row = document.createElement('button');
    row.dataset.seq = event.seq; // data-seq 保存事件 ID，点击和高亮都用它关联。
    row.className = 'log-row' + (selected === event.seq ? ' selected' : '');

    const time = document.createElement('span');
    time.className = 'time';
    const clock = new Date(event.time).toLocaleTimeString('zh-CN', { hour12: false });
    const milliseconds = String(event.time % 1000).padStart(3, '0');
    time.textContent = `${clock}.${milliseconds}`; // 展示到毫秒，方便观察报文先后。

    const clientName = document.createElement('small');
    clientName.textContent = event.client;
    time.append(clientName); // 客户端名称放在时间下方。

    const kind = document.createElement('span');
    const badge = document.createElement('span');
    const directionSymbols = { OUT: '↑', IN: '↓', SYSTEM: '○' };
    badge.className = `badge ${event.dir}`;
    badge.textContent = `${directionSymbols[event.dir]} ${event.data.type}`;
    kind.append(badge); // 第二列显示方向和消息类型。

    const summary = document.createElement('span');
    summary.className = 'summary';
    summary.textContent =
        event.data.payload?.text || // 聊天消息优先显示正文；?. 避免缺少 payload 时抛异常。
        event.data.detail ||
        event.data.status ||
        event.data.userId ||
        event.data.url ||
        event.data.reason ||
        event.data.refId ||
        '—'; // 其他消息依次寻找适合显示的摘要。

    row.append(time, kind, summary);
    row.onclick = () => selectEvent(event.seq); // 点击后展示这一条事件的详情。
    return row;
}

/** 展示原始 JSON、字段说明，以及通过 id / refId / messageId 找到的关联事件。 */
function selectEvent(eventId) {
    selected = eventId;
    const event = events.find((item) => item.seq === eventId);
    if (!event) {
        return; // 已被容量上限淘汰的事件无法继续展示。
    }

    document.querySelectorAll('.log-row').forEach((row) => {
        row.classList.toggle('selected', row.dataset.seq === eventId); // 只高亮当前行。
    });

    const container = $('detail');
    container.replaceChildren();
    const title = document.createElement('div');
    title.className = 'detail-type';
    title.textContent = event.data.type;

    const note = document.createElement('p');
    note.className = 'detail-note';
    note.textContent = meanings[event.data.type] || '自定义报文；此页面未定义该类型的解释。';

    const code = document.createElement('pre');
    code.className = 'json';
    code.textContent = JSON.stringify(event.data, null, 2); // 2 表示展示 JSON 时使用两空格缩进。
    container.append(title, note, code);

    Object.keys(event.data).forEach((fieldName) => {
        const row = document.createElement('div');
        row.className = 'field';
        const label = document.createElement('b');
        label.textContent = fieldName;
        const description = fields[fieldName] || '连接事件的观测信息。';
        row.append(label, document.createTextNode(description));
        container.append(row);
    });

    const relatedEvents = events.filter((item) => {
        const isAnotherEvent = item.seq !== event.seq; // 排除当前记录本身。
        const referencesCurrent = item.data.refId === event.data.id; // 其他响应引用当前请求。
        const isReferencedRequest = item.data.id === event.data.refId; // 当前响应引用另一请求。
        const sameChatMessage =
            event.data.messageId && item.data.messageId === event.data.messageId;
        return isAnotherEvent && (referencesCurrent || isReferencedRequest || sameChatMessage);
    });

    if (relatedEvents.length > 0) {
        const line = document.createElement('p');
        line.className = 'related';
        const labels = relatedEvents.map((item) => `${item.client} ${item.data.type}`);
        line.textContent = '关联事件：' + labels.join(' → ');
        container.append(line);
    }
}

// 三、真实 WebSocket 连接与业务报文。

/** 根据连接状态与应用登录状态，更新按钮和状态提示。 */
function update(client) {
    const isOpen = client.ws?.readyState === WebSocket.OPEN; // 连接 OPEN 不代表应用已经登录。
    const isConnectingOrOpen = !!client.ws && client.ws.readyState < WebSocket.CLOSING;
    const statusLabel = $('state' + client.user);

    if (client.logged) {
        statusLabel.textContent = '● 已登录';
    } else if (isOpen) {
        statusLabel.textContent = '● 已连接 / 待登录';
    } else {
        statusLabel.textContent = '○ 未连接';
    }

    statusLabel.className = 'status' + (isOpen ? ' online' : '');
    $('connect' + client.user).disabled = isConnectingOrOpen;
    $('login' + client.user).disabled = !isOpen;
    $('close' + client.user).disabled = !isOpen;
    $('send' + client.user).disabled = !client.logged;
    $('ping' + client.user).disabled = !client.logged;
    $('user' + client.user).disabled = isOpen; // 连着时锁定身份输入；重新登录仍可使用登录按钮。
}

/** 将 JSON 对象发到 Java 服务；true 只说明调用了 send，不代表对方收到。 */
function transmit(client, data) {
    if (client.ws?.readyState !== WebSocket.OPEN) {
        toast('请先建立连接');
        return false;
    }

    const text = JSON.stringify(data); // WebSocket.send 接收字符串，这里使用 JSON 文本。
    client.ws.send(text); // 浏览器负责底层帧封装与 masking。
    record(client, 'OUT', data); // 记录应用请求；接受或送达应等待服务端的业务响应。
    return true;
}

/** 创建客户端请求公共字段，再用展开语法添加业务字段。 */
function packet(type, extra = {}) {
    return {
        type,
        id: crypto.randomUUID(), // 每个请求生成新 ID，响应的 refId 会引用它。
        timestamp: Date.now(), // 客户端生成时间，不作为服务端排序依据。
        ...extra, // 如 payload、to；调用方还可覆盖前面的同名属性。
    };
}

/** 发送 LOGIN，应用登录是否成功由后续 LOGIN_OK 决定。 */
function login(client) {
    const userId = $('user' + client.user).value;
    transmit(client, packet('LOGIN', { payload: { userId } }));
}

/** 创建连接，并登记浏览器提供的四类 WebSocket 事件。 */
function connect(client) {
    if (client.ws && client.ws.readyState < WebSocket.CLOSING) {
        return; // 避免对同一客户端重复建立正在连接或已打开的连接。
    }

    const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const url = `${scheme}${location.host}/ws/im`; // 与 Java WebSocketConfig 注册的端点一致。
    record(client, 'SYSTEM', { type: 'CONNECT', url });
    client.logged = false; // 新连接需要重新登录，不能沿用旧连接的应用身份。

    const socket = new WebSocket(url); // 构造器立即开始异步握手，此时通常处于 CONNECTING。
    client.ws = socket; // 保存对象，后续按钮通过它发送或关闭连接。
    update(client);

    socket.onopen = () => {
        record(client, 'SYSTEM', { type: 'OPEN', url }); // onopen 表示握手成功。
        update(client); // 允许发送 LOGIN，但尚未允许发送 CHAT。
    };

    socket.onmessage = (event) => {
        handleIncomingMessage(client, event.data); // event.data 是服务端发来的文本正文。
    };

    socket.onclose = (event) => {
        client.logged = false;
        record(client, 'SYSTEM', {
            type: 'CLOSE',
            code: event.code, // WebSocket 关闭码，例如 1000 表示正常关闭。
            reason: event.reason || '连接已关闭',
            clean: event.wasClean, // 浏览器判断关闭握手是否正常完成。
        });
        update(client); // 禁用发送按钮，并允许用户重新连接。
    };

    socket.onerror = () => {
        record(client, 'SYSTEM', {
            type: 'TRANSPORT_ERROR',
            detail: 'WebSocket 连接异常，请检查服务端', // 浏览器不会在此事件中暴露完整网络错误详情。
        });
    };
}

/** 解析服务端文本；按消息类型更新客户端身份、消息卡片或错误提示。 */
function handleIncomingMessage(client, rawText) {
    let data;
    try {
        data = JSON.parse(rawText); // Java 服务使用 JSON 对象格式的业务报文。
    } catch {
        data = { type: 'RAW', payload: rawText }; // 非 JSON 文本仍保留原文，便于观测。
    }
    record(client, 'IN', data); // 先保留收到的报文，再执行页面业务更新。

    if (data.type === 'LOGIN_OK') {
        client.logged = true; // 只有服务端确认登录后，才启用业务发送按钮。
        update(client);
    }
    if (data.type === 'MESSAGE') {
        renderReceivedMessage(client, data); // 把消息展示在接收者卡片中。
    }
    if (data.type === 'ERROR') {
        toast(`${client.name}：${data.detail}`);
    }
}

/** 展示接收消息，已读由用户显式点击，而不是由收到 MESSAGE 自动触发。 */
function renderReceivedMessage(client, data) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const senderLabel = document.createElement('small');
    senderLabel.textContent = '来自 ' + data.from;
    bubble.append(senderLabel, document.createTextNode(data.payload.text)); // 正文使用纯文本插入。

    const readButton = document.createElement('button');
    readButton.textContent = '标记已读 →';
    readButton.style.marginTop = '8px';
    readButton.onclick = () => {
        const request = packet('READ', { payload: { messageId: data.messageId } });
        if (transmit(client, request)) {
            readButton.disabled = true; // 避免同一按钮重复发送已读请求。
            readButton.textContent = '已发送已读确认'; // 服务端是否接受仍要查看 ACK 或 ERROR。
        }
    };

    bubble.append(document.createElement('br'), readButton);
    $('chat' + client.user).append(bubble);
}

/** 从对应客户端的输入框读取正文与接收者，并发送 CHAT。 */
function sendChat(client) {
    const text = $('text' + client.user).value;
    if (!text.trim()) {
        toast('请输入消息内容');
        return; // 浏览器先检查空白内容，Java 服务仍会再次检查。
    }
    const recipient = $('to' + client.user).value;
    transmit(client, packet('CHAT', { to: recipient, payload: { text } }));
}

// 四、客户端卡片和按钮事件；模板只插入固定的本地客户端配置。

/** 创建客户端卡片；模板字符串使用换行，方便对照实际 HTML 结构阅读。 */
function createClientCard(client) {
    const card = document.createElement('article');
    card.className = 'client';
    const defaultText =
        client.name === 'Alice'
            ? '你好 Bob，一起学习 WebSocket 吧！'
            : '收到！现在我能看懂消息回执了。';

    // innerHTML 仅用于下面的固定模板；来自网络的消息正文由 textContent/createTextNode 展示。
    card.innerHTML = `
        <div class="client-head">
            <div>
                <span class="avatar">${client.name[0]}</span>
                <b>客户端 ${client.name}</b>
            </div>
            <span class="status" id="state${client.user}">○ 未连接</span>
        </div>
        <label for="user${client.user}">登录身份 / userId</label>
        <input id="user${client.user}" value="${client.user}" maxlength="32">
        <div class="actions">
            <button id="connect${client.user}">连接</button>
            <button id="login${client.user}">登录</button>
            <button id="close${client.user}">断开</button>
        </div>
        <label for="to${client.user}">接收用户 / to</label>
        <input id="to${client.user}" value="${client.to}">
        <label for="text${client.user}">消息内容 / payload.text</label>
        <textarea id="text${client.user}" maxlength="2000">${defaultText}</textarea>
        <div class="actions">
            <button class="primary" id="send${client.user}">发送消息 ↑</button>
            <button id="ping${client.user}">发送心跳</button>
        </div>
        <div class="chat" id="chat${client.user}"></div>
        <details class="raw">
            <summary>试一试：手写 JSON 报文</summary>
            <label for="raw${client.user}">原始 JSON（可测试错误报文）</label>
            <textarea id="raw${client.user}">{"type":"PING","id":"manual-1"}</textarea>
            <button id="rawsend${client.user}">发送原始报文</button>
        </details>
    `;
    return card;
}

/** 校验手写输入是否为 JSON 对象；内容字段是否合法仍由服务端判断。 */
function sendRawMessage(client) {
    let data;
    try {
        data = JSON.parse($('raw' + client.user).value);
        if (!data || Array.isArray(data) || typeof data !== 'object') {
            throw new Error('报文必须是 JSON 对象');
        }
    } catch {
        toast('请输入合法 JSON 对象');
        return;
    }
    transmit(client, data); // 单独发送，避免把发送异常误认为 JSON 格式错误。
}

/** 为两个客户端分别创建卡片，再把每个按钮绑定到对应客户端对象。 */
function initializeClients() {
    clients.forEach((client) => {
        $('clients').append(createClientCard(client));
        $('connect' + client.user).onclick = () => connect(client);
        $('login' + client.user).onclick = () => login(client);
        $('close' + client.user).onclick = () => {
            client.ws?.close(1000, '用户主动断开'); // ?. 允许尚未创建连接时直接跳过。
        };
        $('send' + client.user).onclick = () => sendChat(client);
        $('ping' + client.user).onclick = () => transmit(client, packet('PING'));
        $('rawsend' + client.user).onclick = () => sendRawMessage(client);
        update(client); // 初始状态禁用需要连接或登录的按钮。
    });
}

// 五、事件导出与一键演示。

/** 把当前所有事件导出为 JSON 文件，便于保存实验结果。 */
function exportEvents() {
    const json = JSON.stringify(events, null, 2);
    const blob = new Blob([json], { type: 'application/json' }); // 在浏览器内存中创建文件内容。
    const url = URL.createObjectURL(blob); // 为 Blob 创建临时下载地址。
    const link = document.createElement('a');
    link.href = url;
    link.download = 'im-websocket-events.json';
    link.click(); // 通过下载链接触发浏览器保存文件。
    setTimeout(() => URL.revokeObjectURL(url), 1000); // 下载启动后释放临时地址的资源。
}

/** 异步轮询条件；await 让出执行权，浏览器仍可处理网络消息和页面交互。 */
async function waitFor(predicate) {
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error('等待响应超时，请确认服务已启动');
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

/** 依次建立真实连接、登录、聊天、确认已读并发送应用心跳。 */
async function runDemo() {
    if (running) {
        return;
    }
    running = true;
    $('demo').disabled = true;

    try {
        for (const client of clients) {
            $('to' + client.user).value = client.to; // 恢复默认接收者，保证 Alice 与 Bob 互相通信。
            if (client.ws) {
                client.ws.close(); // 先结束旧连接，避免使用上次实验的身份状态。
            }
            await waitFor(() => !client.ws || client.ws.readyState === WebSocket.CLOSED);
            $('user' + client.user).value = client.user;
            connect(client);
            await waitFor(() => client.ws.readyState === WebSocket.OPEN);
            login(client);
            await waitFor(() => client.logged); // 等待 LOGIN_OK，而不是只等待连接 OPEN。
        }

        const startIndex = events.length; // 只查找本次演示中新产生的消息。
        sendChat(clients[0]); // Alice 向 Bob 发送 CHAT。
        await waitFor(() =>
            events.slice(startIndex).some((event) => {
                return event.client === 'Bob' && event.data.type === 'MESSAGE';
            }),
        );

        const incomingMessage = events.slice(startIndex).find((event) => {
            return event.client === 'Bob' && event.data.type === 'MESSAGE';
        }).data;
        transmit(clients[1], packet('READ', { payload: { messageId: incomingMessage.messageId } }));
        transmit(clients[0], packet('PING'));
        await waitFor(() => {
            const newEvents = events.slice(startIndex);
            const hasReceipt = newEvents.some((event) => event.data.type === 'RECEIPT');
            const hasPong = newEvents.some((event) => event.data.type === 'PONG');
            return hasReceipt && hasPong; // 两种响应都到达才宣布演示完成。
        });
        toast('演示完成：观察 CHAT → ACK → MESSAGE → READ → RECEIPT');
    } catch (error) {
        toast(error.message); // 连接或响应超时会进入此分支。
    } finally {
        running = false; // 无论成功或失败，都恢复按钮，允许下一次实验。
        $('demo').disabled = false;
    }
}

/** 初始化全局操作；HTML 将 script 放在页面末尾，所需 DOM 已经存在。 */
function initializePage() {
    initializeClients();
    $('search').oninput = renderLogs; // 修改搜索词时立即重新筛选。
    $('filter').onchange = renderLogs; // 选择方向时重新绘制列表。
    $('clear').onclick = () => {
        events = [];
        selected = null;
        renderLogs();
        $('detail').textContent = '点击新的报文查看字段解释。';
    };
    $('export').onclick = exportEvents;
    $('demo').onclick = runDemo;
}

initializePage(); // 执行入口：创建客户端卡片并登记页面事件。
