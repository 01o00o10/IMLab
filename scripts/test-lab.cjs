/**
 * 使用 Node 内置测试框架验证字节编码、协议播放器和浏览器客户端的交互逻辑。
 * 下方 DOM 与 WebSocket 是测试替身，不是浏览器排版测试或真实网络服务。
 * 真实 HTTP / WebSocket 链路由 Java 的 ProtocolTest 验证。
 * 执行：node --test scripts/test-lab.cjs。
 */
const { test } = require('node:test'); // 内置测试框架，无需安装 npm 依赖。
const assert = require('node:assert/strict'); // 使用严格断言，比较结果时不自动转换类型。
const vm = require('node:vm'); // 为每个页面测试创建隔离的 JavaScript 执行环境。
const fs = require('node:fs'); // 从项目中读取实际脚本，而不是复制一份被测实现。
require('../src/main/resources/static/codec.js');
// 一、编码测试：使用明确的期望字节验证算法，而不是只检查输出非空。
test('Protobuf encodes UTF-8 lengths, multi-byte varints and proto3 defaults', () => {
    const p = IMLabCodec.encode('bob', '你好');
    assert.deepEqual([...p.bytes], [10, 3, 98, 111, 98, 18, 6, 228, 189, 160, 229, 165, 189]);
    assert.equal(IMLabCodec.encode('', '').bytes.length, 0);
    assert.deepEqual(IMLabCodec.varint(128), [128, 1]);
    assert.deepEqual(IMLabCodec.encode('', 'a'.repeat(128)).parts[0].lengthBytes, [128, 1]);
});
test('WebSocket text frame masking can be reversed for short and extended lengths', () => {
    for (const text of ['hello', '你好', 'a'.repeat(126), 'a'.repeat(1000)]) {
        const frame = IMLabCodec.frame(text);
        assert.equal(frame.bytes[0], 0x81);
        assert.equal(frame.bytes[1] & 0x80, 0x80);
        if (frame.payload.length >= 126) {
            assert.equal(frame.bytes[1], 0xfe);
            assert.equal((frame.bytes[2] << 8) | frame.bytes[3], frame.payload.length);
        }
        const recovered = frame.masked.map((b, i) => b ^ frame.key[i % 4]);
        assert.equal(new TextDecoder().decode(recovered), text);
    }
});
// 二、轻量 DOM 测试替身：只提供当前页面代码使用到的元素操作。
/** 在内存中保存元素、文本与事件，支持查找和点击；不计算 CSS 布局。 */
class Element {
    constructor(tag = 'div') {
        this.tag = tag;
        this.children = [];
        this.dataset = {};
        this.attrs = {};
        this.style = { setProperty() {} };
        this.className = '';
        this.disabled = false;
        this.value = '';
        this._text = '';
        this.classList = {
            toggle: (c, on) => {
                const set = new Set(this.className.split(' ').filter(Boolean));
                if (on) {
                    set.add(c);
                } else {
                    set.delete(c);
                }
                this.className = [...set].join(' ');
            },
        };
    }
    append(...children) {
        for (let c of children) {
            if (typeof c === 'string') {
                c = Object.assign(new Element('text'), { textContent: c });
            }
            c.parent = this;
            this.children.push(c);
        }
    }
    replaceChildren(...children) {
        this.children = [];
        this._text = '';
        this.append(...children);
    }
    set textContent(text) {
        this._text = String(text);
        this.children = [];
    }
    get textContent() {
        return this._text + this.children.map((c) => c.textContent).join(' ');
    }
    set innerHTML(text) {
        this.replaceChildren();
        this._text = text;
        // 仅从固定模板提取有 id 的控件；不是通用 HTML 解析器。
        const controls =
            /<(input|textarea|button|div|span|select|section|nav)\b([^>]*\bid="([^"]+)"[^>]*)>/g;
        for (const match of text.matchAll(controls)) {
            const element = new Element(match[1]);
            element.id = match[3];
            element.value = match[2].match(/\bvalue="([^"]*)"/)?.[1] || '';
            if (element.tag === 'textarea') {
                const contentStart = match.index + match[0].length;
                const contentEnd = text.indexOf('</textarea>', contentStart);
                element.value = text.slice(contentStart, contentEnd);
            }
            this.append(element);
        }
    }
    setAttribute(name, value) {
        this.attrs[name] = value;
    }
    focus() {
        this.focused = true; // 用于验证键盘切换标签后焦点跟随。
    }
    /** 从父元素中移除自己，模拟页面清理旧编码结果。 */
    remove() {
        if (this.parent) {
            this.parent.children = this.parent.children.filter((c) => c !== this);
        }
    }
    /** 递归查找后代：测试只需要 .class 或标签名这两种选择器。 */
    querySelectorAll(selector) {
        const all = [];
        const visit = (e) => {
            for (const c of e.children) {
                if (
                    selector.startsWith('.')
                        ? c.className.split(' ').includes(selector.slice(1))
                        : c.tag === selector
                ) {
                    all.push(c);
                }
                visit(c);
            }
        };
        visit(this);
        return all;
    }
}
/** 创建协议页面容器，并按真实加载顺序执行场景数据和播放器。 */
function fixture() {
    const timers = new Map();
    let nextTimerId = 0;
    const root = new Element();
    for (const id of [
        'protocol-panel',
        'lab-nav',
        'websocket-panel',
        'demo',
        'topic-filters',
        'topic-search',
        'topic-filter-count',
    ]) {
        const e = new Element();
        e.id = id;
        root.append(e);
    }
    const find = (id) => {
        let found;
        const visit = (e) => {
            if (e.id === id) {
                found = e;
            }
            for (const c of e.children) {
                visit(c);
            }
        };
        visit(root);
        return found;
    };
    const context = vm.createContext({
        console,
        document: {
            createElement: (t) => new Element(t),
            createTextNode: (t) => Object.assign(new Element('text'), { textContent: t }),
            addEventListener() {},
        },
        $: find,
        IMLabCodec,
        TextEncoder,
        performance,
        AbortSignal,
        setInterval: (callback) => {
            const id = ++nextTimerId;
            timers.set(id, callback);
            return id;
        },
        clearInterval: (id) => timers.delete(id),
        fetch: async () => ({
            status: 200,
            statusText: 'OK',
            headers: new Map([['content-type', 'application/json']]),
            text: async () => '{"text":"hello","mode":"real-http"}',
        }),
    });
    // 场景数据需先加载，随后播放器才能读取 IMLabScenes。
    vm.runInContext(
        fs.readFileSync('src/main/resources/static/protocol-scenes.js', 'utf8'),
        context,
    );
    vm.runInContext(
        fs.readFileSync('src/main/resources/static/business-scenes.js', 'utf8'),
        context,
    );
    for (const file of [
        'architecture-scenes.js',
        'production-scenes.js',
        'production-labs.js',
        'architecture-labs.js',
        'durable-storage.js',
        'durable-lab.js',
        'protocols.js',
    ]) {
        vm.runInContext(fs.readFileSync('src/main/resources/static/' + file, 'utf8'), context);
    }
    return { root, find, timers, sceneData: vm.runInContext('globalThis.IMLabScenes', context) };
}
// 三、播放器回归：覆盖每个协议的全部场景、边界、重置与页面切换。
test('All protocol tabs and scenario steps render, can finish, reset and return to WebSocket', () => {
    const { find } = fixture();
    const tabs = find('lab-nav').children;
    assert.equal(tabs.length, 47);
    for (const tab of tabs) {
        tab.onclick();
        if (['overview', 'ws', 'http', 'encoding', 'frames', 'durable'].includes(tab.dataset.key)) {
            continue; // 特殊页面不是步骤播放器，后面分别验证。
        }
        const variantCount =
            find('protocol-panel').querySelectorAll('.variants')[0].children.length;
        for (let v = 0; v < variantCount; v++) {
            find('protocol-panel').querySelectorAll('.variants')[0].children[v].onclick();
            assert.ok(find('prev-scene').disabled);
            let stepCount = 0; // 限制最大步数，逻辑错误时及时失败，不无限循环。
            while (!find('next-scene').disabled) {
                find('next-scene').onclick();
                assert.ok(find('step-detail').textContent.includes('教学模拟'));
                assert.ok(++stepCount < 30);
            }
            assert.ok(stepCount >= 4);
            find('prev-scene').onclick();
            assert.equal(find('next-scene').disabled, false);
            find('reset-scene').onclick();
            assert.ok(find('prev-scene').disabled);
        }
    }
    tabs.find((t) => t.dataset.key === 'encoding').onclick();
    find('encode-text').value = '';
    find('encode-to').value = '';
    find('encode-text').oninput();
    assert.match(find('protocol-panel').textContent, /0 bytes/);
    tabs.find((t) => t.dataset.key === 'frames').onclick();
    find('frame-text').value = 'a'.repeat(126);
    find('frame-text').oninput();
    assert.match(find('protocol-panel').textContent, /134 字节/);
    tabs.find((t) => t.dataset.key === 'ws').onclick();
    assert.equal(find('websocket-panel').hidden, false);
    assert.equal(find('protocol-panel').hidden, true);
});
test('HTTP tab renders request and async response; stale response cannot overwrite another tab', async () => {
    const { find } = fixture();
    const tabs = find('lab-nav').children;
    const tab = (key) => tabs.find((t) => t.dataset.key === key).onclick();
    tab('http');
    let send = find('protocol-panel').querySelectorAll('button')[0];
    await send.onclick();
    assert.match(find('protocol-panel').textContent, /200/);
    assert.equal(send.disabled, false);
    tab('http');
    send = find('protocol-panel').querySelectorAll('button')[0];
    const pending = send.onclick();
    tab('overview');
    await pending;
    assert.match(find('protocol-panel').textContent, /同一条聊天消息/);
    assert.doesNotMatch(find('protocol-panel').textContent, /real-http/);
});

