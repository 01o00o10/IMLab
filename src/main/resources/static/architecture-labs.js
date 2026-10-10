/**
 * 可调参数的架构模型。只计算教学假设下的数量，不把结果当成生产压测数据。
 * 数学函数与 DOM 分离，便于检验单位、边界和瓶颈选择。
 */
(() => {
    /** 拒绝空值、非有限数和越界输入，避免显示看似有效的错误容量。 */
    function validate(values, specifications) {
        const result = {};
        for (const [key, label, initial, min, max] of specifications) {
            const raw = values[key];
            const value = Number(raw);
            if (
                String(raw).trim() === '' ||
                !Number.isFinite(value) ||
                value < min ||
                value > max
            ) {
                throw new Error(label + ' 必须在 ' + min + '～' + max + ' 之间');
            }
            result[key] = value;
        }
        return result;
    }
    // 参数包含单位；目标收件人数不包含发送者，正文始终只保存一次。
    const fanoutInputs = [
        ['recipients', '目标收件人 / 人', 1000, 1, 10000000],
        ['messages', '发布速度 / 条每秒', 10, 0, 1000000],
        ['active', '预推送收件人 / %', 20, 0, 100],
        ['logs', '一次刷新读取的会话或作者日志 / 个', 100, 1, 100000],
        ['refreshes', '总刷新速度 / 次每秒', 50, 0, 1000000],
        ['indexBytes', '每条收件箱索引 / 字节', 64, 1, 100000],
    ];
    /** 只比较行写入和逻辑读取路数；每一路的扫描长度另由分页控制。 */
    function fanout(values) {
        const p = validate(values, fanoutInputs);
        const references = p.messages * p.recipients;
        return {
            rows: [p.messages + references, p.messages, p.messages + (references * p.active) / 100],
            reads: [p.refreshes, p.refreshes * p.logs],
            gib: [
                (references * 86400 * p.indexBytes) / 2 ** 30,
                0,
                (((references * p.active) / 100) * 86400 * p.indexBytes) / 2 ** 30,
            ],
        };
    }
    const capacityInputs = [
        ['cells', 'Cell 数量 / 个', 4, 1, 10000],
        ['nodes', '每个 Cell 网关数量 / 个', 2, 1, 10000],
        ['connections', '每个网关连接上限 / 个', 15000, 1, 10000000],
        ['online', '在线连接需求 / 个', 80000, 0, 1000000000],
        ['utilization', '计划使用率 / %', 70, 1, 100],
        ['cellRate', '单 Cell 写入上限 / 条每秒', 6000, 1, 1000000000],
        ['sharedRate', '共享依赖上限 / 条每秒', 15000, 1, 1000000000],
        ['hotspot', '最热 Cell 承接流量 / %', 40, 1, 100],
        ['fanout', '每条消息投递任务 / 个', 20, 1, 10000000],
        ['taskRate', '单 Cell 投递能力 / 任务每秒', 200000, 1, 1000000000],
        ['bandwidth', '总有效出口带宽 / Mbps', 1000, 1, 1000000000],
        ['payload', '每次投递平均字节 / 字节', 512, 1, 10000000],
        ['arrival', '消息到达速度 / 条每秒', 8000, 0, 1000000000],
        ['backlog', '已有队列积压 / 条', 100000, 0, 1000000000000],
    ];
    /** 把投递任务和带宽统一折算成原始消息每秒，再选最小预算。 */
    function capacity(values) {
        const p = validate(values, capacityInputs);
        if (!Number.isInteger(p.cells) || !Number.isInteger(p.nodes))
            throw new Error('Cell 和网关数量必须是整数');
        if (p.hotspot < 100 / p.cells)
            throw new Error(
                '最热 Cell 的流量占比不能低于平均占比 ' + (100 / p.cells).toFixed(2) + '%',
            );
        const u = p.utilization / 100;
        const budgets = [
            ['全部 Cell 写入', p.cells * p.cellRate * u],
            ['共享依赖', p.sharedRate * u],
            ['最热 Cell', (p.cellRate * u) / (p.hotspot / 100)],
            ['投递工作者', (p.cells * p.taskRate * u) / p.fanout],
            ['出口带宽', (((p.bandwidth * 1000000) / 8) * u) / (p.payload * p.fanout)],
        ];
        const limit = Math.min(...budgets.map(([, rate]) => rate));
        return {
            budgets,
            limit,
            bottlenecks: budgets.filter(([, rate]) => rate === limit).map(([label]) => label),
            connections: p.cells * p.nodes * p.connections * u,
            requiredCells: Math.ceil(p.online / (p.nodes * p.connections * u)),
            remainingConnections: (p.cells - 1) * p.nodes * p.connections * u,
            growth: Math.max(0, p.arrival - limit),
            drain: p.backlog === 0 ? 0 : limit > p.arrival ? p.backlog / (limit - p.arrival) : null,
        };
    }
    /** 使用原生输入和条形图，在场景播放器旁展示模型的即时计算结果。 */
    function render(panel, kind) {
        const specifications = kind === 'fanout' ? fanoutInputs : capacityInputs;
        const element = (tag, className, text) => {
            const node = document.createElement(tag);
            node.className = className || '';
            if (text !== undefined) node.textContent = text;
            return node;
        };
        const section = element('section', 'architecture-calculator');
        section.append(
            element(
                'h3',
                '',
                kind === 'fanout' ? '扩散成本 · 调参数看变化' : '扩容边界 · 找到当前瓶颈',
            ),
        );
        const inputs = element('div', 'calculator-inputs');
        const output = element('div', 'calculator-output');
        output.id = 'calculator-output';
        output.setAttribute('aria-live', 'polite');
        const controls = {};
        const format = (value) => Number(value.toFixed(2)).toLocaleString('zh-CN');
        const update = () => {
            output.replaceChildren();
            try {
                const values = Object.fromEntries(
                    Object.entries(controls).map(([key, input]) => [key, input.value]),
                );
                const result = kind === 'fanout' ? fanout(values) : capacity(values);
                const bars =
                    kind === 'fanout'
                        ? ['写扩散', '读扩散', '混合扩散'].map((name, index) => [
                              name,
                              result.rows[index],
                          ])
                        : result.budgets;
                const maximum = Math.max(1, ...bars.map(([, value]) => value));
                for (const [name, value] of bars) {
                    const row = element('div', 'budget-row');
                    row.append(
                        element(
                            'span',
                            '',
                            name +
                                '：' +
                                format(value) +
                                (kind === 'fanout' ? ' 行写入/秒' : ' 条消息/秒'),
                        ),
                    );
                    const bar = element('div', 'budget-bar');
                    bar.style.width = (value / maximum) * 100 + '%';
                    row.append(bar);
                    output.append(row);
                }
                if (kind === 'fanout') {
                    output.append(
                        element(
                            'p',
                            '',
                            '额外收件箱索引 / 日：写扩散 ' +
                                format(result.gib[0]) +
                                ' GiB；混合扩散 ' +
                                format(result.gib[2]) +
                                ' GiB；读扩散 0 GiB。',
                        ),
                    );
                    output.append(
                        element(
                            'p',
                            '',
                            '读取路数 / 秒：写扩散 ' +
                                format(result.reads[0]) +
                                '；读扩散 ' +
                                format(result.reads[1]) +
                                '。混合方案的读取开销取决于哪些用户预推送和实际访问分布。',
                        ),
                    );
                } else {
                    output.append(
                        element(
                            'p',
                            '',
                            '当前瓶颈：' +
                                result.bottlenecks.join('、') +
                                '；总预算 ' +
                                format(result.limit) +
                                ' 条/秒。',
                        ),
                    );
                    output.append(
                        element(
                            'p',
                            '',
                            '连接预算 ' +
                                format(result.connections) +
                                '；按连接需求至少 ' +
                                result.requiredCells +
                                ' 个 Cell；损失一个 Cell 后预算 ' +
                                format(result.remainingConnections) +
                                '。',
                        ),
                    );
                    output.append(
                        element(
                            'p',
                            '',
                            '队列每秒新增积压 ' +
                                format(result.growth) +
                                ' 条；已有积压清空时间：' +
                                (result.drain === null
                                    ? '无法清空（到达速度不低于处理速度）'
                                    : format(result.drain) + ' 秒') +
                                '。',
                        ),
                    );
                }
            } catch (error) {
                output.append(element('p', 'calculator-error', error.message));
            }
        };
        for (const [key, label, initial, min, max] of specifications) {
            const wrapper = element('label');
            const input = element('input');
            input.id = 'model-' + key;
            input.type = 'number';
            input.min = min;
            input.max = max;
            input.step = 'any';
            input.value = String(initial);
            input.oninput = update;
            controls[key] = input;
            wrapper.append(element('span', '', label), input);
            inputs.append(wrapper);
        }
        section.append(inputs, output);
        section.append(
            element(
                'p',
                'calculator-assumptions',
                kind === 'fanout'
                    ? '假设：每条正文写一次；每位收件人一条引用；预推送比例固定。索引估算不含副本、压缩、删除、数据库行开销和正文。读取路数不等于实际 RPC 数或 CPU 成本，不代表各方案的性能排名。'
                    : '假设：流量比例固定，预算按计划使用率折减，各项单位统一为原始消息/秒；带宽含每条消息的投递倍数。忽略重试、存储放大、迁移和突发流量。失去一个 Cell 后的连接预算只是算术上限，还需路由、数据恢复与故障演练；增加 Cell 无法自动提升共享依赖上限。',
            ),
        );
        panel.append(section);
        update();
    }
    globalThis.IMLabArchitecture = { fanout, capacity, render, fanoutInputs, capacityInputs };
})();
