/**
 * 浏览器耐久状态：每个账号有独立待发记录、入站消息与同步游标。
 * 收到批次时，消息和游标必须在同一 IndexedDB 事务中提交。
 */
(() => {
    function open() {
        return new Promise((resolve, reject) => {
            if (!globalThis.indexedDB)
                return reject(new Error('浏览器不支持 IndexedDB，无法运行耐久客户端实验'));
            const request = indexedDB.open('imlab-durable-v1', 1);
            request.onupgradeneeded = () => {
                for (const name of ['messages', 'requests', 'cursors'])
                    request.result.createObjectStore(name, { keyPath: 'key' });
            };
            request.onerror = () => reject(request.error);
            request.onblocked = () =>
                reject(new Error('本地库升级被其它标签页阻塞，请关闭旧标签页'));
            request.onsuccess = () => resolve(request.result);
        });
    }

    /** 只在事务 oncomplete 后报告成功，不能拿单条 put 成功当作整批落地。 */
    function transaction(database, stores, mode, work) {
        return new Promise((resolve, reject) => {
            const tx = database.transaction(stores, mode);
            let result;
            tx.oncomplete = () => resolve(typeof result === 'function' ? result() : result);
            tx.onabort = () => reject(tx.error || new Error('本地事务已回滚'));
            tx.onerror = () => {}; // 默认事件继续触发事务回滚，由 onabort 统一报告。
            try {
                result = work(tx);
            } catch (error) {
                tx.abort();
                reject(error);
            }
        });
    }

    function key(user, id) {
        return user + '|' + id;
    }

    async function state(database, user) {
        return transaction(database, ['messages', 'requests', 'cursors'], 'readonly', (tx) => {
            const messages = tx.objectStore('messages').getAll();
            const requests = tx.objectStore('requests').getAll();
            const cursor = tx.objectStore('cursors').get(user);
            return () => ({
                messages: messages.result
                    .filter((item) => item.user === user)
                    .sort((a, b) => a.seq - b.seq),
                requests: requests.result
                    .filter((item) => item.user === user)
                    .sort((a, b) => a.savedAt - b.savedAt),
                cursor: cursor.result?.cursor || '',
            });
        });
    }

    /** 保存待发事实后才允许调用 WebSocket.send；刷新页面仍可复用相同键。 */
    function saveRequest(database, user, request) {
        return transaction(database, ['requests'], 'readwrite', (tx) => {
            tx.objectStore('requests').put({
                ...request,
                key: key(user, request.requestKey),
                user,
                savedAt: Date.now(),
                status: 'pending',
            });
        });
    }

    function acknowledge(database, user, requestKey, messageId) {
        return transaction(database, ['requests'], 'readwrite', (tx) => {
            const store = tx.objectStore('requests');
            const request = store.get(key(user, requestKey));
            request.onsuccess = () => {
                if (request.result)
                    store.put({ ...request.result, status: 'persisted', messageId });
            };
        });
    }

    /** 实时提示可存消息，但绝不推进游标，以免跳过尚未同步的旧消息。 */
    function apply(database, user, messages, nextCursor) {
        return transaction(database, ['messages', 'cursors'], 'readwrite', (tx) => {
            const store = tx.objectStore('messages');
            for (const message of messages) {
                const messageKey = key(user, message.messageId);
                const existing = store.get(messageKey);
                existing.onsuccess = () => {
                    // 保留已经明确记录的已读状态，避免旧推送回写成未读。
                    store.put({
                        ...message,
                        readAt: message.readAt || existing.result?.readAt || null,
                        key: messageKey,
                        user,
                    });
                };
            }
            if (nextCursor !== undefined)
                tx.objectStore('cursors').put({ key: user, cursor: nextCursor });
        });
    }

    function markRead(database, user, messageId, readAt) {
        return transaction(database, ['messages'], 'readwrite', (tx) => {
            const store = tx.objectStore('messages');
            const request = store.get(key(user, messageId));
            request.onsuccess = () => {
                if (request.result) store.put({ ...request.result, readAt });
            };
        });
    }

    /** 只重置当前账号的入站缓存和游标，保留待发键与服务端数据。 */
    function resetInbox(database, user) {
        return transaction(database, ['messages', 'cursors'], 'readwrite', (tx) => {
            const store = tx.objectStore('messages');
            const request = store.getAll();
            request.onsuccess = () => {
                for (const message of request.result)
                    if (message.user === user) store.delete(message.key);
            };
            tx.objectStore('cursors').delete(user);
        });
    }

    globalThis.IMLabDurableStorage = {
        open,
        state,
        saveRequest,
        acknowledge,
        apply,
        markRead,
        resetInbox,
    };
})();