// 四、真实客户端的回调测试：模拟浏览器事件，不复制 Java 服务端的协议实现。

/** 提供与浏览器一致的连接状态常量，允许测试显式触发打开、接收和关闭事件。 */
class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
        this.url = url;
        this.readyState = MockWebSocket.CONNECTING; // 与浏览器构造器一致，初始尚未完成握手。
        this.sent = []; // 保存应用调用 send 的文本，供断言检查真实序列化结果。
    }

    open() {
        this.readyState = MockWebSocket.OPEN;
        this.onopen(); // 测试主动触发回调，明确区分连接成功和应用登录成功。
    }

    receive(data) {
        this.onmessage({ data: JSON.stringify(data) }); // 模拟服务端推送的应用文本。
    }

    send(text) {
        assert.equal(this.readyState, MockWebSocket.OPEN);
        this.sent.push(text);
    }

    close(code = 1000, reason = '') {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose({ code, reason, wasClean: true });
    }
}

/** 创建实际页面模板和客户端代码的隔离环境，保留可检查的客户端状态。 */
function appFixture() {
    const root = new Element();
    root.innerHTML = fs.readFileSync('src/main/resources/static/index.html', 'utf8');
    const find = (id) => {
        let found;
        const visit = (element) => {
            if (element.id === id) {
                found = element;
            }
            element.children.forEach(visit);
        };
        visit(root);
        return found;
    };
    find('filter').value = 'all'; // 对应 HTML select 的默认选项。

    const context = vm.createContext({
        console,
        document: {
            getElementById: find,
            createElement: (tag) => new Element(tag),
            createTextNode: (text) => Object.assign(new Element('text'), { textContent: text }),
            querySelectorAll: (selector) => root.querySelectorAll(selector),
            addEventListener() {},
        },
        WebSocket: MockWebSocket,
        location: { protocol: 'http:', host: 'localhost:8080' },
        crypto: globalThis.crypto,
        TextEncoder,
        performance,
        AbortSignal,
        setInterval,
        clearInterval,
        setTimeout: () => 1, // 本测试不推进提示关闭任务，避免等待 3.5 秒；也不运行一键演示。
        clearTimeout() {},
    });
    vm.runInContext(fs.readFileSync('src/main/resources/static/app.js', 'utf8'), context);
    const clients = vm.runInContext('clients', context); // 读取实际代码创建的对象，而非重建测试副本。
    return { root, find, context, clients };
}

