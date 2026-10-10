/**
 * 协议实验的页面控制器。
 * 场景来自基础协议、业务、架构与 production-scenes.js 四类数据。
 * 编码来自 codec.js；架构模型来自 architecture-labs.js；故障实验来自 production-labs.js；$ 来自 app.js。
 * 阅读顺序：initializeNavigation → switchTab → renderScene → updateScene。
 * HTTP 与持久化实战页连接真实 Java 服务；其余协议场景由本地步骤播放器模拟。
 */
(() => {
    // 一、DOM 工具与播放器状态；立即执行函数让这些状态留在私有作用域。
    const PLAYBACK_INTERVAL_MS = 1300; // 自动播放每 1.3 秒前进一步，不代表协议真实耗时。
    const HTTP_TIMEOUT_MS = 8000; // 真实 HTTP 请求等待上限为 8 秒。
    const MAX_DISPLAYED_BYTES = 24; // 字节表只展示前 24 字节，避免页面过长。

    /** 创建纯文本元素；协议报文以 textContent 展示，不会作为 HTML 执行。 */
    function createElement(tagName, className, text) {
        const element = document.createElement(tagName);
        if (className) {
            element.className = className;
        }
        if (text !== undefined) {
            element.textContent = text;
        }
        return element;
    }

    const scenes = globalThis.IMLabScenes; // 从独立脚本取得教学场景。
    const special = {
        overview: { name: '协议全景', layer: '分层地图' },
        encoding: { name: 'JSON / Protobuf', layer: '编码' },
        frames: { name: 'WebSocket 帧', layer: '帧结构' },
        durable: { name: 'Java 持久化实战', layer: '真实数据库', category: 'production' },
    };

    let active = 'ws'; // 当前顶部标签的 key，初始保留真实 WebSocket 页面。
    let variant = null; // 当前协议下选择的实验场景 key，例如 MQTT 的 qos1。
    let position = -1; // -1 表示未开始，0 表示正在观察第一步。
    let timer = null; // 自动播放定时器；null 表示未播放。
    let requestGeneration = 0; // 页面代数；标签切换后用它拒绝过时的 HTTP 响应。

    const panel = $('protocol-panel'); // 新增协议实验共享的内容容器。
    const nav = $('lab-nav'); // 顶部协议导航。

    // 二、导航、页面切换与通用标题。

    /** 暂停自动播放，并同步更新按钮文字；不改变当前步骤位置。 */
    function stop() {
        clearInterval(timer);
        timer = null;
        const playButton = $('play-scene'); // 特殊页面没有播放按钮，因此要检查是否存在。
        if (playButton) {
            playButton.textContent = '▶ 自动播放';
        }
    }

    /** 切换顶部标签，先清理播放状态，再选择对应的页面渲染函数。 */
    function switchTab(key) {
        globalThis.IMLabDurable.dispose(); // 离开真实持久化页时关闭连接，本地与服务端数据继续保留。
        stop(); // 防止旧场景的定时器继续更新新页面。
        requestGeneration++; // 让旧 HTTP 请求的结果失效，即使它随后成功返回。
        active = key;

        nav.querySelectorAll('button').forEach((button) => {
            const isSelected = button.dataset.key === key;
            button.classList.toggle('active', isSelected);
            button.setAttribute('aria-selected', isSelected); // 向辅助技术报告选中状态。
            button.tabIndex = isSelected ? 0 : -1; // Tab 键只进入当前标签，方向键切换其他标签。
        });

        // 若当前页被章节过滤隐藏，为首个可见标签保留键盘入口。
        const chosenTab = Array.from(nav.children).find((button) => button.dataset.key === key);
        if (chosenTab?.hidden) {
            const firstVisible = Array.from(nav.children).find((button) => !button.hidden);
            if (firstVisible) firstVisible.tabIndex = 0;
        }
        $('websocket-panel').hidden = key !== 'ws';
        panel.hidden = key === 'ws';
        $('demo').hidden = key !== 'ws'; // 一键演示按钮只属于真实 WebSocket 实验。
        if (key === 'ws') {
            return; // 保留原有真实连接和报文记录，不重建 WebSocket 页面。
        }

        panel.setAttribute('aria-labelledby', 'tab-' + key);
        panel.replaceChildren(); // 清理旧实验 DOM；数据状态由后续渲染负责初始化。
        switch (key) {
            case 'overview':
                renderOverview();
                return;
            case 'encoding':
                renderEncoding();
                return;
            case 'frames':
                renderFrames();
                return;
            case 'durable':
                globalThis.IMLabDurable.render(panel);
                return;
            case 'http':
                renderHttp();
                return;
            default:
                variant = Object.keys(scenes[key].variants)[0]; // 普通协议默认选择第一个场景。
                position = -1;
                renderScene();
        }
    }

    /** 初始化导航顺序、无障碍属性，以及左右方向键 / Home / End 的切换行为。 */
    function initializeNavigation() {
        panel.setAttribute('role', 'tabpanel');
        $('websocket-panel').setAttribute('role', 'tabpanel');
        $('websocket-panel').setAttribute('aria-labelledby', 'tab-ws');
        nav.setAttribute('role', 'tablist');

        nav.onkeydown = (event) => {
            const tabs = Array.from(nav.children).filter((button) => !button.hidden);
            if (!tabs.length) return;
            const currentIndex = tabs.findIndex((button) => button.dataset.key === active);
            let nextIndex;

            switch (event.key) {
                case 'ArrowRight':
                    nextIndex = (currentIndex + 1) % tabs.length; // 从末尾循环回开头。
                    break;
                case 'ArrowLeft':
                    nextIndex =
                        currentIndex < 0
                            ? tabs.length - 1
                            : (currentIndex - 1 + tabs.length) % tabs.length;
                    break;
                case 'Home':
                    nextIndex = 0;
                    break;
                case 'End':
                    nextIndex = tabs.length - 1;
                    break;
                default:
                    return; // 不接管其他按键的浏览器行为。
            }

            event.preventDefault(); // 防止方向键同时滚动页面。
            tabs[nextIndex].onclick(); // 与鼠标点击使用同一切换逻辑。
            tabs[nextIndex].focus(); // 切换后把键盘焦点移到新标签。
        };

        const tabs = [
            ['overview', special.overview],
            ['ws', { name: 'WebSocket 实战', layer: '真实连接' }],
            ...Object.entries(scenes), // 展开 TCP、TLS、HTTP、XMPP 等普通协议定义。
            ['encoding', special.encoding],
            ['frames', special.frames],
            ['durable', special.durable],
        ];
        tabs.forEach(([key, item]) => {
            const button = createElement('button', 'lab-tab');
            button.dataset.key = key;
            button.id = 'tab-' + key;
            button.setAttribute('role', 'tab');
            button.setAttribute(
                'aria-controls',
                key === 'ws' ? 'websocket-panel' : 'protocol-panel',
            );
            button.append(
                createElement('small', '', item.layer),
                createElement('span', '', item.name),
            );
            button.onclick = () => switchTab(key);
            nav.append(button);
        });
        initializeTopicFilters();
    }

    /** 按学习层次或关键词过滤导航；过滤不会中断当前实验。 */
    function initializeTopicFilters() {
        const filters = $('topic-filters');
        const search = $('topic-search');
        if (!filters || !search) return;
        let category = 'all';
        const categories = [
            ['all', '全部'],
            ['foundation', '传输与编码'],
            ['business', '业务机制'],
            ['architecture', '规模化架构'],
            ['production', '生产链路'],
        ];
        const apply = () => {
            const query = search.value.trim().toLowerCase();
            let count = 0;
            for (const button of nav.children) {
                const scene = scenes[button.dataset.key] || special[button.dataset.key];
                const kind = scene?.category || (scene?.takeaway ? 'business' : 'foundation');
                button.hidden =
                    (category !== 'all' && kind !== category) ||
                    !button.textContent.toLowerCase().includes(query);
                if (!button.hidden) count++;
            }
            // 当前页可能被过滤隐藏；仍为首个可见标签保留 Tab 键入口。
            const visible = Array.from(nav.children).filter((button) => !button.hidden);
            const selected = visible.find((button) => button.dataset.key === active) || visible[0];
            for (const button of nav.children) button.tabIndex = button === selected ? 0 : -1;
            $('topic-filter-count').textContent = count + ' 个主题';
            for (const button of filters.children)
                button.setAttribute('aria-pressed', button.dataset.category === category);
        };
        for (const [key, label] of categories) {
            const button = createElement('button', '', label);
            button.dataset.category = key;
            button.onclick = () => {
                category = key;
                apply();
            };
            filters.append(button);
        }
        search.oninput = apply;
        apply();
    }

    /** 每种实验先显示标题、介绍和执行方式，明确真实请求与教学模拟的区别。 */
    function renderHeading(title, description, mode = '教学模拟') {
        const header = createElement('div', 'lab-heading');
        const body = createElement('div');
        body.append(
            createElement('div', 'eyebrow', 'PROTOCOL EXPLORER · ' + mode),
            createElement('h2', '', title),
            createElement('p', '', description),
        );
        header.append(body, createElement('span', 'mode-pill', mode));
        panel.append(header);
    }

    /** 有官方来源的实验附上规范链接；自定义可靠消息场景没有统一标准链接。 */
    function renderSourceLink(scene) {
        if (!scene.source) {
            return;
        }
        const link = createElement('a', 'source-link', scene.source[0] + ' ↗');
        link.href = scene.source[1];
        link.target = '_blank';
        link.rel = 'noopener noreferrer'; // 外部页面不通过 opener 控制当前实验页面。
        panel.append(link);
    }

    // 三、场景选择与播放控制。

    /** 通过当前协议 key 与场景 key，取得有顺序的步骤数组。 */
    function currentSteps() {
        return scenes[active].variants[variant].steps;
    }

    /** 构建场景页面的固定部分：场景选择、播放按钮、序列图和详情面板。 */
    function renderScene() {
        panel.replaceChildren();
        const scene = scenes[active];
        renderHeading(scene.title, scene.description);

        const toolbar = createElement('div', 'scene-controls');
        const variantButtons = createElement('div', 'variants');
        for (const [key, item] of Object.entries(scene.variants)) {
            const button = createElement('button', key === variant ? 'chosen' : '', item.name);
            button.onclick = () => {
                stop();
                variant = key;
                position = -1; // 切换场景时重新开始，不继承旧场景的步骤位置。
                renderScene();
            };
            variantButtons.append(button);
        }
        toolbar.append(variantButtons);

        const controls = createElement('div', 'playback');
        const actions = [
            ['prev-scene', '← 上一步', previousStep],
            ['next-scene', '下一步 →', nextStep],
            ['play-scene', '▶ 自动播放', togglePlayback],
            ['reset-scene', '重置', resetScene],
        ];
        actions.forEach(([id, label, handler]) => {
            const button = createElement('button', '', label);
            button.id = id;
            button.onclick = handler;
            controls.append(button);
        });
        toolbar.append(controls);
        panel.append(toolbar);

        const layout = createElement('div', 'scene-layout');
        const stage = createElement('div', 'sequence-stage');
        stage.id = 'sequence';
        const details = createElement('aside', 'step-detail');
        details.id = 'step-detail';
        layout.append(stage, details);
        panel.append(layout);
        if (scene.calculator === 'transaction') globalThis.IMLabProduction.render(panel);
        else if (scene.calculator) globalThis.IMLabArchitecture.render(panel, scene.calculator);
        renderLesson(scene); // 业务进阶场景附核心结论与可交互的理解检查。
        renderSourceLink(scene);
        updateScene(); // 固定容器创建后，渲染初始等待状态。
    }

    /** 手动回到上一步；最低位置为 -1，也就是尚未开始。 */
    function previousStep() {
        stop();
        position = Math.max(-1, position - 1);
        updateScene();
    }

    /** 手动前进前先暂停，避免一次点击和定时器同时推进。 */
    function nextStep() {
        stop();
        advance();
    }

    /** 在播放与暂停之间切换；已到末尾时从第一步重新播放。 */
    function togglePlayback() {
        if (timer !== null) {
            stop();
            return;
        }
        if (position === currentSteps().length - 1) {
            position = -1;
        }
        advance(); // 点击后立即显示下一步，不必等第一个定时周期。
        if (position < currentSteps().length - 1) {
            timer = setInterval(advance, PLAYBACK_INTERVAL_MS);
            $('play-scene').textContent = 'Ⅱ 暂停';
        }
    }

    /** 重置只影响教学播放器，不会断开真实 WebSocket 连接。 */
    function resetScene() {
        stop();
        position = -1;
        updateScene();
    }

    /** 推进一步，到达末尾后自动停止，避免访问越界步骤。 */
    function advance() {
        if (position < currentSteps().length - 1) {
            position++;
        }
        updateScene();
        if (position === currentSteps().length - 1) {
            stop();
        }
    }

    // 四、当前步骤的可视化；把参与方、报文行和详情拆成独立函数。

    /** 根据 position 刷新序列图、端点状态、播放边界和右侧解释。 */
    function updateScene() {
        const scene = scenes[active];
        const steps = currentSteps();
        const stage = $('sequence');
        stage.replaceChildren();

        const progressText =
            position < 0
                ? '尚未开始 · 点击下一步或自动播放'
                : `${position + 1} / ${steps.length} · ${steps[position].title}`;
        const progress = createElement('div', 'scene-progress', progressText);
        progress.setAttribute('aria-live', 'polite'); // 让辅助技术感知步骤更新。
        stage.append(progress);
        renderMessageStages(stage, scene, steps); // 生命周期主题额外显示不同确认阶段。
        renderActorStates(stage, scene, steps);
        renderSequenceRows(stage, scene, steps);

        $('prev-scene').disabled = position < 0;
        $('next-scene').disabled = position === steps.length - 1;
        renderStepDetail(scene, steps);
    }

    /** 只有生命周期主题定义 messageStages；其他场景继续使用通用序列图。 */
    function renderMessageStages(stage, scene, steps) {
        if (!scene.messageStages) {
            return;
        }
        const currentStage = position < 0 ? -1 : steps[position].messageStage;
        const track = createElement('div', 'lifecycle-track');
        track.setAttribute('aria-label', '发送者观察到的消息生命周期');
        scene.messageStages.forEach((label, index) => {
            const completed = index <= currentStage;
            const current = index === currentStage;
            const item = createElement(
                'div',
                'lifecycle-stage' + (completed ? ' completed' : '') + (current ? ' current' : ''),
            );
            item.append(
                createElement('span', '', completed ? '✓' : String(index + 1)),
                createElement('b', '', label),
            );
            if (current) {
                item.setAttribute('aria-current', 'step');
            }
            track.append(item);
        });
        stage.append(track);
    }

    /** 结论与小测是本地学习交互，不发送答案，也不影响真实聊天。 */
    function renderLesson(scene) {
        if (!scene.takeaway) {
            return;
        }
        const lesson = createElement('section', 'business-lesson');
        const conclusion = createElement('div', 'lesson-conclusion');
        conclusion.append(
            createElement('div', 'eyebrow', 'KEY IDEA · 本节要点'),
            createElement('p', '', scene.takeaway),
        );
        lesson.append(conclusion);

        if (scene.quiz) {
            const quiz = scene.quiz;
            const exercise = createElement('div', 'lesson-exercise');
            exercise.append(createElement('h3', '', '理解检查：' + quiz.question));
            const choices = createElement('div', 'quiz-options');
            const feedback = createElement('p', 'quiz-feedback', '选择一个答案，查看解释。');
            feedback.setAttribute('aria-live', 'polite');
            quiz.options.forEach((label, index) => {
                const button = createElement('button', 'quiz-option', label);
                button.setAttribute('aria-pressed', 'false');
                button.onclick = () => {
                    const isCorrect = index === quiz.answerIndex;
                    choices.querySelectorAll('button').forEach((choice) => {
                        choice.classList.toggle('chosen', choice === button);
                        choice.setAttribute('aria-pressed', choice === button);
                    });
                    feedback.className = 'quiz-feedback ' + (isCorrect ? 'correct' : 'incorrect');
                    feedback.textContent =
                        (isCorrect ? '✓ 回答正确。' : '再想一想。') + quiz.explanation;
                };
                choices.append(button);
            });
            exercise.append(choices, feedback);
            lesson.append(exercise);
        }
        panel.append(lesson);
    }

    /** actors 与每步的 state 使用相同下标，分别描述参与方名称和当前状态。 */
    function renderActorStates(stage, scene, steps) {
        const actors = createElement('div', 'actor-grid');
        actors.style.setProperty('--actors', scene.actors.length); // CSS 按参与方数量分列。
        scene.actors.forEach((actorName, index) => {
            const actor = createElement('div', 'actor');
            const state = position < 0 ? '等待实验' : steps[position].state[index];
            actor.append(
                createElement('span', 'actor-icon', String(index + 1)),
                createElement('b', '', actorName),
                createElement('small', '', state),
            );
            actors.append(actor);
        });
        stage.append(actors);
    }

    /** 已经过的步骤可点击回看，尚未播放的步骤保持禁用。 */
    function renderSequenceRows(stage, scene, steps) {
        steps.forEach((step, index) => {
            const rowClass =
                'sequence-row' +
                (index <= position ? ' revealed' : '') +
                (index === position ? ' current' : '');
            const row = createElement('button', rowClass);
            row.style.setProperty('--actors', scene.actors.length);
            row.disabled = index > position;
            row.setAttribute(
                'aria-label',
                `${index + 1}. ${scene.actors[step.from]} 到 ${scene.actors[step.to]}：${step.title}`,
            );
            row.append(createElement('span', 'step-number', String(index + 1).padStart(2, '0')));

            const isSelfOperation = step.from === step.to; // 同一下标表示端点内计算，不是网络消息。
            const arrowClass =
                'sequence-arrow' +
                (step.from > step.to ? ' reverse' : '') +
                (isSelfOperation ? ' self' : '');
            const arrow = createElement(
                'span',
                arrowClass,
                isSelfOperation ? '↻ ' + step.title : step.title,
            );
            const firstActor = Math.min(step.from, step.to);
            const lastActor = Math.max(step.from, step.to);
            arrow.style.gridColumn = `${firstActor + 2} / ${lastActor + 3}`; // 第一列留给步骤号，后续列对应参与方。
            row.append(arrow);
            row.onclick = () => {
                stop();
                position = index;
                updateScene();
            };
            stage.append(row);
        });
    }

    /** 展示当前步骤的原始报文、说明和字段解释，持续标注教学模拟身份。 */
    function renderStepDetail(scene, steps) {
        const detail = $('step-detail');
        detail.replaceChildren();
        if (position < 0) {
            detail.append(
                createElement('div', 'empty', '选择场景，逐步观察报文'),
                createElement(
                    'p',
                    'detail-note',
                    '每次前进一步，左侧显示传递方向与端点状态，右侧拆解当前报文。',
                ),
            );
            return;
        }

        const step = steps[position];
        detail.append(
            createElement(
                'div',
                'eyebrow',
                `${scene.actors[step.from]} → ${scene.actors[step.to]}`,
            ),
            createElement('h3', '', step.title),
            createElement('pre', 'json', step.raw), // pre 保留报文中的换行和空格。
            createElement('p', 'detail-note', step.note),
        );
        step.fields.forEach(([fieldName, description]) => {
            const field = createElement('div', 'field');
            field.append(createElement('b', '', fieldName), document.createTextNode(description));
            detail.append(field);
        });
        detail.append(
            createElement(
                'div',
                'simulation-note',
                '此处为教学模拟 / 报文示意，不是实际网络捕获。',
            ),
        );
    }

    /** 从场景元数据生成进阶学习地图，避免顶部入口较多时找不到新增主题。 */
    function renderLearningMap() {
        const topics = Object.entries(scenes).filter(([, scene]) => scene.takeaway);
        const section = createElement('section', 'learning-map');
        const title = createElement('div', 'section-title');
        title.append(
            createElement('h2', '', 'IM 学习地图'),
            createElement('span', '', topics.length + ' 个主题 / 点击进入实验'),
        );
        section.append(title);
        const path = createElement(
            'p',
            'learning-path',
            '建议路线：协议基础 → 业务可靠性 → 读写扩散 → 朋友圈 → 单元化与分片 → 容量、容灾和可观测性 → 生产链路与故障验收',
        );
        section.append(path);
        const realLab = createElement(
            'button',
            'durable-entry',
            '进入 Java 持久化实战 → 真实事务、离线同步、幂等重试与故障恢复',
        );
        realLab.onclick = () => switchTab('durable');
        section.append(realLab);
        // 按学习层次组织卡片，避免所有进阶主题挤在同一张大网格中。
        const chapters = [
            ['business', '01 · 业务机制'],
            ['architecture', '02 · 规模化架构'],
            ['production', '03 · 生产链路'],
        ];
        let number = 0;
        for (const [category, label] of chapters) {
            const entries = topics.filter(
                ([, scene]) => (scene.category || 'business') === category,
            );
            section.append(
                createElement('h3', 'learning-chapter', label + ' / ' + entries.length + ' 个主题'),
            );
            const grid = createElement('div', 'learning-grid');
            for (const [key, scene] of entries) {
                const card = createElement('button', 'learning-card');
                card.append(
                    createElement(
                        'span',
                        'eyebrow',
                        String(++number).padStart(2, '0') + ' / ' + scene.layer,
                    ),
                    createElement('h3', '', scene.name),
                    createElement('p', '', scene.title),
                    createElement(
                        'small',
                        '',
                        Object.keys(scene.variants).length + ' 个场景 · 教学模拟 →',
                    ),
                );
                card.onclick = () => switchTab(key);
                grid.append(card);
            }
            section.append(grid);
        }
        panel.append(section);
    }

    // 五、特殊实验页面：分层总览、真实编码和真实 HTTP。

    /** 渲染协议分层图与方案对照；每一层都是跳转到对应实验的按钮。 */
    function renderOverview() {
        renderHeading(
            '同一条聊天消息，经过哪些层？',
            '协议、编码和业务可靠性承担不同职责。点击任意层进入对应实验，比较各方案的搭配方式。',
            '交互知识地图',
        );
        renderLearningMap();
        const layout = createElement('div', 'overview-layout');
        const stack = createElement('div', 'protocol-stack');
        const layers = [
            [
                'reliability',
                '业务机制',
                '登录 · ACK · 已读 · 去重 · 离线同步',
                '学习业务结果的确认与恢复机制',
            ],
            [
                'stomp',
                '消息协议',
                '自定义 IM / XMPP / MQTT / STOMP',
                '定义消息类型和交互规则，通常选择适合的一套',
            ],
            [
                'encoding',
                '数据编码',
                'JSON / XML / Protobuf',
                '把字段转换成文本或二进制；编码格式本身不定义交互',
            ],
            ['ws', '连接通道', 'WebSocket / 原生 TCP', '浏览器使用 WebSocket；原生客户端可用 TCP'],
            ['tls', '安全保护', 'TLS → HTTPS / WSS', '加密内容、验证对端身份'],
            ['tcp', '底层传输', 'TCP → IP', '可靠有序的字节流，无法证明业务已读'],
        ];
        layers.forEach(([key, label, value, note], i) => {
            const b = createElement('button', 'stack-layer');
            b.append(
                createElement('span', 'stack-index', String(i + 1).padStart(2, '0')),
                createElement('b', '', label),
                createElement('span', '', value),
                createElement('small', '', note),
            );
            b.onclick = () => switchTab(key);
            stack.append(b);
        });
        const side = createElement('aside', 'overview-side');
        side.append(createElement('h3', '', '三个搭配示例'));
        [
            ['网页聊天', '自定义 IM JSON → WebSocket → TLS → TCP'],
            ['发布 / 订阅', '业务消息 → MQTT → TLS → TCP\n也可以使用 MQTT over WebSocket'],
            [
                '音视频通话',
                'WebSocket / HTTPS 承载呼叫信令\nICE / STUN / TURN 建立路径\nDTLS-SRTP 保护媒体',
            ],
        ].forEach(([name, text]) => {
            const box = createElement('div', 'combo-card');
            box.append(createElement('b', '', name), createElement('p', '', text));
            side.append(box);
        });
        side.append(
            createElement(
                'p',
                'detail-note',
                '层次为学习用简化图。WebSocket 自身也是应用层协议；音视频的 UDP 媒体路径不经过这里的 TCP 链路。',
            ),
        );
        layout.append(stack, side);
        panel.append(layout);
        const table = createElement('table', 'comparison');
        // innerHTML 只放固定表头，任何协议内容仍使用纯文本 DOM。
        table.innerHTML = '<thead><tr><th>实验</th><th>核心问题</th><th>执行方式</th></tr></thead>';
        const body = createElement('tbody');
        [
            ['WebSocket', '消息如何双向收发？', '真实 Java 服务'],
            ['HTTP', '请求与响应长什么样？', '真实 Java API'],
            ['TCP / TLS', '连接、字节流和安全如何工作？', '教学模拟'],
            ['XMPP / MQTT / STOMP', '标准消息协议如何交互？', '教学模拟'],
            ['WebRTC', '信令、直连、中继如何配合？', '教学模拟'],
            ['JSON / Protobuf / 帧', '字段如何变成网络字节？', '本地真实编码'],
            ['可靠消息', '丢失、重复、离线怎么处理？', '状态机模拟'],
            ['身份 / 生命周期 / 持久化', '可信身份、分级确认与崩溃恢复', '教学模拟'],
            ['同步 / 多设备 / 群聊', '增量、成员权限与多个终端的一致性', '教学模拟'],
            ['消息事件 / 协议演进', '内容结构、修改、版本与错误语义', '教学模拟'],
            ['移动推送 / 端到端加密', '通知链路与正文信任边界', '教学模拟'],
        ].forEach((cells) => {
            const tr = createElement('tr');
            cells.forEach((c) => tr.append(createElement('td', '', c)));
            body.append(tr);
        });
        table.append(body);
        panel.append(table);
    }

    /** 创建 label 与 input，并通过 htmlFor/id 关联，便于键盘和辅助技术使用。 */
    function createFormInput(parent, label, id, value) {
        const labelElement = createElement('label', 'input-label', label);
        labelElement.htmlFor = id;
        const input = createElement('input');
        input.id = id;
        input.value = value;
        input.maxLength = 2000;
        parent.append(labelElement, input);
        return input;
    }
    // 用两位十六进制显示每个字节：0 → 00，255 → ff，再用空格分隔。
    const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');

    /** 本地执行两种编码，显示实际字节数；输入改变时重新计算，不发送网络请求。 */
    function renderEncoding() {
        renderHeading(
            '同一份数据，文本和二进制有什么区别？',
            '修改接收者或内容，即时查看 UTF-8 字节和符合下方 schema 的 Protobuf 二进制。比较仅包含消息体，不包含网络头部。',
            '本地真实编码',
        );
        const form = createElement('div', 'encoding-form');
        const to = createFormInput(form, '接收者 / to', 'encode-to', 'bob');
        const text = createFormInput(form, '消息内容 / text', 'encode-text', '你好 Bob');
        panel.append(form);
        const schema = createElement(
            'pre',
            'schema',
            'syntax = "proto3";\nmessage Chat {\n  string to = 1;\n  string text = 2;\n}',
        );
        panel.append(schema);
        const result = createElement('div', 'encoding-result');
        panel.append(result);
        // 每次修改输入，都使用同一组数据重新生成 JSON 与 Protobuf 的展示。
        function calculate() {
            const data = { to: to.value, text: text.value };
            const json = JSON.stringify(data);
            const utf8 = new TextEncoder().encode(json);
            const proto = IMLabCodec.encode(to.value, text.value); // 不比较 TCP/TLS/WebSocket 等额外头部。
            result.replaceChildren();
            for (const [name, bytes, raw] of [
                ['JSON / UTF-8', utf8, json],
                ['Protobuf', proto.bytes, toHex(proto.bytes)],
            ]) {
                const card = createElement('div', 'encoding-card');
                card.append(
                    createElement('div', 'section-title', name),
                    createElement('strong', 'byte-count', bytes.length + ' bytes'),
                    createElement('pre', 'json', raw),
                    createElement('pre', 'hex-view', toHex(bytes)),
                );
                result.append(card);
            }
            const breakdown = createElement('div', 'byte-breakdown');
            breakdown.append(createElement('h3', '', 'Protobuf 字段拆解'));
            if (!proto.parts.length) {
                breakdown.append(
                    createElement(
                        'p',
                        'detail-note',
                        'proto3 空字符串为默认值，此编码省略这两个字段，消息体为 0 字节。',
                    ),
                );
            }
            proto.parts.forEach((part) => {
                const item = createElement('div', 'byte-field');
                item.append(
                    createElement('b', '', part.name),
                    createElement(
                        'code',
                        '',
                        toHex([part.tag]) +
                            ' | ' +
                            toHex(part.lengthBytes) +
                            ' | ' +
                            toHex(part.body),
                    ),
                    createElement(
                        'p',
                        'detail-note',
                        `tag=${part.tag}，由 (字段编号 << 3) | 2 得到；wire type 2 为长度分隔。长度使用 varint，内容是 ${part.body.length} 字节 UTF-8。`,
                    ),
                );
                breakdown.append(item);
            });
            panel.append(breakdown); // 展示 tag、长度 varint 与正文的字段边界。
            const previous = panel.querySelectorAll('.byte-breakdown');
            if (previous.length > 1) {
                previous[0].remove(); // 删除上一次输入的拆解结果，避免重复累积。
            }
        }
        to.oninput = calculate; // 接收者变化也会改变编码长度。
        text.oninput = calculate; // 文本变化时即时刷新。
        calculate();
        renderSourceLink({
            source: ['Protobuf 官方编码说明', 'https://protobuf.dev/programming-guides/encoding/'],
        });
    }

    /** 本地生成示例帧，展示帧头、随机 key 和逐字节异或；浏览器真实网络帧不来自此函数。 */
    function renderFrames() {
        renderHeading(
            '从文本消息，到一帧 WebSocket 字节。',
            '本地构造一个 FIN=1、opcode=1 的客户端文本帧，使用随机 4 字节 masking key。此处生成的帧不发送到网络，真实帧由浏览器负责。',
            '本地真实编码',
        );
        const form = createElement('div', 'encoding-form');
        const input = createFormInput(form, '帧的文本内容', 'frame-text', 'hello');
        const button = createElement('button', '', '重新生成 masking key');
        form.append(button);
        panel.append(form);
        const result = createElement('div', 'frame-result');
        panel.append(result);
        // 调用 codec.js 的实际编码工具；每次计算都会生成新的随机 masking key。
        function calculate() {
            const frame = IMLabCodec.frame(input.value);
            result.replaceChildren();
            const fields = createElement('div', 'frame-fields');
            [
                ['FIN', '1 / 最后一帧'],
                ['RSV', '000 / 未启用扩展'],
                ['opcode', '0001 / 文本'],
                ['MASK', '1 / 客户端帧'],
                ['payload length', frame.payload.length + ' 字节'],
                ['masking key', toHex(frame.key)],
            ].forEach(([label, value]) => {
                const box = createElement('div');
                box.append(createElement('b', '', label), createElement('span', '', value));
                fields.append(box);
            });
            result.append(
                fields,
                createElement('h3', '', '完整帧 · ' + frame.bytes.length + ' 字节'),
                createElement('pre', 'json', toHex(frame.bytes)),
                createElement(
                    'p',
                    'detail-note',
                    'header: ' + toHex(frame.header) + ' · masking key: ' + toHex(frame.key),
                ),
                createElement('h3', '', '异或 masking：encoded[i] = payload[i] XOR key[i % 4]'),
            );
            const table = createElement('table', 'comparison');
            table.innerHTML =
                '<thead><tr><th>索引</th><th>原始字节</th><th>key 字节</th><th>masked 字节</th></tr></thead>';
            const body = createElement('tbody');
            Array.from(frame.payload)
                .slice(0, MAX_DISPLAYED_BYTES)
                .forEach((b, i) => {
                    const row = createElement('tr');
                    [
                        String(i),
                        toHex([b]),
                        toHex([frame.key[i % 4]]),
                        toHex([frame.masked[i]]),
                    ].forEach((t) => row.append(createElement('td', '', t)));
                    body.append(row);
                });
            table.append(body);
            result.append(
                table,
                createElement(
                    'p',
                    'detail-note',
                    '只展示前 24 个 payload 字节。服务端用同一个 key 异或即可恢复；masking 不提供保密性。服务端发送的帧不带 masking，WSS 的内容保护来自 TLS。',
                ),
            );
        }
        input.oninput = calculate;
        button.onclick = calculate; // 不修改正文也可重新生成 key，观察不同 masked 字节。
        calculate();
        renderSourceLink({
            source: ['WebSocket 帧格式 · RFC 6455', 'https://www.rfc-editor.org/rfc/rfc6455.html'],
        });
    }

    /** 构建真实 HTTP 请求实验；请求由 fetch 发给 Java 的 /api/lab/echo。 */
    function renderHttp() {
        const scene = scenes.http;
        renderHeading(scene.title, scene.description, '真实 HTTP 请求');
        const form = createElement('div', 'encoding-form');
        const input = createFormInput(form, '请求内容 / text', 'http-text', '学习 HTTP 请求与响应');
        const send = createElement('button', 'primary', '发送 POST 请求');
        form.append(send);
        panel.append(form);
        const result = createElement('div', 'http-result');
        result.append(createElement('div', 'empty', '发送请求，观察浏览器 → Java API → 浏览器'));
        panel.append(result);
        send.onclick = async () => {
            const generation = requestGeneration; // 捕获发出请求时的页面代数。
            send.disabled = true; // 同一次请求未结束前禁止重复点击。
            result.replaceChildren();
            const body = JSON.stringify({ text: input.value });
            const request = createElement('div', 'encoding-card');
            request.append(
                createElement('h3', '', '↑ 请求 / 浏览器 → Java'),
                createElement(
                    'pre',
                    'json',
                    'POST /api/lab/echo\nContent-Type: application/json\n\n' + body,
                ),
            );
            result.append(request);
            const start = performance.now(); // 使用单调高精度时钟测量请求耗时。
            try {
                const response = await fetch('/api/lab/echo', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
                });
                const text = await response.text(); // 显式读取响应体；fetch 成功不代表 HTTP 状态一定是 200。
                if (generation !== requestGeneration) {
                    return; // 用户已切换标签：不把旧响应写到当前页面。
                }
                const elapsed = (performance.now() - start).toFixed(1);
                const card = createElement('div', 'encoding-card');
                card.append(
                    createElement('h3', '', '↓ 响应 / Java → 浏览器'),
                    createElement(
                        'strong',
                        'byte-count',
                        response.status + ' · ' + elapsed + ' ms',
                    ),
                    createElement(
                        'pre',
                        'json',
                        'HTTP status: ' +
                            response.status +
                            ' ' +
                            response.statusText +
                            '\n' +
                            Array.from(response.headers, ([k, v]) => k + ': ' + v).join('\n') +
                            '\n\n' +
                            text,
                    ),
                    createElement(
                        'p',
                        'detail-note',
                        'fetch 读取到的响应头与状态；不是原始网络字节。耗时包含网络与浏览器处理时间。当前本地接口未启用 HTTPS。',
                    ),
                );
                result.append(card);
            } catch (error) {
                // 网络错误或超时才进入这里；HTTP 400/500 仍是可展示的响应。
                if (generation === requestGeneration) {
                    result.append(
                        createElement(
                            'p',
                            'http-error',
                            '请求失败：' + error.message + '。请确认 Java 服务已经启动。',
                        ),
                    );
                }
            } finally {
                send.disabled = false; // 无论成功或异常都恢复按钮。
            }
        };
        renderSourceLink(scene);
    }

    // 六、启动与页面生命周期。
    // 页面切到后台时暂停动画；返回页面后由用户决定是否继续。
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stop();
        }
    });

    initializeNavigation(); // 先创建导航 DOM 和事件。
    switchTab('ws'); // 再选中原有真实 WebSocket 页面。
})(); // 立即执行，内部播放状态不暴露给其他脚本。
