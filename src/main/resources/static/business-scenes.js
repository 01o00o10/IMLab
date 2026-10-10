/**
 * IM 业务进阶可视化数据。
 * 此文件只定义教学状态机，不新增 Java 鉴权、数据库、推送或密码学实现。
 * 报文中的业务类型是本实验自定义示例；官方链接用于进一步阅读，不代表兼容其 API。
 * 加载顺序：protocol-scenes.js → 本文件 → protocols.js。
 */
(() => {
    const scenes = globalThis.IMLabScenes; // 向原有场景集合增加业务进阶主题。
    const matrixSource = [
        '参考：Matrix 客户端规范',
        'https://spec.matrix.org/latest/client-server-api/index.html',
    ];

    /** 与基础场景保持一致：from/to 是参与方下标，state 是每位参与方的当前状态。 */
    function step(from, to, title, raw, note, state, fields = []) {
        return { from, to, title, raw, note, state, fields };
    }

    // 一、认证不仅是一个 LOGIN 类型，还要处理凭据有效性与会话访问权限。
    scenes.authentication = {
        name: '认证与权限',
        layer: '身份安全',
        title: '连接已建立，凭什么相信你是谁？',
        description:
            '教学模拟：观察身份认证、token 到期与刷新，以及会话权限校验。token 全是无效占位符，当前 Java LOGIN 仍只绑定 userId。示例报文不是完整 OAuth 实现。',
        actors: ['客户端', '身份 / IM 服务', '会话权限'],
        source: ['参考：OAuth 安全实践 RFC 9700', 'https://www.rfc-editor.org/rfc/rfc9700.html'],
        takeaway:
            '认证回答“你是谁”，授权回答“你能访问什么”。连接打开、token 有效和有会话权限是三个不同条件。',
        quiz: {
            question: 'token 有效，就一定能读取任意群的历史消息吗？',
            options: ['可以，身份已验证', '不可以，还需检查会话权限', '只要伪造 from 即可'],
            answerIndex: 1,
            explanation:
                '身份来自服务端验证；每次业务请求还应检查用户的会话成员资格和具体操作权限。',
        },
        variants: {
            login: {
                name: '验证凭据 → 绑定身份',
                steps: [
                    step(
                        0,
                        1,
                        '通过 HTTPS 登录接口取得凭据',
                        'POST /session（自定义示例）\n凭据：<仅占位，未发送真实密码>\n返回：accessToken=<demo-token> expiresIn=300',
                        '真实认证服务验证用户凭据后才签发 token；本场景不收集密码，也不请求接口。',
                        ['等待凭据', '认证用户', '尚未检查'],
                    ),
                    step(
                        0,
                        1,
                        '连接后发送应用 AUTH',
                        '{"type":"AUTH","id":"auth-1","accessToken":"<demo-token>"}',
                        '应用认证发生在 WebSocket 连接建立之后；采用此设计时，应限制未认证连接的能力与存活时间。',
                        ['等待认证', '验证 token', '尚未检查'],
                        [['accessToken', '访问凭据；真实系统不应把完整凭据写入普通报文日志']],
                    ),
                    step(
                        1,
                        1,
                        '校验签名、有效期与目标服务',
                        'validate signature / expiration / issuer / audience\nresolved subject: alice',
                        '若使用 JWT，应校验允许的算法和信任的签发方；解析出字段不等于签名验证通过。其他 token 形式可用服务端查询验证。',
                        ['待认证', '身份确认为 alice', '尚未检查'],
                    ),
                    step(
                        1,
                        0,
                        '绑定会话身份',
                        '{"type":"AUTH_OK","refId":"auth-1","userId":"alice","sessionId":"s-1"}',
                        '服务端把验证后的 subject 绑定到连接，后续 from 从会话中取得。',
                        ['已认证 alice', '会话已绑定', '尚未检查'],
                    ),
                    step(
                        1,
                        2,
                        '检查目标会话成员资格',
                        'operation=SEND_MESSAGE\nsubject=alice\nconversation=alice-bob\npermission=allow',
                        '在开始聊天前继续检查目标会话权限；身份合法不等于可以访问任意会话。',
                        ['可发送到 alice-bob', '认证与授权通过', '允许当前操作'],
                    ),
                ],
            },
            refresh: {
                name: 'token 到期 → 刷新 / 轮换',
                steps: [
                    step(
                        0,
                        1,
                        '使用已过期凭据',
                        'AUTH accessToken=<expired-token>',
                        '服务端必须按自己的可信时间校验有效期，不能采用客户端自报时间。',
                        ['尝试认证', '发现 token 已过期', '不执行业务'],
                    ),
                    step(
                        1,
                        0,
                        '明确拒绝认证',
                        '{"type":"ERROR","code":"TOKEN_EXPIRED","retryable":false}',
                        '本次旧凭据不可用；示例 retryable=false 表示不能原样重试，需要先更新凭据。',
                        ['暂停业务请求', '拒绝旧凭据', '未授权'],
                    ),
                    step(
                        0,
                        1,
                        '通过 HTTPS 刷新',
                        'POST /session/refresh（示例）\nrefreshToken=<refresh-1>',
                        '真实部署应结合客户端类型选择凭据保存方式与刷新机制；此处不在页面保存任何真实 token。',
                        ['等待刷新', '验证 refresh-1', '未授权'],
                    ),
                    step(
                        1,
                        0,
                        '轮换 refresh token',
                        'accessToken=<access-2>\nrefreshToken=<refresh-2>\nrefresh-1 → invalidated',
                        '本例采用轮换策略：成功刷新后作废旧 refresh token。若检测到旧值复用，可撤销关联会话，策略由系统定义。',
                        ['获得新凭据', '旧刷新凭据失效', '尚未检查'],
                    ),
                    step(
                        0,
                        1,
                        '重新认证并恢复同步',
                        'AUTH accessToken=<access-2>\nAUTH_OK\nSYNC afterSeq=100',
                        '凭据刷新成功不表示丢失消息已补齐，还要恢复同步；认证失败时保留待发送消息，等待用户处理。',
                        ['重新认证 / 同步', '新身份验证成功', '逐请求检查权限'],
                    ),
                ],
            },
            denied: {
                name: '越权访问 / 伪造身份',
                steps: [
                    step(
                        0,
                        1,
                        '伪造 from 并访问陌生群',
                        '{"type":"CHAT","from":"admin","conversationId":"private-room","text":"hello"}\nsession subject=alice',
                        '客户端自报 from 不可信；真实身份应始终取自认证后的连接上下文。',
                        ['自报 admin', '真实身份 alice', '待检查'],
                    ),
                    step(
                        1,
                        2,
                        '按真实身份查权限',
                        'subject=alice\nroom=private-room\nmember=false',
                        '服务端检查当前主体是否为该群成员，以及是否有发送权限。',
                        ['等待结果', '检查 alice 权限', '不是成员'],
                    ),
                    step(
                        2,
                        1,
                        '拒绝操作',
                        'decision=DENY\nreason=NOT_A_MEMBER',
                        '不能在拒绝前先投递消息或返回群历史。权限校验应位于产生副作用之前。',
                        ['无消息被发送', '停止处理', '拒绝'],
                    ),
                    step(
                        1,
                        0,
                        '返回明确错误',
                        '{"type":"ERROR","code":"FORBIDDEN","detail":"没有该会话访问权限"}',
                        '错误响应可以帮助客户端展示原因，但不应泄露它无权访问的会话内容。',
                        ['显示无权限', '未执行操作', '权限保持不变'],
                    ),
                ],
            },
        },
    };

    // 二、生命周期拆清“已发出”和各种确认；消息状态单独用于渲染进度条。
    scenes.lifecycle = {
        name: '消息生命周期',
        layer: '消息语义',
        title: '一个“发送成功”，究竟成功到哪一步？',
        description:
            '教学模拟：区分发送中、服务端接受、持久化、设备送达与用户已读。下方状态条随场景推进；当前真实 Java ACK 仍只表示 accepted，不等于已保存或已送达。',
        actors: ['Alice', 'IM 服务端', 'Bob'],
        source: matrixSource,
        messageStages: ['发送中', '已接受', '已保存', '已送达', '已读'],
        takeaway:
            '先约定每种确认的证据，再更新 UI。WebSocket.send 只是本地发送调用，送达和已读需要不同业务事件。',
        quiz: {
            question: '客户端收到 status=accepted，可以显示“对方已读”吗？',
            options: ['可以', '不可以，需要 READ / RECEIPT', '等 1 秒就可以'],
            answerIndex: 1,
            explanation: '服务端接受、设备送达、用户阅读分别是不同状态，不能由时间推断后两者。',
        },
        variants: {
            full: {
                name: '从发送中到已读',
                steps: [
                    {
                        ...step(
                            0,
                            1,
                            '客户端排队发送',
                            '{"type":"CHAT","clientMsgId":"a-1","text":"你好"}\nUI: sending',
                            '本地建立气泡并调用 send，仍可能在服务端处理前断线。',
                            ['发送中', '待处理', '尚未收到'],
                        ),
                        messageStage: 0,
                    },
                    {
                        ...step(
                            1,
                            0,
                            '服务端接受请求',
                            '{"type":"ACK","status":"accepted","clientMsgId":"a-1"}',
                            'accepted 表示已接受处理；本场景刻意将它与数据库提交确认分开。实际系统也可以约定 ACK 只在提交后发出。',
                            ['已接受', '处理业务', '尚未收到'],
                        ),
                        messageStage: 1,
                    },
                    {
                        ...step(
                            1,
                            0,
                            '持久化确认',
                            '{"type":"ACK","status":"persisted","messageId":"m-1","seq":101}',
                            '数据库事务成功后才能产生 persisted；这个状态是自定义示例，不是 WebSocket 标准。',
                            ['已保存', '消息已提交', '尚未收到'],
                        ),
                        messageStage: 2,
                    },
                    {
                        ...step(
                            1,
                            2,
                            '推送给接收设备',
                            '{"type":"MESSAGE","messageId":"m-1","seq":101,"text":"你好"}',
                            '服务端发送到连接不等于设备已经收下；此时仍等待设备业务确认。',
                            ['已保存', '等待 DELIVERED', '处理接收消息'],
                        ),
                        messageStage: 2,
                    },
                    {
                        ...step(
                            2,
                            1,
                            '设备确认接收',
                            '{"type":"DELIVERED","messageId":"m-1","deviceId":"bob-phone"}',
                            '客户端将消息成功纳入其接收状态后确认，再由服务端通知发送者。用户此时可能尚未打开会话。',
                            ['已保存，待通知', '收到设备确认', '设备已接收'],
                        ),
                        messageStage: 2,
                    },
                    {
                        ...step(
                            1,
                            0,
                            '告诉发送者已送达',
                            '{"type":"RECEIPT","messageId":"m-1","status":"delivered"}',
                            'Alice 的状态在实际收到此事件后才升级到已送达。',
                            ['已送达', '等待用户阅读', '尚未阅读'],
                        ),
                        messageStage: 3,
                    },
                    {
                        ...step(
                            2,
                            1,
                            '用户阅读后发送 READ',
                            '{"type":"READ","messageId":"m-1"}',
                            '示例以用户显式标记已读为判断依据，不能仅凭连接在线自动确认。',
                            ['已送达', '记录已读', '用户已读'],
                        ),
                        messageStage: 3,
                    },
                    {
                        ...step(
                            1,
                            0,
                            '发送者看到已读',
                            '{"type":"RECEIPT","messageId":"m-1","status":"read"}',
                            '状态与消息 ID 关联；重放重复回执不应让状态回退。',
                            ['已读', '已读已通知', '用户已读'],
                        ),
                        messageStage: 4,
                    },
                ],
            },
            uncertain: {
                name: '发送失败还是结果未知？',
                steps: [
                    {
                        ...step(
                            0,
                            1,
                            '发送后网络断开',
                            'CHAT clientMsgId=a-2\n连接在 ACK 返回前中断',
                            '没有收到 ACK 时，不能判断服务端一定没有保存消息。',
                            ['发送中 / 结果未知', '可能已保存', '状态未知'],
                        ),
                        messageStage: 0,
                    },
                    {
                        ...step(
                            0,
                            0,
                            '保留稳定业务 ID',
                            'outbox: clientMsgId=a-2\nUI: pending / 可重试',
                            '未确认状态应与明确的权限拒绝、内容非法等终态区分。',
                            ['待恢复确认', '暂不可达', '状态未知'],
                        ),
                        messageStage: 0,
                    },
                    {
                        ...step(
                            0,
                            1,
                            '重连后查询或幂等重试',
                            '{"type":"CHAT","clientMsgId":"a-2","text":"同一条原消息"}',
                            '使用同一业务 ID，避免换新 ID 导致重复消息；也可以设计按 ID 查询结果的接口。',
                            ['恢复确认中', '查询幂等记录', '状态未知'],
                        ),
                        messageStage: 0,
                    },
                    {
                        ...step(
                            1,
                            0,
                            '返回原提交结果',
                            '{"type":"ACK","status":"persisted","messageId":"m-2","duplicate":true}',
                            '确认原消息已保存后更新状态，等待独立送达/已读事件；本场景没有证明 Bob 已收到。',
                            ['已保存', '未重复保存', '仍待确认'],
                        ),
                        messageStage: 2,
                    },
                ],
            },
        },
    };

    // 三、提交消息与待投递事件的事务边界决定崩溃后能否恢复。
    scenes.persistence = {
        name: '持久化与崩溃',
        layer: '可靠存储',
        title: '服务端突然重启，消息还能找回来吗？',
        description:
            '教学模拟：展示事务、幂等键、transactional outbox 与崩溃恢复。这里不会执行 SQL 或创建数据库，真实 Java 服务仍使用内存映射。',
        actors: ['发送客户端', 'IM 服务', '数据库 / Outbox'],
        source: null,
        takeaway:
            '持久化确认必须建立在提交成功之上。消息和待投递事件原子保存，崩溃后再重试投递，接收端继续去重。',
        quiz: {
            question: '数据库提交后、推送前服务崩溃，怎样恢复投递？',
            options: ['靠内存里的发送队列', '读取持久化 outbox 并重试', '假定对方已经收到'],
            answerIndex: 1,
            explanation:
                '原子保存的待投递事件不会随进程退出消失；重新投递可能重复，因此仍需接收端去重。',
        },
        variants: {
            recover: {
                name: '提交后崩溃 → 恢复投递',
                steps: [
                    step(
                        0,
                        1,
                        '提交带幂等键的消息',
                        'CHAT sender=alice clientMsgId=a-3',
                        '将用户身份与 clientMsgId 组成唯一业务键，保证同一消息重试可识别。',
                        ['等待提交 ACK', '开始事务', '待写入'],
                    ),
                    step(
                        1,
                        2,
                        '原子保存消息和 Outbox',
                        'BEGIN\nINSERT message (sender,clientMsgId,messageId,seq)\nINSERT outbox (eventId,messageId,status=pending)\nCOMMIT',
                        'SQL 为示意。两项写入在同一事务内，要么全部成功，要么全部回滚。',
                        ['等待 ACK', '事务提交成功', '消息与事件已保存'],
                    ),
                    step(
                        1,
                        0,
                        '提交成功后 ACK',
                        'ACK status=persisted messageId=m-3',
                        '服务端不能在事务失败时返回 persisted；ACK 与实际持久化保证要一致。',
                        ['知道消息已保存', '尚未投递', 'Outbox pending'],
                    ),
                    step(
                        1,
                        1,
                        '故障：投递之前崩溃',
                        '[进程重启]\n内存清空\n数据库与 outbox 保留',
                        '持久化数据保留依赖存储本身的可靠性，这里假设数据库提交记录没有丢失。',
                        ['等待送达', '进程重启', 'Outbox pending'],
                    ),
                    step(
                        2,
                        1,
                        '重新读取待投递任务',
                        'SELECT outbox WHERE status=pending\nworker → 重新推送 m-3',
                        '任务需要有领取、重试和超时策略；本场景简化为读取持久化任务并重投。',
                        ['等待送达', '重试投递', '恢复 pending 事件'],
                    ),
                    step(
                        1,
                        2,
                        '完成投递任务',
                        '推送 / 下游确认（依策略）\nUPDATE outbox SET status=done',
                        '标记 done 的条件必须定义清楚，不能把入队或网络写入等同于用户已读。若标记前又崩溃，重投也应可去重。',
                        ['继续等待业务回执', '恢复流程完成', 'Outbox done'],
                    ),
                ],
            },
            rollback: {
                name: '提交失败 → 原样重试',
                steps: [
                    step(
                        0,
                        1,
                        '发送消息',
                        'CHAT clientMsgId=a-4',
                        '客户端等待服务端确认，不把本地 send 当作持久化成功。',
                        ['发送中', '处理请求', '准备事务'],
                    ),
                    step(
                        1,
                        2,
                        '事务失败并回滚',
                        'BEGIN\nINSERT message ...\nINSERT outbox ... → failure\nROLLBACK',
                        '假设本场景明确知道事务已回滚；如果提交结果不确定，则还需要按业务键查询或幂等重试。',
                        ['等待响应', '确认回滚', '没有新消息或任务'],
                    ),
                    step(
                        1,
                        0,
                        '返回可重试错误',
                        '{"type":"ERROR","code":"STORAGE_UNAVAILABLE","retryable":true}',
                        '拒绝伪造成功 ACK。客户端展示暂未发送，并使用退避策略控制重试频率。',
                        ['暂时失败 / 可重试', '未保存消息', '恢复中'],
                    ),
                    step(
                        0,
                        1,
                        '同一个业务 ID 重试',
                        'CHAT clientMsgId=a-4\n原正文保持不变',
                        '重试保留唯一键；若原事务实际已经提交，唯一约束可防止重复保存。',
                        ['重试中', '校验幂等键', '可用'],
                    ),
                    step(
                        1,
                        0,
                        '真正提交后确认',
                        '事务提交成功\nACK status=persisted messageId=m-4',
                        '此时才进入已保存状态，接收方送达仍由后续链路处理。',
                        ['已保存', '提交成功', '消息与 outbox 存在'],
                    ),
                ],
            },
        },
    };

    // 四、增量同步游标与历史分页游标不能混用，也不应依赖客户端时间戳。
    scenes.synchronization = {
        name: '同步与历史',
        layer: '数据恢复',
        title: '重连补消息，向上翻历史，分别如何工作？',
        description:
            '教学模拟：使用连续会话序号做重连补齐，用不透明游标做历史分页。示例只是一种自定义方案；Matrix 使用自己的同步 token 与分页接口。',
        actors: ['客户端', '同步 / 历史服务', '会话记录'],
        source: matrixSource,
        takeaway:
            '同步恢复的是缺失增量，分页读取的是历史区间。两者都要检查权限、排序、边界和幂等合并。',
        quiz: {
            question: '收到 seq=103，可以直接把连续游标从 100 改成 103 吗？',
            options: ['可以', '先确认 101 和 102 已补齐', '改成客户端当前时间'],
            answerIndex: 1,
            explanation: '连续游标不能跨过未补齐的缺口，否则后续按游标恢复可能漏掉消息。',
        },
        variants: {
            reconnect: {
                name: '分批补齐与增量追赶',
                steps: [
                    step(
                        0,
                        1,
                        '重连后提交连续游标',
                        'SYNC conversation=alice-bob afterSeq=100 limit=2',
                        '本地记录最后连续已合并的会话序号，不用最新气泡时间来推断缺失范围。',
                        ['lastSeq=100', '检查会话权限', '记录至 104'],
                    ),
                    step(
                        1,
                        2,
                        '权限通过后读取增量',
                        'allowed=true\nquery seq > 100 ORDER BY seq LIMIT 2',
                        '查询顺序由可信的服务端会话序号决定，客户端时间可能偏差。',
                        ['等待补齐', '按序读取', '返回 101、102'],
                    ),
                    step(
                        1,
                        0,
                        '返回第一批',
                        'SYNC_RESULT seq=[101,102]\nhasMore=true nextCursor=<cursor-102>',
                        '客户端合并后推进到 102。hasMore 表示仍需继续获取；游标语义由服务端定义。',
                        ['合并至 102', '还有后续', '保留 103、104'],
                    ),
                    step(
                        0,
                        1,
                        '继续请求后续批次',
                        'SYNC cursor=<cursor-102> limit=2',
                        '同步过程中仍可能收到实时推送，需统一按 messageId 去重并识别缺口。',
                        ['追赶中', '继续读取', '返回 103、104'],
                    ),
                    step(
                        1,
                        0,
                        '完成追赶',
                        'SYNC_RESULT seq=[103,104]\nhasMore=false\nclient contiguousSeq=104',
                        'hasMore=false 只表示当前查询边界下没有更多，不代表未来不会有新消息。',
                        ['已补齐至 104', '切回实时增量', '当前记录至 104'],
                    ),
                ],
            },
            history: {
                name: '历史分页与权限拒绝',
                steps: [
                    step(
                        0,
                        1,
                        '向上翻历史',
                        'HISTORY conversation=room-1 beforeCursor=<cursor-101> limit=3',
                        '分页游标是服务端定义的不透明边界，不是客户端可随意解码的权限凭据。',
                        ['查看较早消息', '检查访问范围', '有历史记录'],
                    ),
                    step(
                        1,
                        2,
                        '应用历史可见性策略',
                        'member=true\nhistoryVisibility=joined\nallowed range=加入之后的事件',
                        '当前是成员不一定能读取加入前的全部历史；权限策略必须覆盖历史范围。',
                        ['等待结果', '计算可见区间', '排除无权记录'],
                    ),
                    step(
                        1,
                        0,
                        '返回较早的一页',
                        'HISTORY_RESULT seq=[98,99,100]\nnextBeforeCursor=<cursor-98>',
                        '客户端按序插到列表前方，并按 messageId 与已有记录去重。',
                        ['显示 98–100', '游标指向更早', '可继续分页'],
                    ),
                    step(
                        0,
                        1,
                        '尝试读取不属于自己的会话',
                        'HISTORY conversation=private-room',
                        '同一个 token 无权越过会话访问边界，不能因是查询操作而省略授权。',
                        ['请求其他会话', '重新检查权限', '私人会话'],
                    ),
                    step(
                        1,
                        0,
                        '拒绝未授权历史请求',
                        'ERROR code=FORBIDDEN\n不返回消息内容',
                        '拒绝时不暴露历史内容；合法分页与权限拒绝需要不同的页面提示。',
                        ['无权读取', '没有泄露数据', '私人会话不变'],
                    ),
                ],
            },
        },
    };

    // 五、同用户的多个设备与对方设备是不同的投递目标。
    scenes.multidevice = {
        name: '多设备同步',
        layer: '设备一致性',
        title: '手机和电脑同时在线，消息与已读怎么一致？',
        description:
            '教学模拟：一个用户对应多台已认证设备，分别保存同步游标，再合并账号级已读状态。当前真实 Java 服务仍采用同用户新连接替换旧连接。',
        actors: ['Alice 手机', 'IM 服务端', 'Alice 电脑', 'Bob'],
        source: matrixSource,
        takeaway:
            '设备接收状态与账号阅读状态需要分别设计。示例账号已读游标采用单调最大值，设备游标各自独立。',
        quiz: {
            question: '电脑离线，手机已读 seq=105，电脑重连时能把账号已读退回 100 吗？',
            options: ['可以，最后写入覆盖', '不可以，示例采用单调最大值', '删除手机记录即可'],
            answerIndex: 1,
            explanation: '迟到的旧设备状态不应让已读回退；账号读游标与设备同步游标是不同字段。',
        },
        variants: {
            fanout: {
                name: '消息同步到所有设备',
                steps: [
                    step(
                        0,
                        1,
                        '手机认证并登记设备',
                        'AUTH user=alice deviceId=phone-A\nserver registry: alice → [phone-A]',
                        '同用户允许多设备时，在线索引要从一个连接扩展为多个设备会话。',
                        ['已认证', '登记 phone-A', '离线', '在线'],
                    ),
                    step(
                        2,
                        1,
                        '电脑认证并登记设备',
                        'AUTH user=alice deviceId=desktop-A\nserver registry: alice → [phone-A,desktop-A]',
                        'deviceId 需要绑定已验证身份，不能让任意用户冒用已有设备凭据。',
                        ['在线', '登记两台设备', '已认证', '在线'],
                    ),
                    step(
                        3,
                        1,
                        'Bob 发来消息',
                        'CHAT to=alice clientMsgId=b-5\n提交后 messageId=m-5 seq=105',
                        '先保存会话消息，再根据用户与设备表找到多个投递目标。',
                        ['待接收', '消息已保存', '待接收', '等待回执'],
                    ),
                    step(
                        1,
                        0,
                        '投递到手机',
                        'MESSAGE id=m-5 seq=105\nrecipientDevice=phone-A',
                        '手机按消息 ID 去重，推进自己的连续同步游标。',
                        ['设备游标=105', '手机已投递', '待接收', '未必已读'],
                    ),
                    step(
                        1,
                        2,
                        '投递到电脑',
                        'MESSAGE id=m-5 seq=105\nrecipientDevice=desktop-A',
                        '电脑独立接收同一条业务消息。跨设备接收顺序不应影响会话显示顺序。',
                        ['设备游标=105', '两设备已投递', '设备游标=105', '未必已读'],
                    ),
                ],
            },
            readSync: {
                name: '已读同步与旧设备状态',
                steps: [
                    step(
                        0,
                        1,
                        '手机阅读会话',
                        'READ_UP_TO conversation=alice-bob seq=105 device=phone-A',
                        '示例确认整个会话直到某个连续位置已读；具体语义应由产品明确。',
                        ['已读至 105', '准备合并游标', '离线 / 已读至 100', '等待已读'],
                    ),
                    step(
                        1,
                        1,
                        '单调合并账号级游标',
                        'accountReadSeq=max(oldReadSeq,105)=105',
                        '同一会话内采用最大值可防止旧状态覆盖。未读数还需要按可见消息与产品规则计算。',
                        ['已读至 105', '账号已读至 105', '离线 / 旧状态', '等待已读'],
                    ),
                    step(
                        1,
                        3,
                        '通知 Bob',
                        'RECEIPT user=alice readUpToSeq=105',
                        '对方看到的是示例账号阅读进度，而不是某台设备的连接在线状态。',
                        ['已读至 105', '发出账号回执', '离线', '看到 Alice 已读'],
                    ),
                    step(
                        2,
                        1,
                        '电脑重连发送旧状态',
                        'SYNC deviceCursor=100\nREAD_UP_TO seq=100',
                        '设备同步需要补齐缺失消息；旧 READ 不应把账号已读进度退回。',
                        ['已读至 105', '忽略读游标回退', '补齐请求', '已读保持'],
                    ),
                    step(
                        1,
                        2,
                        '同步账号已读和缺失消息',
                        'STATE accountReadSeq=105\nSYNC_RESULT seq=[101..105]',
                        '电脑先合并消息，再同步账号状态；设备接收游标与账号阅读游标分别保存。',
                        ['状态一致', '账号已读至 105', '消息与已读同步', '已读保持'],
                    ),
                ],
            },
        },
    };

    // 未读计数采用明确示例规则：仅统计对方可见的内容消息，忽略自己发送和系统事件。
    scenes.multidevice.variants.unread = {
        name: '未读数计算与跨设备合并',
        steps: [
            step(
                1,
                0,
                '展示不同类型的会话事件',
                'seq=101 Bob 文本\nseq=102 Alice 自己发送\nseq=103 成员变更\nseq=104 Bob 图片\nseq=105 Bob 文本',
                '示例账号 readSeq=100；只有来自对方的三条可见内容消息计入未读，规则需由产品明确。',
                ['未读 3 条', 'readSeq=100 / eligible=3', '未读 3 条', '三条内容待阅读'],
            ),
            step(
                0,
                1,
                '手机确认已读到 104',
                'READ_UP_TO seq=104',
                '阅读游标关联会话序号，不按未读数字减一；一次阅读可覆盖多个事件。',
                ['读取至 104', '准备更新账号状态', '仍显示旧数值', '等待回执'],
            ),
            step(
                1,
                1,
                '从消息与游标重算',
                'accountReadSeq=max(100,104)=104\nunread=COUNT(eligible messages WHERE seq > 104)=1',
                '自己消息和系统事件不纳入本例计数。实际系统需要同时考虑可见性、删除/撤回与会话规则。',
                ['未读 1 条', 'readSeq=104 / unread=1', '等待状态更新', '已读至 104'],
            ),
            step(
                1,
                2,
                '电脑同步账号未读',
                'CONVERSATION_STATE readSeq=104 unreadCount=1',
                '电脑本地若收到迟到旧值，应按状态版本或单调游标合并，不能盲目最后写入覆盖。',
                ['未读 1 条', '账号状态一致', '未读 1 条', '已读至 104'],
            ),
            step(
                2,
                1,
                '电脑阅读最后一条',
                'READ_UP_TO seq=105',
                '电脑的阅读可更新账号级状态；设备接收游标仍是独立字段。',
                ['等待状态更新', '推进 readSeq=105', '阅读完成', '等待最新回执'],
            ),
            step(
                1,
                0,
                '向手机同步清零状态',
                'CONVERSATION_STATE readSeq=105 unreadCount=0',
                '未读清零来自阅读进度与计数规则，不应仅因为设备在线或数据同步完成而清零。',
                ['未读 0 条', '账号未读 0 条', '未读 0 条', '全部内容已读'],
            ),
        ],
    };

    // 六、群成员状态变更本身就是会话事件，投递策略需定义权限时点。
    scenes.groups = {
        name: '群聊与成员',
        layer: '群会话',
        title: '群里谁能发送、谁能收到、谁已经读了？',
        description:
            '教学模拟：成员权限、成员版本、群消息扇出和群已读。群消息的接收范围与历史可见性采用明确示例策略，不是所有 IM 产品的统一规则。',
        actors: ['Alice / 管理员', '群服务端', 'Bob', 'Carol'],
        source: matrixSource,
        takeaway:
            '群成员名单、角色、历史可见范围和投递目标都要定义。群“已读”通常是成员级进度，不能用一个布尔值覆盖所有人。',
        quiz: {
            question: 'Bob 已读一条群消息，可以显示全群已读吗？',
            options: ['可以', '不可以，需按成员分别统计', '只看群里是否有人在线'],
            answerIndex: 1,
            explanation:
                '一个成员的确认只代表这个成员，群已读需要明确参与统计的成员集合和各自进度。',
        },
        variants: {
            fanout: {
                name: '群权限 → 投递与已读',
                steps: [
                    step(
                        0,
                        1,
                        '发送到群会话',
                        'CHAT conversation=g-1 clientMsgId=a-6\nmemberVersion=7',
                        '目标是群会话，不是由客户端自行列出可信接收者名单。',
                        ['发送中', '校验群权限', '群成员', '群成员'],
                    ),
                    step(
                        1,
                        1,
                        '按成员版本确定目标',
                        'room memberVersion=7\nmembers=[alice,bob,carol]\nsenderPermission=allow',
                        '示例采用提交时成员快照，Alice 为发送者，Bob 和 Carol 是当前目标成员。',
                        ['允许发送', '提交 seq=201', '等待消息', '等待消息'],
                    ),
                    step(
                        1,
                        2,
                        '向 Bob 投递',
                        'MESSAGE room=g-1 seq=201 messageId=m-6',
                        '大群可以采用不同扇出或拉取策略，本例只展示简单逐成员投递。',
                        ['已保存', '投递 Bob', '收到消息', '等待消息'],
                    ),
                    step(
                        1,
                        3,
                        '向 Carol 投递',
                        'MESSAGE room=g-1 seq=201 messageId=m-6',
                        'Carol 离线时需要存储后同步；当前动画假设她在线。',
                        ['已保存', '投递 Carol', '收到消息', '收到消息'],
                    ),
                    step(
                        2,
                        1,
                        'Bob 确认阅读',
                        'READ room=g-1 user=bob readSeq=201',
                        '记录 Bob 的会话阅读进度，不把 Carol 的状态也改成已读。',
                        ['等待回执', 'Bob read=201', '已读', '未读'],
                    ),
                    step(
                        1,
                        0,
                        '显示部分成员已读',
                        'GROUP_RECEIPT message=m-6\nreadMembers=[bob] unreadMembers=[carol]',
                        '示例统计提交时除发送者之外的两名接收成员。真实统计要处理成员变更与隐私规则。',
                        ['1 / 2 位接收成员已读', '成员级状态', '已读', '未读'],
                    ),
                ],
            },
            removal: {
                name: '移除成员 → 权限版本更新',
                steps: [
                    step(
                        0,
                        1,
                        '管理员申请移除 Bob',
                        'MEMBER_REMOVE room=g-1 target=bob expectedVersion=7',
                        '服务端必须校验 Alice 的管理员权限；客户端自报 role=admin 不可信。',
                        ['管理员请求', '校验管理权限', '当前成员', '当前成员'],
                    ),
                    step(
                        1,
                        1,
                        '更新群状态版本',
                        '成员变更事务\nversion 7 → 8\nmembers=[alice,carol]',
                        '示例原子更新成员版本，用来处理旧请求、权限竞争和成员状态同步。',
                        ['变更已提交', '成员版本=8', '已移除', '仍是成员'],
                    ),
                    step(
                        1,
                        2,
                        '通知被移除成员',
                        'MEMBERSHIP room=g-1 state=left version=8',
                        '被移除客户端停止发群消息；服务端仍要独立检查之后每次请求的权限。',
                        ['管理员', '撤销群发送权限', '收到移除事件', '成员'],
                    ),
                    step(
                        2,
                        1,
                        'Bob 用旧状态继续发送',
                        'CHAT room=g-1 memberVersion=7',
                        '旧本地名单或旧版本号不能代替服务端当前权限；本例在提交时检查。',
                        ['管理员', '发现 Bob 非成员', '请求被拒绝', '成员'],
                    ),
                    step(
                        1,
                        2,
                        '拒绝并同步新版本',
                        'ERROR code=FORBIDDEN\ncurrentMemberVersion=8',
                        '移除后的新消息不再投递给 Bob；此前历史是否保留访问另由历史可见性策略规定。',
                        ['成员变更生效', '权限一致', '不能发新群消息', '成员'],
                    ),
                ],
            },
        },
    };

    // 七、消息内容、修改事件与短暂状态拥有不同的存储和同步语义。
    scenes.messageEvents = {
        name: '消息类型与事件',
        layer: '内容语义',
        title: '图片、撤回、编辑和“正在输入”，如何表示？',
        description:
            '教学模拟：附件先上传再引用，编辑/撤回是关联原消息的事件，输入状态是有有效期的临时信号。这里不上传文件，不实际修改真实聊天记录。',
        actors: ['Alice', 'IM / 文件服务', 'Bob'],
        source: matrixSource,
        takeaway:
            '持久化消息、针对消息的修改事件和临时状态分别定义语义。撤回无法保证已经看到或另存的内容消失。',
        quiz: {
            question: 'Bob 已把附件另存到本地，撤回能保证删除这份本地副本吗？',
            options: ['一定可以', '不能保证', '服务端删引用就一定删除'],
            answerIndex: 1,
            explanation:
                '服务端可以撤销访问和发送撤回事件，但无法可靠收回接收者已经看到、截图或另存的内容。',
        },
        variants: {
            attachment: {
                name: '图片 / 文件上传后引用',
                steps: [
                    step(
                        0,
                        1,
                        '申请上传并校验限制',
                        'UPLOAD_INIT name=photo.png bytes=2048 mime=image/png',
                        '服务端校验大小、访问权限和实际内容类型等；客户端 MIME 声明不等于文件已验证。',
                        ['准备附件', '校验上传请求', '尚未收到'],
                    ),
                    step(
                        0,
                        1,
                        '通过 HTTPS 上传文件',
                        'PUT <upload-url>\n<body: 文件字节，示意>',
                        '大文件通常走独立 HTTP 通道，此动画不发送任何文件。',
                        ['上传中', '接收 / 检查文件', '尚未收到'],
                    ),
                    step(
                        1,
                        0,
                        '返回附件引用',
                        'UPLOAD_OK mediaId=media-1 state=ready',
                        '引用表示服务端可管理的资源；访问仍要鉴权，签名 URL 的有效期与权限需要单独定义。',
                        ['附件就绪', 'media-1 ready', '尚未收到'],
                    ),
                    step(
                        0,
                        1,
                        '发送结构化附件消息',
                        '{"type":"CHAT","payload":{"kind":"image","mediaId":"media-1","width":320,"height":240}}',
                        '聊天消息包含资源引用和展示元数据，不必把整个图片 Base64 放入每条聊天报文。',
                        ['发送图片消息', '保存引用与消息', '等待消息'],
                    ),
                    step(
                        1,
                        2,
                        '接收者拉取可访问资源',
                        'MESSAGE kind=image mediaId=media-1\nGET /media/media-1（经授权）',
                        '消息权限和资源下载权限都需要检查；图片展示失败不应把文本会话同步游标混乱推进。',
                        ['等待业务回执', '检查资源访问', '显示图片 / 文件'],
                    ),
                ],
            },
            mutations: {
                name: '编辑、引用与撤回',
                steps: [
                    step(
                        0,
                        1,
                        '原消息提交',
                        'CHAT clientMsgId=a-7 text=你好\nmessageId=m-7 revision=1',
                        '稳定 messageId 让后续编辑、回复和撤回能指向同一实体。',
                        ['原消息已保存', '保存 revision=1', '已收到原文'],
                    ),
                    step(
                        0,
                        1,
                        '请求编辑',
                        'EDIT targetId=m-7 expectedRevision=1 text=你好 Bob',
                        '示例检查作者权限、编辑时限和版本；expectedRevision 防止无声覆盖冲突。',
                        ['请求修改', '校验作者与版本', '显示原文'],
                    ),
                    step(
                        1,
                        2,
                        '投递修改事件',
                        'MESSAGE_EDIT targetId=m-7 revision=2 text=你好 Bob',
                        '客户端按目标 ID 更新显示。事件先于原消息到达时，可缓冲并请求缺失原消息。',
                        ['修改已确认', '版本=2', '显示编辑标识'],
                    ),
                    step(
                        2,
                        1,
                        '回复时引用原消息 ID',
                        'CHAT text=收到 replyTo=m-7',
                        '引用信息是否展示原文取决于访问权限与被撤回后的产品策略，不直接信任客户端快照。',
                        ['等待回复', '校验引用可见性', '发送引用回复'],
                    ),
                    step(
                        0,
                        1,
                        '申请撤回',
                        'RECALL targetId=m-7',
                        '服务端校验撤回权限并保存撤回事件；撤回不等于所有终端已经抹除曾见过的信息。',
                        ['申请撤回', '记录撤回事件', '可能已阅读'],
                    ),
                    step(
                        1,
                        2,
                        '用撤回标记替换原文',
                        'MESSAGE_RECALL targetId=m-7\nUI: 该消息已撤回',
                        '客户端同步标记并处理原消息引用；离线设备重连时也应获取修改与撤回增量。',
                        ['已撤回', '事件可同步', '显示撤回标记'],
                    ),
                ],
            },
            ephemeral: {
                name: '正在输入 / 在线状态过期',
                steps: [
                    step(
                        0,
                        1,
                        '发布正在输入',
                        'TYPING conversation=alice-bob active=true ttlMs=5000',
                        '临时信号可节流，示例只保留 5 秒有效期，不作为历史聊天消息保存。',
                        ['正在输入', '校验会话权限', '尚未显示'],
                    ),
                    step(
                        1,
                        2,
                        '转发临时状态',
                        'TYPING user=alice expiresInMs=5000',
                        '接收者以收到的有效期或定义好的服务端时间语义设置本地过期逻辑，不能永久保留标识。',
                        ['正在输入', '临时状态有效', '看到正在输入'],
                    ),
                    step(
                        0,
                        0,
                        '故障：客户端突然掉线',
                        '[没有发送 active=false]',
                        '浏览器异常退出时，不保证能发送停止输入事件；因此需要租约 / 有效期兜底。',
                        ['离线', '等待过期', '仍短暂显示'],
                    ),
                    step(
                        2,
                        2,
                        '到期自动隐藏',
                        'now ≥ localDeadline\nUI: hide typing indicator',
                        '本场景逐步推进时间，动画不真实等待 5 秒。在线 presence 也需要定义连接与过期策略。',
                        ['离线', '状态到期', '输入标识已消失'],
                    ),
                ],
            },
        },
    };

    // 八、未知字段与未知类型有不同的兼容策略，协议版本不是装饰字段。
    scenes.evolution = {
        name: '协议版本与错误',
        layer: '兼容演进',
        title: '增加新功能，旧客户端还能正常聊天吗？',
        description:
            '教学模拟：能力协商、未知可选字段、未知必需类型、版本冲突与错误重试。这里给出一套自定义兼容策略，不代表当前 Java 服务已经支持版本协商。',
        actors: ['旧客户端 v1', '新服务端 v2', '协议 / 能力表'],
        source: null,
        takeaway:
            '把可选字段、必需能力、错误类型和重试条件写进协议约定。允许忽略未知可选字段不代表允许忽略未知业务命令。',
        quiz: {
            question: '收到 FORBIDDEN 错误，应立即无限重试吗？',
            options: ['应该', '不应该，先解决权限问题', '更换 messageId 重试即可'],
            answerIndex: 1,
            explanation: '权限拒绝不是瞬时网络故障；原样重试不会改变权限，还会增加系统负载。',
        },
        variants: {
            negotiate: {
                name: '能力协商与可选字段',
                steps: [
                    step(
                        0,
                        1,
                        '声明版本与能力',
                        'HELLO protocolVersion=1\ncapabilities=[text,read-receipt]',
                        '协议版本帮助确定消息结构，capabilities 细分可用功能；服务端不应仅凭版本号猜测全部功能。',
                        ['只支持文本和回执', '协商交集', '支持 text,image,edit,read-receipt'],
                    ),
                    step(
                        1,
                        0,
                        '返回兼容能力',
                        'HELLO_OK selectedVersion=1\nenabled=[text,read-receipt]',
                        '没有协商成功的功能不应直接发送给旧客户端，或应使用明确的降级方案。',
                        ['使用 v1 能力', '按会话能力路由', '保留兼容策略'],
                    ),
                    step(
                        1,
                        0,
                        '增加可选字段',
                        'MESSAGE id=m-8 text=hello\noptional: serverTraceId=trace-8',
                        '本示例约定旧客户端忽略未知可选字段，同时继续校验它认识的必需字段。',
                        ['正常显示文本', '新增追踪字段', '向后兼容'],
                    ),
                    step(
                        0,
                        1,
                        '不支持图片时采用降级',
                        'CHAT kind=text text=[图片，需升级客户端查看]',
                        '降级格式要由协议和产品明确，不能伪装成旧客户端已经正确解析了新类型。',
                        ['看到升级提示', '按能力降级', '未启用 image'],
                    ),
                ],
            },
            errors: {
                name: '未知命令、版本冲突与限流',
                steps: [
                    step(
                        0,
                        1,
                        '发送未知业务命令',
                        'COMMAND type=SUPER_EDIT id=req-9',
                        '未知命令不应当作普通成功消息处理，因为其副作用和语义无法确定。',
                        ['等待处理', '查找处理类型', '无此类型'],
                    ),
                    step(
                        1,
                        0,
                        '明确类型不受支持',
                        'ERROR code=UNSUPPORTED_TYPE refId=req-9 retryable=false',
                        '客户端停止原样重试，可以提示升级或改用已协商的功能。',
                        ['提示不支持', '没有副作用', '类型未启用'],
                    ),
                    step(
                        0,
                        1,
                        '提交旧版本编辑',
                        'EDIT targetId=m-9 expectedRevision=1\nserver revision=2',
                        '业务冲突与网络故障不同；需要重新同步、合并或让用户确认内容。',
                        ['旧编辑版本', '发现版本冲突', '当前 revision=2'],
                    ),
                    step(
                        1,
                        0,
                        '返回冲突而不是覆盖',
                        'ERROR code=CONFLICT currentRevision=2 retryable=false',
                        '不自动用旧正文覆盖新正文；重新读取后明确执行新的修改。',
                        ['需同步 / 合并', '原数据保留', 'revision=2'],
                    ),
                    step(
                        1,
                        0,
                        '展示另一类错误：限流',
                        'ERROR code=RATE_LIMITED retryable=true retryAfterMs=2000',
                        '这一步对照另一种错误语义；瞬时限流应遵守等待时间并使用退避，不能紧密循环。',
                        ['延后再尝试', '保护服务负载', '临时错误策略'],
                    ),
                ],
            },
        },
    };

    // 九、推送提醒与消息同步属于两条不同链路。
    scenes.mobilePush = {
        name: '移动离线推送',
        layer: '离线通知',
        title: 'App 不活跃时，聊天通知如何到达？',
        description:
            '教学模拟：APNs / FCM 的角色、平台接受与设备到达的区别，以及通知合并后的数据同步。没有连接推送平台，也不注册或保存真实设备 token。',
        actors: ['IM 服务端', 'APNs / FCM', '手机 App'],
        source: [
            '参考：FCM 消息与合并语义',
            'https://firebase.google.com/docs/cloud-messaging/customize-messages/collapsible-message-types',
        ],
        takeaway:
            '推送是提醒链路；平台接受不等于用户看到。聊天记录仍由经过认证的同步接口恢复，不能只依赖每一条通知完整到达。',
        quiz: {
            question: '推送平台返回请求成功，能直接显示“对方已读”吗？',
            options: ['可以', '不能，平台接受与业务已读不同', '只要是通知消息就可以'],
            answerIndex: 1,
            explanation: '推送可能延迟、被合并或设备未展示；设备接收和用户阅读都要有独立业务依据。',
        },
        variants: {
            notify: {
                name: '消息落库 → 推送 → 同步',
                steps: [
                    step(
                        2,
                        0,
                        '登记通知目标',
                        'register deviceId=phone-B pushToken=<demo-device-token>',
                        '真实系统将平台 token 绑定到已认证用户和设备，处理轮换与撤销；此处只有占位符。',
                        ['记录设备目标', '平台未调用', '设备已登记'],
                    ),
                    step(
                        0,
                        0,
                        '离线消息先保存',
                        'message=m-10 seq=110 persisted=true\nrecipient foreground connection=absent',
                        '消息事实存入 IM 存储，推送失败也不能导致消息丢失。App 后台行为和平台策略各不相同。',
                        ['保存成功 / 计划通知', '待请求', 'App 不活跃'],
                    ),
                    step(
                        0,
                        1,
                        '请求平台发送提醒',
                        'APNs: POST /3/device/<token>（示意）\n或 FCM messages:send\npayload: conversationId=alice-bob',
                        '这里只比较平台角色，两种 API 不能互换。可选择不在通知中包含敏感正文。',
                        ['等待平台接受', '处理请求', 'App 不活跃'],
                    ),
                    step(
                        1,
                        0,
                        '平台接受请求',
                        'APNs HTTP 200 / FCM 返回消息标识（示意）',
                        '成功说明平台接受请求，不证明设备立即收到、展示或用户已读；通知不是聊天消息送达确认。',
                        ['通知请求已接受', '调度投递', '可能仍未收到'],
                    ),
                    step(
                        1,
                        2,
                        '设备获得通知',
                        '设备展示通知 / 调度 App 回调（依平台与权限）',
                        '通知授权、网络、系统策略和消息类型影响设备处理；并不保证每次后台唤醒。',
                        ['等待业务同步', '尝试投递', '看到提醒 / 可能处理'],
                    ),
                    step(
                        2,
                        0,
                        '打开 App 后恢复数据',
                        'AUTH → SYNC afterSeq=109\n获取 message=m-10 seq=110\n用户阅读后另发 READ',
                        '通过业务同步获取权威消息，再按实际阅读行为确认已读。',
                        ['返回真实消息', '提醒链路完成', '已同步 / 独立确认阅读'],
                    ),
                ],
            },
            collapse: {
                name: '通知合并与无效设备 token',
                steps: [
                    step(
                        0,
                        1,
                        '连续发送同步提醒',
                        'collapseKey=conversation-alice-bob\n提醒 cursor=110、111、112',
                        '合并适用于“有新数据请同步”的提醒；若每一条事件都必须独立送达，不应假定合并能保留全部载荷。',
                        ['消息均已保存', '多个提醒待处理', '设备离线'],
                    ),
                    step(
                        1,
                        2,
                        '只保留较新的提醒',
                        'notification: latestCursor=112',
                        '示例合并为最新提醒，App 必须从自己的游标获取完整记录，而不是只保存通知里最后一条消息。',
                        ['保留完整历史', '通知已合并', '收到最新提醒'],
                    ),
                    step(
                        2,
                        0,
                        '按本地游标补全',
                        'SYNC afterSeq=109 → [110,111,112]',
                        '完整性来自消息存储和同步，不能来自可能被合并的通知序列。',
                        ['返回三条消息', '不提供聊天历史', '补全三条消息'],
                    ),
                    step(
                        1,
                        0,
                        '另一个设备目标已无效',
                        '平台错误：设备 token 无效 / 不再注册（示意）',
                        '按具体平台错误规则处理永久无效目标；不能把所有平台错误都当作用户账号失效。',
                        ['停用无效推送目标', '拒绝旧目标', '设备需更新 token'],
                    ),
                    step(
                        2,
                        0,
                        '设备重新登记新目标',
                        'register deviceId=phone-B pushToken=<new-demo-token>',
                        '通过已认证接口更新绑定；离线消息仍按同步游标恢复。',
                        ['更新目标绑定', '下次使用新目标', '目标重新登记'],
                    ),
                ],
            },
        },
    };

    // 十、端到端加密演示只解释信任边界和密钥状态，不用伪加密冒充安全实现。
    scenes.endToEnd = {
        name: '端到端加密',
        layer: '消息安全',
        title: 'WSS 已经加密，为什么还要端到端加密？',
        description:
            '教学模拟：对照传输加密与端点加密，观察设备身份验证和 MLS 成员变化。所有密钥、密文和密码学步骤均为占位说明，不执行真实加解密或 MLS，不构成安全实现。',
        actors: ['Alice 设备', '中继服务端', 'Bob 设备'],
        source: ['参考：MLS RFC 9420', 'https://www.rfc-editor.org/rfc/rfc9420.html'],
        takeaway:
            'TLS 保护每段传输；端到端加密把正文的加解密边界放在受信任端点。设备身份、密钥更新、备份和元数据隐私仍需单独设计。',
        quiz: {
            question: '只使用 WSS，服务端是否通常仍能读取业务明文？',
            options: [
                '不能，WSS 自动端到端加密',
                '能，除非正文另做端到端加密',
                '只要 masking 就不能',
            ],
            answerIndex: 1,
            explanation:
                'TLS 在服务端终止后可得到应用正文。端到端加密需由发送和接收端独立处理内容密钥与身份验证。',
        },
        variants: {
            boundary: {
                name: '传输加密 vs 端点加密',
                steps: [
                    step(
                        0,
                        1,
                        '仅有 WSS 的信任边界',
                        'Alice -- TLS --> 服务端\nTLS 解密后的应用正文：你好 Bob',
                        '这是普通传输加密的对照步骤，不代表本页面建立了 WSS；服务端通常能处理解密后的应用内容。',
                        ['网络链路加密', '可见应用正文', '待接收'],
                    ),
                    step(
                        0,
                        2,
                        '确认接收设备身份',
                        '获取 Bob 设备公钥 / 身份材料\n验证签名与可信指纹（示意）',
                        '获取到公钥不自动证明它属于 Bob。需要可信身份认证、密钥变更提示或带外指纹验证等机制。',
                        ['验证 Bob 设备', '只中继身份材料', '身份待确认'],
                    ),
                    step(
                        0,
                        0,
                        '端点协商并加密',
                        '经过认证的密钥协商（示意）\n明文=你好 Bob → <ciphertext-placeholder>',
                        '实际系统使用经过审查的协议与实现。本实验不生成密钥、共享秘密或真实密文。',
                        ['本地处理消息加密', '无正文密钥', '准备会话密钥'],
                    ),
                    step(
                        0,
                        1,
                        '发送端点加密后的载荷',
                        'ENCRYPTED_MESSAGE\nconversationId=alice-bob\nbody=<ciphertext-placeholder>',
                        '服务端可保存和路由密文，仍可能知道用户、会话、时间、长度等元数据；E2EE 不自动隐藏这些信息。',
                        ['正文已端点加密', '只能路由占位密文', '等待密文'],
                    ),
                    step(
                        1,
                        2,
                        '接收端验证并解密',
                        '验证消息认证 / 协议状态\n<ciphertext-placeholder> → 你好 Bob（示意）',
                        '只有满足协议身份与密钥状态的端点才能解密。设备本身被攻陷或明文被另存是其他风险边界。',
                        ['等待业务回执', '不解密正文', '端点得到明文'],
                    ),
                ],
            },
            membership: {
                name: 'MLS 成员移除与 epoch 更新',
                steps: [
                    step(
                        0,
                        2,
                        '当前组成员共享协议状态',
                        'MLS group epoch=11\nmembers=[Alice,Bob]\n密钥内容不展示',
                        'epoch 标识一个组状态时代；此处省略认证服务、KeyPackage、建组和 Welcome 的真实流程。',
                        ['epoch=11', '负责传递消息', 'epoch=11'],
                    ),
                    step(
                        0,
                        1,
                        '提出移除成员',
                        'MLS Remove Proposal target=Bob（概念示意）',
                        '移除还需要应用级权限检查。一个 Proposal 本身并不表示新组状态已经生效。',
                        ['准备移除 Bob', '中继 Proposal', '仍处于旧 epoch'],
                    ),
                    step(
                        0,
                        1,
                        '提交新的组状态',
                        'MLS Commit（纳入 Remove）\nepoch 11 → 12\n新 epoch 的秘密由协议推导',
                        'Commit 推进状态并更新密钥材料。此动画不生成真正的 MLS 消息，实际流程由符合规范的实现完成。',
                        ['进入 epoch=12', '中继 Commit', '被移除'],
                    ),
                    step(
                        0,
                        1,
                        '新 epoch 保护后续消息',
                        'MLS ApplicationMessage epoch=12\nbody=<new-epoch-ciphertext>',
                        '正确执行的协议让被移除成员无法取得后续 epoch 的应用秘密；移除不会让已经读到的旧内容消失。',
                        ['使用新状态加密', '路由新消息', '不持有 epoch=12 秘密'],
                    ),
                    step(
                        2,
                        2,
                        '被移除设备不能恢复新正文',
                        'Bob 仅持有旧 epoch 状态\n无法解密新 epoch 消息（概念）',
                        '此步骤展示能力边界，不代表服务端应该继续投递给被移除成员。应用路由也应按成员权限停止发送。',
                        ['成员移除已生效', '停止向 Bob 投递后续消息', '旧内容不会被收回'],
                    ),
                ],
            },
        },
    };
})(); // 数据已加入共享集合，播放器只读取这些场景，不调用外部服务。