test('WebSocket client separates open and login, serializes requests, records and filters events', () => {
    const { find, clients } = appFixture();
    const alice = clients[0];
    assert.equal(find('sendalice').disabled, true);
    find('connectalice').onclick();
    assert.equal(alice.ws.url, 'ws://localhost:8080/ws/im');
    assert.equal(find('loginalice').disabled, true); // 正在握手时不能发送 LOGIN。
    alice.ws.open();
    assert.equal(find('loginalice').disabled, false);
    assert.equal(find('sendalice').disabled, true); // 连接打开仍不等于登录成功。

    find('loginalice').onclick();
    const login = JSON.parse(alice.ws.sent[0]);
    assert.equal(login.type, 'LOGIN');
    assert.equal(login.payload.userId, 'alice');
    assert.ok(login.id);
    alice.ws.receive({ type: 'LOGIN_OK', id: 'server-1', refId: login.id, userId: 'alice' });
    assert.equal(find('sendalice').disabled, false);

    find('textalice').value = '你好 <b>Bob</b>';
    find('sendalice').onclick();
    const chat = JSON.parse(alice.ws.sent[1]);
    assert.equal(chat.type, 'CHAT');
    assert.equal(chat.to, 'bob');
    assert.equal(chat.payload.text, '你好 <b>Bob</b>');
    assert.notEqual(chat.id, login.id);

    find('search').value = 'CHAT';
    find('search').oninput();
    assert.equal(find('logs').children.length, 1);
    assert.match(find('logs').textContent, /CHAT/);
    find('filter').value = 'IN';
    find('filter').onchange();
    assert.match(find('logs').textContent, /没有匹配/);

    alice.ws.close(1000, '用户主动断开');
    assert.equal(alice.logged, false);
    assert.equal(find('sendalice').disabled, true);
    assert.equal(find('connectalice').disabled, false);
    find('clear').onclick();
    assert.equal(find('count').textContent, '0 条事件');
});

test('Received chat stays plain text, explicit read sends the message ID, invalid raw JSON is rejected', () => {
    const { find, clients } = appFixture();
    const bob = clients[1];
    find('connectbob').onclick();
    bob.ws.open();
    bob.ws.receive({ type: 'LOGIN_OK', userId: 'bob' });
    bob.ws.receive({
        type: 'MESSAGE',
        messageId: 'm-101',
        from: 'alice',
        payload: { text: '<script>学习文本</script>' },
    });
    assert.equal(bob.ws.sent.length, 0); // 收到 MESSAGE 不自动确认已读。
    const bubble = find('chatbob').children[0];
    assert.match(bubble.textContent, /<script>学习文本<\/script>/);
    assert.equal(bubble.children[1].tag, 'text'); // 正文插入为文本节点，不解析为 script 标签。
    const readButton = bubble.children.at(-1);
    readButton.onclick();
    assert.equal(readButton.disabled, true);
    assert.deepEqual(JSON.parse(bob.ws.sent[0]).payload, { messageId: 'm-101' });

    for (const raw of ['not JSON', 'null', '[]', '42']) {
        find('rawbob').value = raw;
        find('rawsendbob').onclick();
    }
    assert.equal(bob.ws.sent.length, 1); // 非对象或非法 JSON 不应调用 WebSocket.send。
    assert.equal(find('toast').textContent, '请输入合法 JSON 对象');
    find('rawbob').value = '{"type":"PING","id":"manual-1"}';
    find('rawsendbob').onclick();
    assert.equal(JSON.parse(bob.ws.sent[1]).type, 'PING');
});

