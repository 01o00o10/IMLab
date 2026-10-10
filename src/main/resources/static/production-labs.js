/**
 * 内存中的提交边界故障实验。所有操作只修改本页模型，不发送真实请求。
 * 对照方案故意省略恢复日志；Outbox 方案示意本地事务与消费去重。
 */
(() => {
    /** 一次实验只有一个逻辑请求，所有重试固定使用 alice:k1 / e1。 */
    function initial(strategy = 'outbox', fault = 'none') {
        return {
            strategy,
            fault,
            faultUsed: false,
            message: false,
            outbox: false,
            clientAck: false,
            relayCheckpoint: false,
            queued: 0,
            consumed: false,
            inbox: 0,
            sends: 0,
            publishes: 0,
            online: true,
            history: [],
        };
    }
    /** 状态转换是纯函数；失败点只注入一次，便于恢复后核对结果。 */
    function transition(previous, action) {
        const state = { ...previous, history: [...previous.history] };
        const log = (message) => state.history.push(message);
        const crash = (point) => {
            if (state.fault !== point || state.faultUsed) return false;
            state.faultUsed = true;
            state.online = false;
            log('注入故障：' + point + '；需恢复进程。');
            return true;
        };
        if (action === 'restart') {
            state.online = true;
            log('进程恢复；已提交事实保留，未提交操作回滚。');
        } else if (!state.online) {
            log('进程不可用；先恢复进程。');
        } else if (action === 'send') {
            state.sends++;
            if (state.message) {
                state.clientAck = true;
                log('相同请求键命中 m1；返回原结果，没有新正文或新事件。');
            } else if (!crash('beforeCommit')) {
                state.message = true;
                state.outbox = state.strategy === 'outbox';
                log(
                    state.outbox
                        ? '事务提交：m1、幂等键 k1、Outbox e1 一起写入。'
                        : '对照方案：只提交 m1 和幂等键，没有耐久分发任务。',
                );
                if (!crash('afterCommit')) {
                    if (state.strategy === 'direct') {
                        state.queued++;
                        state.publishes++;
                        log('对照方案继续向队列发送 e1。');
                    }
                    if (!crash('ackLost')) {
                        state.clientAck = true;
                        log('客户端收到 ACK m1；表示持久化，不表示已读。');
                    }
                }
            }
        } else if (action === 'relay') {
            if (!state.outbox) log('没有 Outbox 记录；无法从耐久事件恢复分发。');
            else if (state.relayCheckpoint) log('中继已确认 e1，不再发送。');
            else {
                state.queued++;
                state.publishes++;
                log('中继向队列发送 e1，队列接受事件。');
                if (!crash('relayCheckpoint')) {
                    state.relayCheckpoint = true;
                    log('中继保存发送完成检查点。');
                }
            }
        } else if (action === 'consume') {
            if (!state.queued) log('队列为空，没有事件可消费。');
            else if (state.consumed) {
                state.queued--;
                log('重复 e1：去重命中，不增加收件箱引用；确认本次交付。');
            } else if (!crash('consumerBeforeCommit')) {
                state.consumed = true;
                state.inbox++;
                log('消费事务提交：去重标记 e1 与收件箱引用 m1 一起保存。');
                if (!crash('consumerAck')) {
                    state.queued--;
                    log('队列收到消费确认。');
                }
            }
        } else {
            throw new Error('未知实验动作：' + action);
        }
        state.history = state.history.slice(-50); // 控制日志长度，连续点击不会无限增长 DOM。
        return state;
    }
    /** 显示耐久事实、暂态队列和不变量，按钮允许用户自行选择恢复步骤。 */
    function render(panel) {
        const element = (tag, className, text) => {
            const node = document.createElement(tag);
            node.className = className || '';
            if (text !== undefined) node.textContent = text;
            return node;
        };
        const section = element('section', 'architecture-calculator');
        section.append(element('h3', '', '故障实验 · 提交边界与重复事件'));
        const controls = element('div', 'scene-controls');
        const strategy = element('select');
        strategy.id = 'transaction-strategy';
        strategy.setAttribute('aria-label', '分发方案');
        for (const [value, label] of [
            ['outbox', '事务 Outbox'],
            ['direct', '对照：提交后直接发队列'],
        ]) {
            const option = element('option', '', label);
            option.value = value;
            strategy.append(option);
        }
        strategy.value = 'outbox';
        const fault = element('select');
        fault.id = 'transaction-fault';
        fault.setAttribute('aria-label', '一次性故障位置');
        const faults = [
            ['none', '无故障'],
            ['beforeCommit', '提交前崩溃'],
            ['afterCommit', '提交后立即崩溃'],
            ['ackLost', '客户端 ACK 丢失'],
            ['relayCheckpoint', '发布后中继检查点丢失'],
            ['consumerBeforeCommit', '消费事务提交前崩溃'],
            ['consumerAck', '消费提交后确认丢失'],
        ];
        for (const [value, label] of faults) {
            const option = element('option', '', label);
            option.value = value;
            fault.append(option);
        }
        fault.value = 'none';
        controls.append(strategy, fault);
        let state = initial();
        const output = element('div', 'calculator-output');
        output.id = 'transaction-output';
        output.setAttribute('aria-live', 'polite');
        const log = element('pre', 'transaction-log');
        const draw = () => {
            output.replaceChildren();
            output.append(
                element(
                    'p',
                    '',
                    '进程：' +
                        (state.online ? '运行' : '崩溃') +
                        '；客户端：' +
                        (state.clientAck ? '收到持久化 ACK' : '尚未确认 / 结果未知'),
                ),
            );
            output.append(
                element(
                    'p',
                    '',
                    '正文：' +
                        Number(state.message) +
                        '；Outbox：' +
                        Number(state.outbox) +
                        '；队列待确认：' +
                        state.queued +
                        '；发布次数：' +
                        state.publishes,
                ),
            );
            output.append(
                element(
                    'p',
                    '',
                    '中继检查点：' +
                        Number(state.relayCheckpoint) +
                        '；消费去重标记：' +
                        Number(state.consumed) +
                        '；收件箱引用：' +
                        state.inbox,
                ),
            );
            const orphan = state.message && !state.outbox && state.publishes === 0;
            output.append(
                element(
                    'p',
                    orphan ? 'calculator-error' : '',
                    orphan
                        ? '发现分发缺口：正文已提交，但没有已发布事件或可恢复 Outbox。按原键重试只能返回正文，不能自动恢复漏发。'
                        : '核对：每个请求最多一份正文；重复 e1 不应增加第二条收件箱引用。',
                ),
            );
            log.textContent =
                state.history.join('\n') ||
                '选择方案和故障，再按顺序尝试发送 → 中继 → 消费。改变选择会重置实验。';
        };
        const reset = () => {
            state = initial(strategy.value, fault.value);
            draw();
        };
        strategy.onchange = reset;
        fault.onchange = reset;
        for (const [action, label] of [
            ['send', '发送 / 同键重试'],
            ['relay', '运行中继'],
            ['consume', '消费一个事件'],
            ['restart', '恢复进程'],
            ['reset', '重置实验'],
        ]) {
            const button = element('button', '', label);
            button.id = 'transaction-' + action;
            button.onclick = () => {
                if (action === 'reset') reset();
                else {
                    state = transition(state, action);
                    draw();
                }
            };
            controls.append(button);
        }
        section.append(controls, output, log);
        section.append(
            element(
                'p',
                'calculator-assumptions',
                '教学假设：本地事务原子提交；队列未确认事件可以再次交付；消费去重与收件箱写入同事务。模型用一个开关模拟进程恢复，不代表真实多节点调度。对照方案故意省略恢复任务；其它持久日志或 CDC 设计也可修补缺口。外部支付、Webhook 等副作用仍需自己的幂等机制。',
            ),
        );
        panel.append(section);
        draw();
    }
    globalThis.IMLabProduction = { initial, transition, render };
})();
