/**
 * 真实文件库实验页面：双 WebSocket + IndexedDB；不借用模拟播放器的状态。
 * 浏览器只存入站消息和待发事实；实际数据库快照来自已登录连接的 INSPECT。
 */
(() => {
    let disposeCurrent = () => {};
    const storage = globalThis.IMLabDurableStorage;

    function render(panel) {
        disposeCurrent();
        const element = (tag, className, text) => {
            const node = document.createElement(tag);
            node.className = className || '';
            if (text !== undefined) node.textContent = text;
            return node;
        };
        panel.append(element('h2', '', 'Java 持久化实战 · 真实事务、离线补拉与恢复'));
        panel.append(
            element(
                'p',
                'detail-note',
                '真实 /ws/durable + 本地 H2 文件库 + 浏览器 IndexedDB。演示身份为 durable_alice / durable_bob，不验证密码。中继控制是全局教学开关；DONE 只表示耐久收件箱已落地。切换主题会关闭本实验连接。',
            ),
        );
        const guide = element('div', 'durable-guide');
        guide.append(element('h3', '', '推荐顺序'));
        guide.append(
            element(
                'p',
                '',
                '① 仅连接 Alice，发送给离线 Bob → 观察 ACK persisted。② 连接 Bob，自动补拉 → 点击已读。③ 重试 Alice 最后请求 → messageId 不变、duplicate=true。④ 选提交后断线，再连接 Alice → 原键自动重试；运行中继恢复投递。⑤ 暂停中继、发送，再重启 Java → 待处理任务自动恢复。',
            ),
        );
        panel.append(guide);
        const workspace = element('div', 'durable-clients');
        const log = element('pre', 'transaction-log durable-log');
        log.id = 'durable-log';
        log.setAttribute('aria-label', '真实收发报文时间线');
        const notices = element('p', 'detail-note', '正在打开浏览器本地事务库…');
        notices.id = 'durable-notice';
        notices.setAttribute('role', 'status');
        const rows = [];
        const controlledButtons = [];
        let database;
        let stopped = false;
        const record = (user, direction, packet) => {
            rows.push({ timestamp: Date.now(), user, direction, packet });
            if (rows.length > 200) rows.shift();
            log.textContent = rows
                .map(
                    (entry) =>
                        new Date(entry.timestamp).toLocaleTimeString() +
                        ' ' +
                        entry.user +
                        ' ' +
                        entry.direction +
                        '\n' +
                        JSON.stringify(entry.packet, null, 2),
                )
                .join('\n\n');
            log.scrollTop = log.scrollHeight;
        };
        const peers = [
            { user: 'durable_alice', to: 'durable_bob', name: 'Alice', chain: Promise.resolve() },
            { user: 'durable_bob', to: 'durable_alice', name: 'Bob', chain: Promise.resolve() },
        ];
        const uuid = () => crypto.randomUUID();
        const send = (peer, type, extra = {}) => {
            if (!peer.logged || peer.socket?.readyState !== WebSocket.OPEN)
                throw new Error(peer.name + ' 尚未登录，请先连接');
            const packet = { type, id: uuid(), ...extra };
            record(peer.user, 'OUT', packet);
            peer.socket.send(JSON.stringify(packet));
            return packet.id;
        };
        // 每个客户端按接收顺序完成本地事务，避免多个批次交错推进同步游标。
        const enqueue = (peer, work) => {
            peer.chain = peer.chain
                .then(async () => {
                    if (!stopped) await work();
                })
                .catch((error) => {
                    if (!stopped) record(peer.user, 'LOCAL_ERROR', { detail: error.message });
                });
            return peer.chain;
        };
        const redraw = async (peer) => {
            const local = await storage.state(database, peer.user);
            if (stopped) return;
            peer.local = local;
            peer.status.textContent =
                peer.name +
                ' / ' +
                (peer.logged ? '已登录' : '离线') +
                ' / 游标 ' +
                (local.cursor || '初始') +
                ' / 待发 ' +
                local.requests.filter((request) => request.status === 'pending').length;
            peer.inbox.replaceChildren();
            for (const message of local.messages) {
                const row = element('div', 'durable-message');
                row.append(element('strong', '', '#' + message.seq + ' ' + message.from));
                row.append(element('p', '', message.text));
                row.append(
                    element(
                        'small',
                        '',
                        message.messageId + (message.readAt ? ' / 已读' : ' / 未读'),
                    ),
                );
                const read = element('button', '', '标记已读');
                read.disabled = !peer.logged || Boolean(message.readAt);
                read.onclick = () =>
                    enqueue(peer, () => {
                        send(peer, 'READ', { payload: { messageId: message.messageId } });
                    });
                row.append(read);
                peer.inbox.append(row);
            }
            if (!local.messages.length)
                peer.inbox.append(element('p', 'detail-note', '本地收件箱为空；登录后自动同步。'));
        };
        const sync = (peer) => {
            if (peer.syncing) return;
            // 使用已提交的本地游标；实时 MESSAGE 不修改该游标。
            peer.syncing = send(peer, 'SYNC', {
                payload: { cursor: peer.local?.cursor || '', limit: 10 },
            });
        };
        const transmitSaved = (peer, request) =>
            send(peer, 'CHAT', {
                requestKey: request.requestKey,
                to: request.to,
                payload: { text: request.text, fault: request.fault || '' },
            });
        const incoming = async (peer, packet) => {
            switch (packet.type) {
                case 'LOGIN_OK':
                    if (peer.socket?.readyState !== WebSocket.OPEN) break;
                    peer.logged = true;
                    await redraw(peer);
                    sync(peer);
                    for (const request of peer.local.requests)
                        if (request.status === 'pending') transmitSaved(peer, request);
                    if (peer.logged && peer.socket?.readyState === WebSocket.OPEN)
                        send(peer, 'INSPECT');
                    break;
                case 'ACK':
                    await storage.acknowledge(
                        database,
                        peer.user,
                        packet.requestKey,
                        packet.messageId,
                    );
                    await redraw(peer);
                    if (peer.logged && peer.socket?.readyState === WebSocket.OPEN)
                        send(peer, 'INSPECT');
                    break;
                case 'SYNC_RESULT':
                    if (packet.refId !== peer.syncing) break;
                    try {
                        await storage.apply(
                            database,
                            peer.user,
                            packet.messages,
                            packet.nextCursor,
                        );
                    } finally {
                        // 本地事务失败也释放请求槽；下一次补拉继续使用旧的耐久游标。
                        peer.syncing = null;
                    }
                    await redraw(peer);
                    if (packet.hasMore) sync(peer);
                    break;
                case 'MESSAGE':
                    await storage.apply(database, peer.user, [packet.message]);
                    await redraw(peer);
                    sync(peer); // 补齐可能漏掉的旧提示；ID upsert 防止重复展示。
                    break;
                case 'READ_ACK':
                    await storage.markRead(database, peer.user, packet.messageId, packet.readAt);
                    await redraw(peer);
                    if (peer.logged && peer.socket?.readyState === WebSocket.OPEN)
                        send(peer, 'INSPECT');
                    break;
                case 'RECEIPT':
                    if (peer.logged && peer.socket?.readyState === WebSocket.OPEN)
                        send(peer, 'INSPECT');
                    break;
                case 'SNAPSHOT':
                    peer.snapshot.textContent = JSON.stringify(
                        {
                            relayPaused: packet.relayPaused,
                            scope: packet.scope,
                            ...packet.database,
                        },
                        null,
                        2,
                    );
                    break;
                case 'RELAY_STATUS':
                    if (peer.logged && peer.socket?.readyState === WebSocket.OPEN)
                        send(peer, 'INSPECT');
                    sync(peer);
                    break;
                case 'ERROR':
                    if (packet.refId === peer.syncing) peer.syncing = null;
                    break;
            }
        };
        const connect = (peer) => {
            if (peer.socket && peer.socket.readyState < WebSocket.CLOSING) return;
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const socket = new WebSocket(protocol + '//' + location.host + '/ws/durable');
            peer.socket = socket;
            peer.logged = false;
            peer.syncing = null;
            socket.onopen = () => {
                if (stopped || peer.socket !== socket) return socket.close();
                const packet = { type: 'LOGIN', id: uuid(), payload: { userId: peer.user } };
                record(peer.user, 'OUT', packet);
                socket.send(JSON.stringify(packet));
            };
            socket.onmessage = (event) => {
                if (stopped || peer.socket !== socket) return;
                try {
                    const packet = JSON.parse(event.data);
                    record(peer.user, 'IN', packet);
                    enqueue(peer, () =>
                        peer.socket === socket ? incoming(peer, packet) : undefined,
                    );
                } catch (error) {
                    record(peer.user, 'INVALID_RESPONSE', { detail: error.message });
                }
            };
            socket.onclose = (event) => {
                if (stopped || peer.socket !== socket) return;
                peer.logged = false;
                peer.syncing = null;
                record(peer.user, 'CLOSE', { code: event.code, reason: event.reason });
                enqueue(peer, () => redraw(peer));
            };
            socket.onerror = () =>
                record(peer.user, 'TRANSPORT_ERROR', { detail: '连接失败，请检查 Java 服务' });
        };
        for (const peer of peers) {
            const card = element('section', 'durable-client');
            peer.status = element('h3', '', peer.name + ' / 离线');
            const actions = element('div', 'durable-actions');
            const add = (label, action, suffix) => {
                const button = element('button', '', label);
                button.id = 'durable-' + peer.name.toLowerCase() + '-' + suffix;
                button.disabled = true;
                button.onclick = () => enqueue(peer, action);
                actions.append(button);
                controlledButtons.push(button);
                return button;
            };
            add('连接并恢复', () => connect(peer), 'connect');
            add('断开', () => peer.socket?.close(1000, 'Demo offline'), 'disconnect');
            add('补拉消息', () => sync(peer), 'sync');
            add('查看数据库', () => send(peer, 'INSPECT'), 'inspect');
            add(
                '重试最后请求',
                () => {
                    const request = peer.local?.requests.at(-1);
                    if (!request) throw new Error('尚无耐久发送请求');
                    transmitSaved(peer, request);
                },
                'retry',
            );
            add(
                '重置本地入站缓存',
                async () => {
                    if (peer.syncing) throw new Error('请等当前同步批次完成后再重置');
                    await storage.resetInbox(database, peer.user);
                    await redraw(peer);
                    if (peer.logged) sync(peer);
                },
                'reset',
            );
            const text = element('textarea');
            text.value = '这条消息会写入真实数据库，即使对方离线。';
            text.maxLength = 2000;
            text.setAttribute('aria-label', peer.name + ' 发送正文');
            text.id = 'durable-' + peer.name.toLowerCase() + '-text';
            const fault = element('select');
            fault.setAttribute('aria-label', peer.name + ' 发送故障位置');
            fault.id = 'durable-' + peer.name.toLowerCase() + '-fault';
            for (const [value, label] of [
                ['', '正常发送'],
                ['AFTER_COMMIT', '提交后断开，丢失 ACK'],
                ['AFTER_INBOX', '收件箱提交后中断中继'],
            ]) {
                const option = element('option', '', label);
                option.value = value;
                fault.append(option);
            }
            fault.value = '';
            add(
                '保存请求并发送',
                async () => {
                    if (!text.value.trim()) throw new Error('正文不能为空');
                    const request = {
                        requestKey: uuid(),
                        to: peer.to,
                        text: text.value,
                        fault: fault.value,
                    };
                    await storage.saveRequest(database, peer.user, request);
                    await redraw(peer);
                    if (peer.logged) transmitSaved(peer, request);
                    else
                        record(peer.user, 'LOCAL_PENDING', {
                            requestKey: request.requestKey,
                            detail: '已耐久保存，连接后自动发送',
                        });
                },
                'send',
            );
            // 中继开关影响所有用户，只用于本机教学；恢复服务默认重新开启。
            for (const [action, label] of [
                ['pause', '暂停中继'],
                ['run', '运行一批中继'],
                ['resume', '恢复自动中继'],
            ]) {
                add(label, () => send(peer, 'RELAY', { payload: { action } }), action);
            }
            peer.inbox = element('div', 'durable-inbox');
            peer.snapshot = element(
                'pre',
                'json durable-snapshot',
                '登录后可以查看当前用户相关的实际数据库记录。',
            );
            card.append(
                peer.status,
                text,
                fault,
                actions,
                element('h4', '', '浏览器耐久收件箱'),
                peer.inbox,
                element('h4', '', 'Java 数据库快照'),
                peer.snapshot,
            );
            workspace.append(card);
        }
        panel.append(notices, workspace, element('h3', '', '真实报文时间线'), log);
        const exportButton = element('button', '', '导出报文 JSON');
        exportButton.onclick = () => {
            const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = element('a');
            link.href = url;
            link.download = 'imlab-durable-events.json';
            link.click();
            URL.revokeObjectURL(url);
        };
        panel.append(exportButton);
        disposeCurrent = () => {
            stopped = true;
            for (const peer of peers) peer.socket?.close(1000, 'Leaving durable lab');
            // 已排入队列的事务完成后再关本地库，避免关库打断批次提交。
            Promise.all(peers.map((peer) => peer.chain)).then(() => database?.close());
        };
        storage
            .open()
            .then(async (opened) => {
                database = opened;
                if (stopped) return database.close();
                for (const peer of peers) {
                    await redraw(peer);
                }
                if (stopped) return;
                for (const button of controlledButtons) button.disabled = false;
                notices.textContent =
                    '本地库已就绪。可离线保存请求；连接后自动重试 pending 记录并从耐久游标补拉。正文与游标按批次原子保存，实时提示不推进游标。';
            })
            .catch((error) => {
                if (!stopped) notices.textContent = error.message;
            });
    }
    globalThis.IMLabDurable = { render, dispose: () => disposeCurrent() };
})();