/** 验证定时器生命周期：暂停、切换和播放末尾都必须停止推进。 */
test('Playback pauses, resets, stops on tab switch and finishes without leftover timers', () => {
    const { find, timers } = fixture();
    const tabs = find('lab-nav').children;
    tabs.find((tab) => tab.dataset.key === 'tcp').onclick();
    find('play-scene').onclick();
    assert.equal(timers.size, 1);
    assert.match(find('play-scene').textContent, /暂停/);
    find('play-scene').onclick();
    assert.equal(timers.size, 0);
    find('play-scene').onclick();
    tabs.find((tab) => tab.dataset.key === 'overview').onclick();
    assert.equal(timers.size, 0); // 切换之后不遗留对旧序列图的更新。

    tabs.find((tab) => tab.dataset.key === 'tcp').onclick();
    find('play-scene').onclick();
    let tickCount = 0;
    while (timers.size > 0) {
        const tick = timers.values().next().value;
        tick(); // 主动推进模拟时钟，不真正等待 1.3 秒。
        assert.ok(++tickCount < 30);
    }
    assert.equal(find('next-scene').disabled, true);
    assert.match(find('play-scene').textContent, /自动播放/);
    find('reset-scene').onclick();
    assert.equal(find('prev-scene').disabled, true);
});

/** 按 index.html 的真实 script 顺序执行全部浏览器脚本，检查拆分后的全局依赖。 */
test('All browser scripts load in HTML order, share DOM helpers and support keyboard navigation', () => {
    const { find, context } = appFixture(); // app.js 已在 fixture 中执行。
    const html = fs.readFileSync('src/main/resources/static/index.html', 'utf8');
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(
        (match) => match[1],
    );
    assert.deepEqual(scripts, [
        'app.js',
        'codec.js',
        'protocol-scenes.js',
        'business-scenes.js',
        'architecture-scenes.js',
        'production-scenes.js',
        'production-labs.js',
        'architecture-labs.js',
        'durable-storage.js',
        'durable-lab.js',
        'protocols.js',
    ]);
    for (const script of scripts.slice(1)) {
        vm.runInContext(fs.readFileSync('src/main/resources/static/' + script, 'utf8'), context);
    }
    const nav = find('lab-nav');
    assert.equal(nav.children.length, 47);
    assert.equal(find('websocket-panel').hidden, false);
    let prevented = false;
    nav.onkeydown({ key: 'ArrowRight', preventDefault: () => (prevented = true) });
    assert.equal(prevented, true);
    assert.equal(find('tab-tcp').attrs['aria-selected'], true);
    assert.equal(find('tab-tcp').focused, true);
    nav.onkeydown({ key: 'Home', preventDefault() {} });
    assert.equal(find('tab-overview').attrs['aria-selected'], true);
    assert.match(find('protocol-panel').textContent, /同一条聊天消息/);
});

// 五、进阶业务可视化：检查参与方、状态、学习地图与知识交互。
test('Business scene metadata has valid endpoints, states, lifecycle evidence and quiz answers', () => {
    const { sceneData } = fixture();
    const expectedTopics = [
        'authentication',
        'lifecycle',
        'persistence',
        'synchronization',
        'multidevice',
        'groups',
        'messageEvents',
        'evolution',
        'mobilePush',
        'endToEnd',
    ];
    for (const key of expectedTopics) {
        const scene = sceneData[key];
        assert.ok(scene, key + ' 未定义');
        assert.ok(scene.description.includes('模拟'));
        assert.ok(scene.takeaway);
        assert.ok(scene.quiz.options.length >= 2);
        assert.ok(
            scene.quiz.answerIndex >= 0 && scene.quiz.answerIndex < scene.quiz.options.length,
        );
        for (const variant of Object.values(scene.variants)) {
            assert.ok(variant.steps.length >= 4);
            for (const step of variant.steps) {
                assert.ok(step.from >= 0 && step.from < scene.actors.length);
                assert.ok(step.to >= 0 && step.to < scene.actors.length);
                assert.equal(step.state.length, scene.actors.length, key + ' 参与方状态数不一致');
                assert.ok(step.raw && step.note);
                if (scene.messageStages) {
                    assert.ok(
                        step.messageStage >= 0 && step.messageStage < scene.messageStages.length,
                    );
                }
            }
        }
    }
});

test('Learning map links to all business topics and quizzes give correct and incorrect feedback', () => {
    const { find, sceneData } = fixture();
    const nav = find('lab-nav');
    nav.children.find((tab) => tab.dataset.key === 'overview').onclick();
    const cards = find('protocol-panel').querySelectorAll('.learning-card');
    const topics = Object.entries(sceneData).filter(([, scene]) => scene.takeaway);
    assert.equal(cards.length, 34);
    cards[0].onclick();
    assert.match(find('protocol-panel').textContent, /连接已建立，凭什么相信/);
    for (const [key, scene] of topics) {
        nav.children.find((tab) => tab.dataset.key === key).onclick();
        const choices = find('protocol-panel').querySelectorAll('.quiz-option');
        assert.equal(choices.length, scene.quiz.options.length);
        choices[(scene.quiz.answerIndex + 1) % choices.length].onclick();
        assert.match(
            find('protocol-panel').querySelectorAll('.quiz-feedback')[0].textContent,
            /再想一想/,
        );
        choices[scene.quiz.answerIndex].onclick();
        assert.match(
            find('protocol-panel').querySelectorAll('.quiz-feedback')[0].textContent,
            /回答正确/,
        );
    }
});

test('Lifecycle rail never upgrades accepted to read and resets when changing fault scenarios', () => {
    const { find } = fixture();
    find('lab-nav')
        .children.find((tab) => tab.dataset.key === 'lifecycle')
        .onclick();
    const completedLabels = () =>
        find('sequence')
            .querySelectorAll('.lifecycle-stage')
            .filter((item) => item.className.split(' ').includes('completed'))
            .map((item) => item.children[1].textContent);
    assert.deepEqual(completedLabels(), []);
    find('next-scene').onclick();
    assert.deepEqual(completedLabels(), ['发送中']);
    find('next-scene').onclick();
    assert.deepEqual(completedLabels(), ['发送中', '已接受']);
    while (!find('next-scene').disabled) {
        find('next-scene').onclick();
    }
    assert.deepEqual(completedLabels(), ['发送中', '已接受', '已保存', '已送达', '已读']);
    find('protocol-panel').querySelectorAll('.variants')[0].children[1].onclick();
    assert.deepEqual(completedLabels(), []);
    while (!find('next-scene').disabled) {
        find('next-scene').onclick();
    }
    assert.deepEqual(completedLabels(), ['发送中', '已接受', '已保存']); // 结果确认不证明已送达或已读。
});

// 架构层验证：检查新数据结构、模型单位和交互，不将教学数据当成真实部署。
test('Architecture topics have complete scenarios, consistent states and valid quizzes', () => {
    const { sceneData } = fixture();
    const architecture = Object.values(sceneData).filter(
        (scene) => scene.category === 'architecture',
    );
    assert.equal(architecture.length, 16);
    let variants = 0;
    let steps = 0;
    for (const scene of architecture) {
        assert.match(scene.description, /模拟/);
        assert.ok(scene.takeaway);
        assert.ok(scene.quiz.answerIndex < scene.quiz.options.length);
        for (const variant of Object.values(scene.variants)) {
            variants++;
            for (const step of variant.steps) {
                steps++;
                assert.ok(step.from >= 0 && step.from < scene.actors.length);
                assert.ok(step.to >= 0 && step.to < scene.actors.length);
                assert.equal(step.state.length, scene.actors.length);
                assert.ok(step.raw && step.note);
            }
        }
    }
    assert.equal(variants, 37);
    assert.equal(steps, 158);
});

test('Fanout calculator updates row counts, zero load and invalid input', () => {
    const { find } = fixture();
    find('tab-fanout').onclick();
    assert.match(find('calculator-output').textContent, /10,010 行写入/);
    const messages = find('model-messages');
    messages.value = '0';
    messages.oninput();
    assert.match(find('calculator-output').textContent, /写扩散：0 行写入/);
    messages.value = '';
    messages.oninput();
    assert.match(find('calculator-output').textContent, /必须在/);
    messages.value = '20';
    messages.oninput();
    assert.match(find('calculator-output').textContent, /20,020 行写入/);
});

test('Capacity model identifies bandwidth bottleneck, drain and overload boundaries', () => {
    const context = vm.createContext({});
    vm.runInContext(
        fs.readFileSync('src/main/resources/static/architecture-labs.js', 'utf8'),
        context,
    );
    const model = context.IMLabArchitecture;
    const values = Object.fromEntries(
        model.capacityInputs.map(([key, , initial]) => [key, initial]),
    );
    const result = model.capacity(values);
    assert.equal(result.limit, 8544.921875);
    assert.equal(result.bottlenecks[0], '出口带宽');
    assert.equal(result.connections, 84000);
    assert.equal(result.requiredCells, 4);
    assert.ok(Math.abs(result.remainingConnections - 63000) < 1e-8);
    assert.ok(Math.abs(result.drain - 100000 / 544.921875) < 1e-9);
    values.arrival = result.limit;
    assert.equal(model.capacity(values).drain, null);
    values.arrival += 100;
    assert.equal(model.capacity(values).growth, 100);
    values.backlog = 0;
    assert.equal(model.capacity(values).drain, 0);
    values.hotspot = 10;
    assert.throws(() => model.capacity(values), /不能低于平均/);
    const { find } = fixture();
    find('tab-capacity').onclick();
    assert.match(find('calculator-output').textContent, /当前瓶颈：出口带宽/);
    find('model-arrival').value = '10000';
    find('model-arrival').oninput();
    assert.match(find('calculator-output').textContent, /无法清空/);
});

test('Chapter filters and search keep keyboard navigation within visible topics', () => {
    const { find } = fixture();
    const search = find('topic-search');
    const filters = find('topic-filters');
    filters.children[3].onclick();
    assert.equal(find('topic-filter-count').textContent, '16 个主题');
    search.value = '朋友圈';
    search.oninput();
    assert.equal(find('topic-filter-count').textContent, '1 个主题');
    find('lab-nav').onkeydown({ key: 'Home', preventDefault() {} });
    assert.equal(find('tab-moments').attrs['aria-selected'], true);
    search.value = '无匹配主题';
    search.oninput();
    assert.doesNotThrow(() => find('lab-nav').onkeydown({ key: 'Home', preventDefault() {} }));
    search.value = '';
    filters.children[0].onclick();
    assert.equal(find('topic-filter-count').textContent, '47 个主题');
});

// 生产链路：故障验证围绕最终事实和副作用，不能只断言 UI 文案。
function transactionModel() {
    const context = vm.createContext({});
    vm.runInContext(
        fs.readFileSync('src/main/resources/static/production-labs.js', 'utf8'),
        context,
    );
    return context.IMLabProduction;
}

test('Every production scenario has valid actor states and the chapter is searchable', () => {
    const { find, sceneData } = fixture();
    const topics = Object.values(sceneData).filter((scene) => scene.category === 'production');
    assert.equal(topics.length, 8);
    let count = 0;
    for (const scene of topics) {
        for (const variant of Object.values(scene.variants)) {
            for (const step of variant.steps) {
                count++;
                assert.equal(step.state.length, scene.actors.length);
                assert.ok(step.from >= 0 && step.from < scene.actors.length);
                assert.ok(step.to >= 0 && step.to < scene.actors.length);
                assert.ok(step.note && step.raw);
            }
        }
    }
    assert.equal(count, 80);
    find('topic-filters').children[4].onclick();
    assert.equal(find('topic-filter-count').textContent, '9 个主题');
    find('topic-search').value = 'Webhook';
    find('topic-search').oninput();
    assert.equal(find('topic-filter-count').textContent, '1 个主题');
});

test('Outbox recovers the commit/publish gap while the direct-write control loses delivery', () => {
    const model = transactionModel();
    for (const strategy of ['outbox', 'direct']) {
        let state = model.initial(strategy, 'afterCommit');
        const original = state;
        state = model.transition(state, 'send');
        assert.equal(original.message, false); // 转换不能原地破坏旧快照。
        assert.equal(state.message, true);
        assert.equal(state.clientAck, false);
        assert.equal(state.online, false);
        state = model.transition(state, 'relay');
        assert.equal(state.queued, 0); // 崩溃时按钮不能继续推进处理。
        for (const action of ['restart', 'send', 'relay', 'consume'])
            state = model.transition(state, action);
        assert.equal(state.clientAck, true);
        assert.equal(state.inbox, strategy === 'outbox' ? 1 : 0);
        assert.equal(state.outbox, strategy === 'outbox');
    }
});

test('Each transaction failure recovers to one logical message and one inbox side effect', () => {
    const model = transactionModel();
    for (const fault of [
        'none',
        'beforeCommit',
        'afterCommit',
        'ackLost',
        'relayCheckpoint',
        'consumerBeforeCommit',
        'consumerAck',
    ]) {
        let state = model.initial('outbox', fault);
        // 持续重试原请求和待确认事件，覆盖故障发生在发送、中继或消费的差异。
        for (let cycle = 0; cycle < 4; cycle++) {
            for (const action of ['restart', 'send', 'relay', 'consume'])
                state = model.transition(state, action);
        }
        while (state.queued > 0) state = model.transition(state, 'consume');
        assert.equal(state.message, true, fault);
        assert.equal(state.clientAck, true, fault);
        assert.equal(state.outbox, true, fault);
        assert.equal(state.relayCheckpoint, true, fault);
        assert.equal(state.inbox, 1, fault);
        assert.equal(state.consumed, true, fault);
        assert.equal(state.faultUsed, fault !== 'none', fault);
        if (fault === 'relayCheckpoint') assert.equal(state.publishes, 2);
    }
});

test('Fault experiment selectors reset, buttons recover and replay does not duplicate inbox', () => {
    const { find } = fixture();
    find('tab-outbox').onclick();
    const fault = find('transaction-fault');
    fault.value = 'relayCheckpoint';
    fault.onchange();
    find('transaction-send').onclick();
    find('transaction-relay').onclick();
    assert.match(find('transaction-output').textContent, /进程：崩溃/);
    find('transaction-restart').onclick();
    find('transaction-relay').onclick();
    find('transaction-consume').onclick();
    find('transaction-consume').onclick();
    assert.match(find('transaction-output').textContent, /发布次数：2/);
    assert.match(find('transaction-output').textContent, /收件箱引用：1/);
    const strategy = find('transaction-strategy');
    strategy.value = 'direct';
    strategy.onchange();
    fault.value = 'afterCommit';
    fault.onchange();
    find('transaction-send').onclick();
    assert.match(find('transaction-output').textContent, /发现分发缺口/);
    find('transaction-reset').onclick();
    assert.match(find('transaction-output').textContent, /正文：0/);
});

/** IndexedDB 事务替身：请求异步执行，只有整笔事务完成才更新持久映射。 */
class TransactionDatabase {
    constructor() {
        this.data = Object.fromEntries(
            ['messages', 'requests', 'cursors'].map((name) => [name, new Map()]),
        );
        this.failPutKey = null;
        this.closeCount = 0;
    }
    close() {
        this.closeCount++;
    }
    transaction(names, mode) {
        const copies = Object.fromEntries(
            names.map((name) => [
                name,
                new Map([...this.data[name]].map(([key, value]) => [key, structuredClone(value)])),
            ]),
        );
        let pending = 0;
        let aborted = false;
        const tx = {
            abort: () => {
                if (aborted) return;
                aborted = true;
                queueMicrotask(() => tx.onabort?.());
            },
            objectStore: (name) => {
                const request = (work) => {
                    pending++;
                    const result = {};
                    queueMicrotask(() => {
                        if (aborted) return;
                        try {
                            result.result = work();
                            result.onsuccess?.();
                        } catch (error) {
                            tx.error = error;
                            tx.abort();
                        }
                        pending--;
                        if (!pending)
                            queueMicrotask(() => {
                                if (aborted) return;
                                if (mode === 'readwrite')
                                    for (const table of names) this.data[table] = copies[table];
                                tx.oncomplete?.();
                            });
                    });
                    return result;
                };
                return {
                    get: (key) => request(() => copies[name].get(key)),
                    getAll: () => request(() => [...copies[name].values()]),
                    put: (value) =>
                        request(() => {
                            if (value.key === this.failPutKey)
                                throw new Error('injected local disk failure');
                            copies[name].set(value.key, structuredClone(value));
                        }),
                    delete: (key) => request(() => copies[name].delete(key)),
                };
            },
        };
        return tx;
    }
}

function durableStorageFixture() {
    const context = vm.createContext({});
    vm.runInContext(
        fs.readFileSync('src/main/resources/static/durable-storage.js', 'utf8'),
        context,
    );
    return { storage: context.IMLabDurableStorage, database: new TransactionDatabase() };
}

test('Durable local transaction rolls back messages and cursor together, isolates accounts and deduplicates', async () => {
    const { storage, database } = durableStorageFixture();
    const message = {
        messageId: 'm1',
        from: 'alice',
        to: 'bob',
        text: 'hello',
        seq: 1,
        readAt: null,
    };
    await storage.apply(database, 'bob', [message], 'v1.bob.1');
    database.failPutKey = 'bob|m3';
    await assert.rejects(
        storage.apply(
            database,
            'bob',
            [
                { ...message, messageId: 'm2', seq: 2 },
                { ...message, messageId: 'm3', seq: 3 },
            ],
            'v1.bob.3',
        ),
        /local disk failure/,
    );
    let local = await storage.state(database, 'bob');
    assert.equal(local.messages.length, 1);
    assert.equal(local.cursor, 'v1.bob.1');
    database.failPutKey = null;
    await storage.markRead(database, 'bob', 'm1', 123);
    await storage.apply(database, 'bob', [message]); // 旧实时提示既不能清空已读，也不能推进游标。
    local = await storage.state(database, 'bob');
    assert.equal(local.messages.length, 1);
    assert.equal(local.messages[0].readAt, 123);
    assert.equal(local.cursor, 'v1.bob.1');
    assert.equal((await storage.state(database, 'alice')).messages.length, 0);
    await storage.saveRequest(database, 'bob', {
        requestKey: 'key-1',
        to: 'alice',
        text: 'pending',
    });
    await storage.resetInbox(database, 'bob');
    local = await storage.state(database, 'bob');
    assert.equal(local.cursor, '');
    assert.equal(local.messages.length, 0);
    assert.equal(local.requests[0].status, 'pending');
    await storage.acknowledge(database, 'bob', 'key-1', 'server-1');
    assert.equal((await storage.state(database, 'bob')).requests[0].messageId, 'server-1');
});

/** 等待 Promise 与事务请求完成；不用实际网络或长时间 sleep。 */
async function settleDurable() {
    for (let turn = 0; turn < 4; turn++) await new Promise((resolve) => setImmediate(resolve));
}

test('Durable page persists before sending, restores pending keys and never advances cursor from live hint', async () => {
    const { find, context } = appFixture();
    const sockets = [];
    context.WebSocket = class extends MockWebSocket {
        constructor(url) {
            super(url);
            sockets.push(this);
        }
    };
    const scripts = [
        ...fs
            .readFileSync('src/main/resources/static/index.html', 'utf8')
            .matchAll(/<script src="([^"]+)"><\/script>/g),
    ].map((match) => match[1]);
    for (const script of scripts.slice(1))
        vm.runInContext(fs.readFileSync('src/main/resources/static/' + script, 'utf8'), context);
    const database = new TransactionDatabase();
    context.IMLabDurableStorage.open = async () => database;
    find('tab-durable').onclick();
    await settleDurable();
    assert.equal(find('durable-alice-send').disabled, false);
    find('durable-alice-text').value = '<script>plain text</script>';
    await find('durable-alice-send').onclick();
    let local = await context.IMLabDurableStorage.state(database, 'durable_alice');
    const key = local.requests[0].requestKey;
    assert.equal(local.requests[0].status, 'pending');
    assert.equal(sockets.length, 0);
    await find('durable-alice-connect').onclick();
    const socket = sockets[0];
    assert.match(socket.url, /\/ws\/durable$/);
    socket.open();
    socket.receive({ type: 'LOGIN_OK', userId: 'durable_alice' });
    await settleDurable();
    const packets = socket.sent.map((raw) => JSON.parse(raw));
    const chat = packets.find((packet) => packet.type === 'CHAT');
    assert.equal(chat.requestKey, key);
    assert.equal(chat.payload.text, '<script>plain text</script>');
    socket.receive({ type: 'ACK', requestKey: key, messageId: 'outbound-1' });
    const initialSync = packets.find((packet) => packet.type === 'SYNC');
    socket.receive({
        type: 'SYNC_RESULT',
        refId: initialSync.id,
        messages: [],
        nextCursor: 'v1.durable_alice.0',
        hasMore: false,
    });
    await settleDurable();
    assert.equal(
        (await context.IMLabDurableStorage.state(database, 'durable_alice')).requests[0].status,
        'persisted',
    );
    const live = {
        messageId: 'm4',
        from: 'durable_bob',
        to: 'durable_alice',
        text: 'new hint',
        seq: 4,
    };
    socket.receive({ type: 'MESSAGE', message: live });
    await settleDurable();
    local = await context.IMLabDurableStorage.state(database, 'durable_alice');
    assert.equal(local.cursor, 'v1.durable_alice.0');
    const catchup = socket.sent
        .map((raw) => JSON.parse(raw))
        .filter((packet) => packet.type === 'SYNC')
        .at(-1);
    assert.equal(catchup.payload.cursor, 'v1.durable_alice.0');
    socket.receive({
        type: 'SYNC_RESULT',
        refId: catchup.id,
        messages: [{ ...live, messageId: 'm2', seq: 2, text: 'old offline' }, live],
        nextCursor: 'v1.durable_alice.4',
        hasMore: false,
    });
    await settleDurable();
    local = await context.IMLabDurableStorage.state(database, 'durable_alice');
    assert.equal(local.cursor, 'v1.durable_alice.4');
    assert.equal(local.messages.length, 2);
    assert.match(find('protocol-panel').textContent, /old offline/);
    // 本地批次写失败后释放同步槽，继续使用旧游标补拉，不能卡死或跳到失败批次。
    await find('durable-alice-sync').onclick();
    const failedSync = JSON.parse(socket.sent.at(-1));
    const nextMessage = { ...live, messageId: 'm6', seq: 6, text: 'disk retry' };
    database.failPutKey = 'durable_alice|m6';
    socket.receive({
        type: 'SYNC_RESULT',
        refId: failedSync.id,
        messages: [nextMessage],
        nextCursor: 'v1.durable_alice.6',
        hasMore: false,
    });
    await settleDurable();
    assert.equal(
        (await context.IMLabDurableStorage.state(database, 'durable_alice')).cursor,
        'v1.durable_alice.4',
    );
    database.failPutKey = null;
    await find('durable-alice-sync').onclick();
    const retriedSync = JSON.parse(socket.sent.at(-1));
    assert.equal(retriedSync.payload.cursor, 'v1.durable_alice.4');
    assert.notEqual(retriedSync.id, failedSync.id);
    socket.receive({
        type: 'SYNC_RESULT',
        refId: retriedSync.id,
        messages: [nextMessage],
        nextCursor: 'v1.durable_alice.6',
        hasMore: false,
    });
    await settleDurable();
    await find('durable-alice-retry').onclick();
    const retry = JSON.parse(socket.sent.at(-1));
    assert.equal(retry.requestKey, key);
    assert.notEqual(retry.id, chat.id);
    await find('durable-alice-disconnect').onclick();
    await settleDurable();
    await find('durable-alice-send').onclick();
    local = await context.IMLabDurableStorage.state(database, 'durable_alice');
    const pendingKey = local.requests.at(-1).requestKey;
    find('tab-ws').onclick();
    await settleDurable();
    find('tab-durable').onclick(); // 重建页面，不能靠旧客户端内存保存请求。
    await settleDurable();
    await find('durable-alice-connect').onclick();
    const recovered = sockets[1];
    recovered.open();
    recovered.receive({ type: 'LOGIN_OK', userId: 'durable_alice' });
    await settleDurable();
    const restoredChat = recovered.sent
        .map((raw) => JSON.parse(raw))
        .find((packet) => packet.type === 'CHAT');
    assert.equal(restoredChat.requestKey, pendingKey);
    assert.equal(
        recovered.sent.map((raw) => JSON.parse(raw)).find((packet) => packet.type === 'SYNC')
            .payload.cursor,
        'v1.durable_alice.6',
    );
    find('tab-ws').onclick();
    await settleDurable();
    assert.equal(recovered.readyState, MockWebSocket.CLOSED);
});
