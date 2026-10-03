// Human and Agent reference share this content source. Paths marked proposed are not enabled runtime features.
export const guide = {
  "version": "2.0",
  "verifiedAt": "2026-10-03",
  "auditedCommit": "0040eb00",
  "mainBaseline": "c39c5e83",
  "title": "RemoteLab 记忆治理：从一次工作到项目共识",
  "goal": "让 Agent 在多人、多项目、多信源的工作中形成可追溯、经相应职责认可的组织认识；从同一份认识生成项目与个人视图，持续发现进展、风险和值得复用的方法。",
  "boundary": "现状依据当前实例与代码核实；拟议路径、归属规则和确认流程属于本次方案，尚未接入运行。网页里的案例均为虚构，不展示真实人员、群 ID、公司地址或聊天正文。",
  "findings": [
    [
      "一份项目记忆，多种信源",
      "讨论群、干活群和相关个人 Session 共同供给一个项目；话题和原始证据通过指针关联。"
    ],
    [
      "按用途存，按任务读",
      "项目认识、话题约定、个人偏好、公司事实和操作规则各有维护位置。目录提供导航，内容按本次任务读取。"
    ],
    [
      "日报回收反馈，共识回到原处",
      "项目日报、个人视图和组织日报从项目记忆派生。人的确认与纠正更新原条目及版本。"
    ]
  ],
  "scenarios": {
    "fresh": {
      "label": "新线程首次开工",
      "active": [
        "message",
        "startup",
        "turn",
        "harness",
        "library",
        "proof",
        "archive"
      ],
      "defaultNode": "startup",
      "summary": "自动提供：启动指针、适用的本轮来源与约定。按需读取：项目索引、偏好、任务、Skill 和证据。第一次开工也没有强制全盘检索。"
    },
    "resume": {
      "label": "同线程继续",
      "active": [
        "message",
        "native",
        "turn",
        "harness",
        "library",
        "proof",
        "archive"
      ],
      "defaultNode": "native",
      "summary": "复用原生线程的已有上下文；本轮来源和适用约定继续投影。文件已更新不代表旧上下文自动消失；涉及当前状态仍要查证。"
    },
    "rebuild": {
      "label": "换 Harness／重建线程",
      "active": [
        "message",
        "startup",
        "continuation",
        "turn",
        "harness",
        "library",
        "proof",
        "archive"
      ],
      "defaultNode": "continuation",
      "summary": "重建启动指针，并在有可用历史时提供有界延续。RemoteLab 保留归一化历史；原生 Harness 没有返回的隐藏上下文不能被完整重建。"
    }
  },
  "startGraph": {
    "height": 510,
    "nodes": [
      {
        "id": "message",
        "x": 20,
        "y": 206,
        "title": "当前请求",
        "subtitle": "谁说了什么，要做什么",
        "tag": "本轮输入",
        "text": "人的请求、附件和连接器来源分别保存。以本次目标为检索起点；群内一般讨论不自动构成执行授权。",
        "refs": [
          "source",
          "prompt"
        ]
      },
      {
        "id": "startup",
        "x": 264,
        "y": 20,
        "title": "启动指针",
        "subtitle": "bootstrap · projects · skills",
        "tag": "新线程自动提供",
        "text": "system-prompt 提供路径与能力目录，并检查入口是否存在，不读取记忆正文。bootstrap 是小导航；projects 是领域路由；skills 是方法入口；共享 system.md 同样按需读。",
        "paths": [
          "~/.remotelab/memory/bootstrap.md",
          "~/.remotelab/memory/projects.md",
          "~/.remotelab/memory/skills.md",
          "memory/system.md"
        ],
        "refs": [
          "startup",
          "prompt"
        ]
      },
      {
        "id": "native",
        "x": 264,
        "y": 144,
        "title": "原生线程延续",
        "subtitle": "Codex／Claude／Pi 的上下文",
        "tag": "继续线程时复用",
        "text": "RemoteLab 保存原生 resume 标识。Harness 负责自己的上下文管理与原生记忆。RemoteLab 的 Context 记录只能证明平台传了什么，不能证明 Harness 看见的全部内容。",
        "refs": [
          "prompt",
          "thin"
        ]
      },
      {
        "id": "continuation",
        "x": 264,
        "y": 268,
        "title": "有界历史交接",
        "subtitle": "归一化历史 · 既有延续头",
        "tag": "重建时有条件提供",
        "text": "没有可复用原生线程时，从可用历史或既有延续记录构造有界交接。workSummary 已存入会话元数据，但当前普通每轮前台不重新注入该短摘要。",
        "paths": [
          "实例配置/chat-history/<session>/",
          "Session.workSummary"
        ],
        "refs": [
          "continuation",
          "control",
          "prompt"
        ]
      },
      {
        "id": "turn",
        "x": 264,
        "y": 392,
        "title": "本轮来源与约定",
        "subtitle": "来源快照 · 适用 Session 约定",
        "tag": "本轮自动投影",
        "text": "投影当前 Request 的来源信息、连接器上下文、显式 Session 约定和可用本地桥接状态。具体内容取决于来源与配置；没有这些内容时不会凭空补齐。",
        "refs": [
          "turn",
          "source"
        ]
      },
      {
        "id": "harness",
        "x": 508,
        "y": 206,
        "title": "Harness 解释任务",
        "subtitle": "选择相关记忆与操作方法",
        "tag": "任务执行主体",
        "text": "选择读什么、怎样计划、如何用工具和验证结果，由当前 Harness 负责。治理测试层不能成为所有普通任务必须经过的第二个规划器。",
        "refs": [
          "thin"
        ]
      },
      {
        "id": "library",
        "x": 752,
        "y": 50,
        "title": "按需检索知识",
        "subtitle": "领域 · 偏好 · 任务 · Skill",
        "tag": "相关时读取",
        "text": "从索引进入相关文档或章节，再按需要查原始来源。项目主账与用户目录 projects.md 名字相似、职责不同。历史旁观信息和个人局部偏好不应升级成全局指令。",
        "paths": [
          "reference/current/",
          "reference/topics/",
          "model-context/preferences.md",
          "tasks/",
          "项目文档与 Skills",
          "project-knowledge/projects.md"
        ],
        "refs": [
          "activation",
          "targets"
        ]
      },
      {
        "id": "proof",
        "x": 752,
        "y": 206,
        "title": "查当前业务证据",
        "subtitle": "任务 · 作业 · 结果 · 验收",
        "tag": "状态问题需核对",
        "text": "任务系统保存行动状态，训练或评测系统保存运行与结果。报告称完成、文件存在、任务卡完成和验收通过分别记录。没有日志不等于没有工作。",
        "refs": [
          "daily",
          "thin"
        ]
      },
      {
        "id": "archive",
        "x": 752,
        "y": 362,
        "title": "追溯历史依据",
        "subtitle": "原文 · 历史版本 · archive",
        "tag": "需要追溯才读",
        "text": "保留旧方案和失败依据，帮助解释变化。旧事实带日期与被替代关系，不作为当前默认规则。检索到一段话还要判断它适用于谁、何时、什么工作。",
        "refs": [
          "activation"
        ]
      }
    ],
    "edges": [
      [
        "message",
        "startup"
      ],
      [
        "message",
        "native"
      ],
      [
        "message",
        "continuation"
      ],
      [
        "message",
        "turn"
      ],
      [
        "startup",
        "harness"
      ],
      [
        "native",
        "harness"
      ],
      [
        "continuation",
        "harness"
      ],
      [
        "turn",
        "harness"
      ],
      [
        "harness",
        "library",
        "按需"
      ],
      [
        "harness",
        "proof",
        "查证"
      ],
      [
        "harness",
        "archive",
        "追溯"
      ]
    ]
  },
  "collectGraphs": {
    "current": {
      "label": "目前的归集",
      "intro": "目前存在几条独立链路：会话组织、自动候选提炼、项目审阅与日报。它们尚未统一为逐条来源、版本和职责确认的组织认知层。",
      "height": 510,
      "nodes": [
        {
          "id": "result",
          "x": 20,
          "y": 88,
          "title": "本轮完成",
          "subtitle": "用户内容与助手结果",
          "tag": "已运行",
          "text": "正常轮次完成后触发后台处理。会话摘要、自动记忆评审、业务任务验收的目的不同。",
          "refs": [
            "writeback",
            "classifier"
          ]
        },
        {
          "id": "classify",
          "x": 264,
          "y": 20,
          "title": "会话分类",
          "subtitle": "标题 · 归类 · 短摘要",
          "tag": "后台异步",
          "text": "分类器整理 Session 的共享元数据和发起者的个人视图。它不继续任务，也不构成业务结果验收。",
          "refs": [
            "classifier"
          ]
        },
        {
          "id": "review",
          "x": 264,
          "y": 150,
          "title": "记忆评审",
          "subtitle": "截断对话 → 可复用线索",
          "tag": "后台异步",
          "text": "主要读取用户消息最多约 2000 字符、助手回答约 3000 字符。完整工具证据不直接输入；提炼后主要以短条目追加、按完全相同文本去重。",
          "refs": [
            "writeback"
          ]
        },
        {
          "id": "meta",
          "x": 508,
          "y": 20,
          "title": "Session 状态",
          "subtitle": "workSummary · personViews",
          "tag": "归类与恢复",
          "text": "保存短摘要与个人会话排列。项目认识不能只依赖生成摘要；原始证据和业务系统仍需保持可达。",
          "refs": [
            "control",
            "person"
          ]
        },
        {
          "id": "candidate",
          "x": 508,
          "y": 150,
          "title": "允许的写回目标",
          "subtitle": "用户候选 · 系统候选 · 任务",
          "tag": "配置决定",
          "text": "代码默认发现最多 24 个任务文档；配置按目标 ID 禁用或替换。在本次实例审计中仍有 3 个任务目标、用户 inbox 和系统候选目标；这不是只进 inbox。目标资格不等于内容已验收。",
          "paths": [
            "writeback-targets.json",
            "reference/inbox.md",
            "memory/auto-system-memory.md",
            "tasks/（依配置）"
          ],
          "refs": [
            "targets",
            "writeback"
          ]
        },
        {
          "id": "sources",
          "x": 20,
          "y": 362,
          "title": "已登记的项目来源",
          "subtitle": "讨论 · 录音 · 会话 · 评论",
          "tag": "实例项目流程",
          "text": "现有日报来源有明确白名单与排除范围，不能代表全组织覆盖。采集检查点、分页和失败记录属于本机项目审阅资料。",
          "refs": [
            "daily"
          ]
        },
        {
          "id": "ledger",
          "x": 264,
          "y": 362,
          "title": "项目认知主账",
          "subtitle": "认识 · 分歧 · 依据",
          "tag": "人工与 Agent 维护",
          "text": "将来源形成项目认识，保留改变结论的证据。用户目录的 projects.md 是导航；项目知识目录的 projects.md 是认知主账。",
          "paths": [
            "project-knowledge/projects.md"
          ],
          "refs": [
            "daily"
          ]
        },
        {
          "id": "daily",
          "x": 508,
          "y": 362,
          "title": "日报与项目说明",
          "subtitle": "日期视图 · 发布回执",
          "tag": "可读投影",
          "text": "日报解释现有任务与结果，出版、正文读回、评论绑定和送达分别核验。一个发布成功回执不能证明所有读者已收到或认可。",
          "paths": [
            "project-knowledge/daily/",
            "project-review/daily/",
            "project-review/publication-receipts/"
          ],
          "refs": [
            "daily"
          ]
        },
        {
          "id": "feedback",
          "x": 752,
          "y": 362,
          "title": "人的纠正与反馈",
          "subtitle": "评论 → 认识调整",
          "tag": "已有部分反馈链路",
          "text": "已有评论处理与局部修订。对每个条目、每个版本分别绑定项目负责人、相关个人和验收人的确认，仍是待建设能力。",
          "refs": [
            "daily"
          ]
        }
      ],
      "edges": [
        [
          "result",
          "classify"
        ],
        [
          "result",
          "review"
        ],
        [
          "classify",
          "meta"
        ],
        [
          "review",
          "candidate"
        ],
        [
          "sources",
          "ledger"
        ],
        [
          "ledger",
          "daily"
        ],
        [
          "daily",
          "feedback"
        ],
        [
          "feedback",
          "ledger",
          "纠正"
        ]
      ]
    },
    "target": {
      "label": "治理后的目标",
      "intro": "来源仍在原处；一份项目记忆持续核对、修订。日报与组织视图从同一主账版本派生，反馈回到原条目。来源、核验与确认是处理步骤，不是三本新的共识文档。",
      "height": 510,
      "nodes": [
        {
          "id": "sources",
          "x": 20,
          "y": 35,
          "title": "全部项目来源",
          "subtitle": "两群 · 个人 Session · 文档",
          "tag": "隔离测试先采集",
          "text": "从范围登记知道该读哪些来源，消费现有采集产物并记录覆盖缺口。未知关联先保留待归属，原文不写进共享项目知识仓库。"
        },
        {
          "id": "entry",
          "x": 264,
          "y": 35,
          "title": "项目入口与归属",
          "subtitle": "projectId · 本次关联依据",
          "tag": "导航与范围",
          "text": "群绑定给出默认范围，个人工作以明确项目／任务关联为依据；跨项目事项逐条关联。范围登记与导航、连接器配置保持同一来源。"
        },
        {
          "id": "memory",
          "x": 508,
          "y": 35,
          "title": "一份项目记忆",
          "subtitle": "条目 · 来源 · 版本 · 状态",
          "tag": "唯一认知维护位置",
          "text": "核对原文、业务系统与相应职责，形成共同认识和未决问题。确认属性保留在条目中；Agent 推断标为建议，不变成人的承诺。"
        },
        {
          "id": "views",
          "x": 752,
          "y": 35,
          "title": "项目／个人／总日报",
          "subtitle": "已确认 + 待核 + 观察",
          "tag": "同一版本的视图",
          "text": "日报同时支持沟通与反馈，但不成为新一级记忆。总日报直接汇总项目主账；项目待确认内容也可以呈现，不能因没回复从全局消失。"
        },
        {
          "id": "proof",
          "x": 264,
          "y": 220,
          "title": "话题与真实证据",
          "subtitle": "约定 · 原文 · 任务 · 验收",
          "tag": "按指针核验",
          "text": "话题约定保持局部；任务、作业、结果和现实验收由对应系统维护。项目记忆解释这些状态并引用证据，不建立另一套任务状态。"
        },
        {
          "id": "feedback",
          "x": 508,
          "y": 365,
          "title": "确认与纠正",
          "subtitle": "职责 · 事项 ID · 版本",
          "tag": "修订原处",
          "text": "项目负责人、相关个人和验收人分别确认所负责的事项。反馈更新项目条目；冲突、被替代关系和受影响确认保留历史。"
        },
        {
          "id": "observe",
          "x": 264,
          "y": 365,
          "title": "观察与好方法",
          "subtitle": "依赖 · 重复工作 · 风险",
          "tag": "项目内记录候选",
          "text": "巡检同时观察真实做法和跨项目问题。值得参考的一次实践即可登记，指向证据；优先级建议附依据，交负责人取舍。"
        },
        {
          "id": "frontier",
          "x": 20,
          "y": 365,
          "title": "外部前沿与经验",
          "subtitle": "内部问题 → 参考 → 验证",
          "tag": "后续接入",
          "text": "参考论文和官方材料，说明与具体内部问题的联系、适用条件和验证办法。外部论文结论不直接证明本组织方案有效。"
        }
      ],
      "edges": [
        [
          "sources",
          "entry"
        ],
        [
          "entry",
          "memory"
        ],
        [
          "proof",
          "memory",
          "核验"
        ],
        [
          "memory",
          "views"
        ],
        [
          "views",
          "feedback",
          "反馈"
        ],
        [
          "feedback",
          "memory",
          "修订"
        ],
        [
          "proof",
          "observe",
          "观察"
        ],
        [
          "frontier",
          "observe"
        ],
        [
          "observe",
          "memory",
          "带依据的建议"
        ]
      ]
    }
  },
  "layers": [
    {
      "id": "navigation",
      "title": "导航：入口与指针",
      "group": "session",
      "scope": "实例／项目范围",
      "status": "现有；范围登记拟建设",
      "paths": [
        "bootstrap.md",
        "projects.md",
        "skills.md",
        "拟议 project-registry.json"
      ],
      "read": "定位本次相关项目与材料",
      "write": "登记范围，生成导航与配置投影",
      "rule": "导航不是第二份主账。维护可定位的精确入口，断链与缺口显式可见。"
    },
    {
      "id": "session",
      "title": "过程：Session 与话题",
      "group": "session",
      "scope": "当前工作",
      "status": "现有；长期话题笔记按需",
      "paths": [
        "chat-history/<sessionId>/",
        "activeAgreements",
        "必要的 tasks/ 笔记"
      ],
      "read": "延续当前工作；需要追溯再读历史",
      "write": "事件保存过程，局部约定保持局部",
      "rule": "一 Session 不自动对应一个项目文件。原生上下文、平台事件和可复用认识分开。"
    },
    {
      "id": "project",
      "title": "认识：项目记忆",
      "group": "project",
      "scope": "一个项目；跨项目条目可引用",
      "status": "主账已有；条目治理拟建设",
      "paths": [
        "project-knowledge/projects.md#项目章节"
      ],
      "read": "项目相关任务；巡检读取全部登记项目",
      "write": "带来源、状态、版本和确认的增量修订",
      "rule": "每个项目一份认知主账。群、个人 Session 是信源；日报与个人／组织视图从同一版本派生。"
    },
    {
      "id": "background",
      "title": "背景：个人、公司与环境",
      "group": "knowledge",
      "scope": "相应的人／组织／实例",
      "status": "旧入口已有；个人／公司记录拟建设",
      "paths": [
        "reference/people/<personId>.md（拟议）",
        "reference/company.md（拟议）",
        "现有环境参考文档",
        "Person.preferences"
      ],
      "read": "身份、用途与本次任务匹配时",
      "write": "本人表达或可靠事实来源，保留范围与时间",
      "rule": "背景与项目记忆并列维护。产品设置不等于协作偏好，个人目录也不建立新的权限隔离。"
    },
    {
      "id": "rules",
      "title": "操作：规则与方法",
      "group": "methods",
      "scope": "工作区／仓库／适用场景",
      "status": "现有",
      "paths": [
        "AGENTS.md",
        "Skill／WORKFLOW",
        "memory/system.md"
      ],
      "read": "按 Harness 加载规则与本次方法需求",
      "write": "范围明确的稳定规则；有验证的方法改善",
      "rule": "AGENTS.md 放操作约束与入口，Skill 放方法。业务进展、公司位置、个人偏好不挤入这里。"
    },
    {
      "id": "evidence",
      "title": "依据：原文、候选与历史",
      "group": "knowledge",
      "scope": "来源／事项／审阅轮次",
      "status": "现有；测试隔离拟建设",
      "paths": [
        "连接器来源记录",
        "业务系统结果",
        "project-review/",
        "候选与历史版本"
      ],
      "read": "归集、核验、纠错、追溯时",
      "write": "保留原始出处、检查点、版本与处理结果",
      "rule": "候选没有自动生效资格。来源权限与保留要求影响派生内容，旧结论不能当当前指令。"
    }
  ],
  "gaps": [
    [
      "项目归属",
      "当前群对有显式绑定；个人侧栏分组与 workSummary 不足以证明项目归属。补范围登记和事项关联依据。"
    ],
    [
      "话题与项目边界",
      "当前 activeAgreements 有数量与长度上限。长材料走指针；局部约定晋升项目约定需要明确范围与相应确认。"
    ],
    [
      "自动写回边界",
      "当前真实目标并非只有 inbox。实施时用明确允许列表、测试标记和实际写入限制控制污染。"
    ],
    [
      "来源与纠正",
      "项目认识需要可定位出处、版本、状态与确认，支持更正、撤回、断链与并发修改。"
    ],
    [
      "观察与背景",
      "方法发现、重复工作、优先级建议纳入项目观察；个人偏好逐人核对，公司公共事实补维护位置。"
    ]
  ],
  "recordFields": [
    [
      "性质",
      "事实、口头报告、计划、承诺、结果、决定、Agent 判断、方法候选"
    ],
    [
      "归属",
      "项目与人员 ID；作者、提出人、执行者、记录者分别记录"
    ],
    [
      "来源",
      "原始引用与版本；转述沿同一来源谱系"
    ],
    [
      "时间",
      "发生时间、获知时间、生效及失效时间"
    ],
    [
      "状态",
      "业务执行状态、证据程度、确认状态分别维护"
    ],
    [
      "版本与传播",
      "版本、替代/冲突关系、职责确认、受影响视图与报告"
    ],
    [
      "可见范围",
      "来源权限与派生内容一致；公开说明不包含真实名单或私人偏好"
    ]
  ],
  "roles": [
    [
      "项目负责人",
      "目标、范围、优先级与跨项目依赖取舍"
    ],
    [
      "相关个人",
      "本人责任、时间与交付承诺，以及本人偏好"
    ],
    [
      "验收人",
      "标准与实际交付结果的验收"
    ]
  ],
  "phases": [
    {
      "label": "全覆盖测试",
      "enabled": "全部已登记项目：在独立测试根目录建立范围登记、来源覆盖、项目记忆副本和测试日报；同时观察好方法、依赖与重复工作。",
      "disabled": "新职责确认、个人外部推送、任务写入、业务执行、Skill 晋升与正式记忆写回暂时关闭。",
      "accept": "来源目录逐项说明已读、部分、不可读和排除；重放不重复，旧结论可追溯；测试无法污染正式记忆。"
    },
    {
      "label": "确认与反馈",
      "enabled": "对测试条目核验确认与纠正传播，再接入项目日报反馈；总日报直接从项目主账生成，已确认与待核均有清楚标记。",
      "disabled": "明确事实不要求所有人逐条点击；无回应不自动通过；新版本不能沿用已失效确认。",
      "accept": "对责任、范围和验收分别确认；纠正能传到受影响条目与视图，人的负担可接受。"
    },
    {
      "label": "受控进入正式协作",
      "enabled": "验收通过后逐项启用正式更新、方法推广和获授权的行动。",
      "disabled": "不增加所有普通任务必经的隐藏规划器，不凭建议改人的排期。",
      "accept": "相对原流程，事实错误与漏报减少、纠错更快、方法有真实复用收益，前台成功率与延迟不退化。"
    },
    {
      "label": "持续优化",
      "enabled": "新来源、真实失败、意见分歧和方法复用提供下一轮优化线索。",
      "disabled": "不按文档篇数、记忆大小或日报数量判断治理成功。",
      "accept": "每轮记录目标、改动、收益、代价和仍未知事项；以实际协作效果决定保留、修订或撤回。"
    }
  ],
  "isolation": "测试有独立存储、游标、索引、原生线程和记忆状态；服务端识别测试用途并跳过正式自动写回。写入限制由代码/权限保证，不能只靠提示词。复用现有读取能力，不启动第二个群消费者或 chat 控制面。并发、CPU、IO 和 token 有独立预算；前台不增加必经模型调用或全量记忆注入，观察到退化就暂停测试消费。上述隔离是实施要求，本页未部署该测试运行层。",
  "metrics": [
    [
      "认识是否准确",
      "来源覆盖、归属错配、事实错误、状态越级、过期结论与纠正传播时间"
    ],
    [
      "观察是否有用",
      "工作流漏报和误报、重复工作判断准确性、跨项目依赖发现、建议被采纳及其结果"
    ],
    [
      "协作是否更省力",
      "职责确认负担、无效打扰、交接与复用收益、前台任务成功率、延迟和资源成本"
    ]
  ],
  "demoRecords": [
    {
      "id": "示例-01",
      "project": "数据转换",
      "people": [
        "成员甲"
      ],
      "title": "转换脚本已提交",
      "execution": "产物已提交",
      "verification": "待独立验收",
      "source": "代码提交回执",
      "kind": "结果报告"
    },
    {
      "id": "示例-02",
      "project": "数据转换",
      "people": [
        "成员乙"
      ],
      "title": "训练作业已开跑",
      "execution": "进行中",
      "verification": "有运行证据",
      "source": "作业系统读回",
      "kind": "运行事实"
    },
    {
      "id": "示例-03",
      "project": "团队协作",
      "people": [
        "成员甲",
        "成员乙"
      ],
      "title": "To do 群 → 日报反馈的方法",
      "execution": "已实践",
      "verification": "方法候选",
      "source": "讨论与一次真实使用",
      "kind": "工作流线索"
    },
    {
      "id": "示例-04",
      "project": "团队协作",
      "people": [
        "成员乙"
      ],
      "title": "现场交互体验",
      "execution": "待现场验证",
      "verification": "待验证",
      "source": "原行动承诺",
      "kind": "待办"
    }
  ],
  "references": [
    {
      "id": "startup",
      "title": "启动上下文",
      "path": "chat/system-prompt.mjs",
      "use": "确认只提供位置与能力，不读取记忆正文"
    },
    {
      "id": "prompt",
      "title": "首轮、续接与收尾入口",
      "path": "chat/session-manager.mjs",
      "use": "确认 fresh/resume、逐轮投影与后台写回调用"
    },
    {
      "id": "turn",
      "title": "本轮上下文",
      "path": "chat/turn-context-hook.mjs",
      "use": "来源、桥接和显式约定；短摘要不普通每轮重注入"
    },
    {
      "id": "source",
      "title": "连接器 Context 契约",
      "path": "docs/connector-turn-context.md",
      "use": "Request 来源快照和投影可观察范围"
    },
    {
      "id": "continuation",
      "title": "有界延续",
      "path": "chat/session-continuation.mjs",
      "use": "历史选择与截断"
    },
    {
      "id": "control",
      "title": "会话状态投影",
      "path": "chat/session-control-state.mjs",
      "use": "workSummary 的保存与延续关系"
    },
    {
      "id": "classifier",
      "title": "后台会话分类",
      "path": "chat/session-state-classifier.mjs",
      "use": "会话组织与业务验收的区别"
    },
    {
      "id": "person",
      "title": "个人 Session 视图",
      "path": "chat/session-person-view.mjs",
      "use": "视图归类不等于个人记忆或访问隔离"
    },
    {
      "id": "personSettings",
      "title": "已有个人产品设置",
      "path": "lib/auth-config.mjs",
      "use": "Person.preferences 的保存与默认值规范化；不等于完整的协作偏好库"
    },
    {
      "id": "targets",
      "title": "写回目标发现",
      "path": "chat/memory-writeback-targets.mjs",
      "use": "任务发现、禁用配置与候选目标"
    },
    {
      "id": "writeback",
      "title": "自动记忆提炼",
      "path": "chat/session-memory-writeback.mjs",
      "use": "输入范围、追加与文本去重"
    },
    {
      "id": "activation",
      "title": "记忆激活边界",
      "path": "notes/current/memory-activation-architecture.md",
      "use": "指针与正文、存储与使用分开"
    },
    {
      "id": "thin",
      "title": "控制面与 Harness 分工",
      "path": "notes/current/thin-control-plane-architecture.md",
      "use": "保持 Harness 对普通任务的解释与执行权"
    },
    {
      "id": "daily",
      "title": "已出版日报的条件式读取",
      "path": "docs/feishu-daily-report-memory.md",
      "use": "仅配置的 Jev 路径读取有回执和 hash 的有界日报片段，不代表每个 Session 都读日报"
    },
    {
      "id": "preflight",
      "title": "可选启动知识探测",
      "path": "docs/session-start-preflight.md",
      "use": "它不是本地记忆检索或权限验收；本次实例配置未启用"
    },
    {
      "id": "history",
      "title": "Session 事件与正文存储",
      "path": "chat/history.mjs",
      "use": "事件文件、外置正文及有条件生成的上下文文件"
    },
    {
      "id": "config",
      "title": "实例数据路径",
      "path": "lib/config.mjs",
      "use": "配置、历史、Run、记忆目录的默认值和环境覆盖"
    },
    {
      "id": "agreements",
      "title": "话题工作约定",
      "path": "chat/session-agreements.mjs",
      "use": "最多 6 条、每条 240 字符的局部约定与本轮投影"
    },
    {
      "id": "links",
      "title": "两群项目绑定与近期片段",
      "path": "connectors/feishu/linked-project-context.mjs",
      "use": "projectId、双群绑定、项目流存储及消息选择边界"
    },
    {
      "id": "binding",
      "title": "群话题与 Session 绑定",
      "path": "connectors/feishu/session-flow.mjs",
      "use": "来源消息索引、conversation 解析与旧绑定兼容"
    },
    {
      "id": "connectorStore",
      "title": "连接器日志与索引位置",
      "path": "scripts/feishu-connector.mjs",
      "use": "storageDir 下的 events.jsonl、消息索引和现有采集流程"
    },
    {
      "id": "agents",
      "title": "仓库操作规则",
      "path": "AGENTS.md",
      "use": "稳定操作约束、共享实例权限与记忆指针，不能代替项目业务认识"
    }
  ],
  "external": [
    {
      "title": "Claude Tag：频道、工作区与话题的记忆边界",
      "url": "https://claude.com/docs/claude-tag/users/memory",
      "use": "官方按频道保存精选认识，并可回看话题；我们借鉴局部范围与原文指针，把两个相关群归到一个项目。按职责确认是本方案增加的治理机制。"
    },
    {
      "title": "LangGraph：线程与跨线程记忆",
      "url": "https://docs.langchain.com/oss/python/concepts/memory",
      "use": "借鉴当前工作与长期知识分开、按范围读取。采用这些原则，不要求替换 RemoteLab 现有 Harness 或引入框架。"
    },
    {
      "title": "Zep：事实的时间属性",
      "url": "https://help.getzep.com/facts",
      "use": "借鉴生效与失效时间、来源和事实更新。时间属性有助于判断新旧，不证明事实真实或已被人验收。"
    },
    {
      "title": "Microsoft：同一维护数据的不同读取视图",
      "url": "https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs",
      "use": "借鉴主账与读取视图分工。项目、个人、组织日报从同一认识派生；先沿用文件与已有系统，不引入全套事件溯源迁移。"
    }
  ],
  "maintenance": [
    "guide-data.js 是本说明的内容源；网页与 Agent 参考 Markdown 使用同一份内容。",
    "改存储、读取、写回、来源绑定或身份模型时，更新现状核对日期与代码依据；拟议路径和未上线能力持续标清。",
    "本机审计证据、真实用户与偏好留在认证实例；共享文档只描述架构和经过脱敏的示例。",
    "用真实问题验证治理效果，并记录仍未证明的部分；这份说明会随目标和实现继续修订。",
    "本次交付只更新说明和静态网页；真实项目登记、个人偏好迁移、公司事实补录与治理运行层另行实施。"
  ],
  "principles": [
    [
      "骨架保持简单",
      "项目索引 → 项目入口 → 项目记忆与相关话题／证据指针。来源、时间、确认与版本是条目的属性，不各自新造一层记忆。"
    ],
    [
      "群确定范围，项目拥有共识",
      "用稳定 projectId 绑定讨论群与干活群。群更名不改变项目身份；两个群的同一事项归到同一项目条目。"
    ],
    [
      "个人工作能贡献项目认识",
      "Session 有本次工作的归属，但其中的信息逐条归属。一个跨项目 Session 可以给多个项目贡献不同条目；个人闲聊不会整包进入项目主账。"
    ],
    [
      "背景与方法按需引用",
      "个人偏好、公司信息、AGENTS.md 和 Skill 是不同用途的旁路。与当前任务匹配时读取，项目文件不再复制它们的全文。"
    ],
    [
      "全项目采集先在隔离区运行",
      "覆盖全部已登记项目，同时显示未知与不可读来源。先生成测试共识与测试日报；正式写回、推送和业务动作分步启用。"
    ]
  ],
  "architectureGraph": {
    "height": 510,
    "nodes": [
      {
        "id": "index",
        "x": 20,
        "y": 20,
        "title": "项目索引",
        "subtitle": "项目 ID · 名称 · 入口指针",
        "tag": "导航",
        "text": "保留现有 projects.md 导航。范围登记表保存群与项目的绑定，导航从它生成；索引不再复制推进状态。",
        "paths": [
          "~/.remotelab/memory/projects.md",
          "拟议：配置目录/project-registry.json"
        ]
      },
      {
        "id": "entry",
        "x": 264,
        "y": 20,
        "title": "一个项目入口",
        "subtitle": "同一目标 · 两群 · 相关 Session",
        "tag": "范围明确",
        "text": "一个稳定 projectId 对应一个项目入口。讨论群和干活群属于同一项目；项目成员、职责、相关话题与记忆指针在这里可定位。"
      },
      {
        "id": "memory",
        "x": 508,
        "y": 20,
        "title": "一份项目记忆",
        "subtitle": "共同认识 · 进展 · 未决问题",
        "tag": "唯一认知主账",
        "text": "先沿用 project-knowledge/projects.md 的项目章节，加入稳定条目 ID 和来源、时间、版本、确认属性。文件变大后可以拆分项目文件，旧入口保留跳转；不同时维护两份主账。",
        "paths": [
          "project-knowledge/projects.md#项目章节"
        ]
      },
      {
        "id": "reports",
        "x": 752,
        "y": 20,
        "title": "日报与不同视图",
        "subtitle": "项目 · 个人 · 组织",
        "tag": "派生与反馈",
        "text": "组织汇总直接读取项目主账的同一版本。项目日报和个人视图只是筛选与解释；不要求先复制一遍项目日报再汇总一遍。反馈回到条目 ID 与版本。"
      },
      {
        "id": "groups",
        "x": 20,
        "y": 220,
        "title": "讨论群 + 干活群",
        "subtitle": "讨论 · 决定 · 执行回执",
        "tag": "项目的来源",
        "text": "原文留在飞书及现有连接器记录。近期跨群片段帮助当前对话，持久项目认识则进入项目主账；两者职责不同。"
      },
      {
        "id": "personal",
        "x": 264,
        "y": 220,
        "title": "相关个人 Session",
        "subtitle": "按事项关联项目",
        "tag": "项目的来源",
        "text": "明确涉及该项目的决定、承诺、结果和方法可以进入候选。记录归属依据与原始消息；项目关联不等于全部对话都应共享进项目。"
      },
      {
        "id": "topics",
        "x": 508,
        "y": 220,
        "title": "话题与证据指针",
        "subtitle": "局部约定 · 原文 · 结果系统",
        "tag": "细节留在原处",
        "text": "Session 事件保存过程；activeAgreements 保存当前局部约定。需要长材料时才建立任务笔记。项目条目链接到具体消息、章节、提交或结果；完整验收仍由业务系统维护。"
      },
      {
        "id": "background",
        "x": 264,
        "y": 365,
        "title": "个人与公司背景",
        "subtitle": "偏好 · 办公信息 · 公共事实",
        "tag": "相关时读取",
        "text": "个人写作偏好只影响相应人的任务，公司位置只在就餐、出行等场景读取。它们与项目记忆并列维护，通过用途和身份选择，不自动变成全局规则。"
      },
      {
        "id": "methods",
        "x": 752,
        "y": 365,
        "title": "规则与可复用方法",
        "subtitle": "AGENTS.md · Skill · WORKFLOW",
        "tag": "相关时读取",
        "text": "AGENTS.md 放所在工作区或仓库的稳定操作约束；Skill 放可重复执行的方法。项目观察先记录为方法候选，有独立复用证据后再完善 Skill。"
      }
    ],
    "edges": [
      [
        "index",
        "entry"
      ],
      [
        "entry",
        "memory"
      ],
      [
        "memory",
        "reports"
      ],
      [
        "groups",
        "memory",
        "形成认识"
      ],
      [
        "personal",
        "memory",
        "相关事项"
      ],
      [
        "memory",
        "topics",
        "追溯"
      ],
      [
        "topics",
        "methods",
        "方法沉淀"
      ]
    ],
    "routes": {
      "groups:memory": {
        "path": "M228 266 H246 V155 H612 V112",
        "x": 410,
        "y": 145
      }
    }
  },
  "storageCases": [
    {
      "id": "session",
      "label": "一个 Session",
      "question": "这次对话与执行过程存在哪里？",
      "current": {
        "paths": [
          "配置目录/chat-sessions.json",
          "配置目录/chat-history/<sessionId>/events/*.json",
          "配置目录/chat-history/<sessionId>/bodies/*.txt",
          "配置目录/chat-runs/<runId>/"
        ],
        "body": "元数据保存原生恢复标识、workSummary、personViews 等；events 保存归一化事件，大正文可外置到 bodies。原始 Run、工具执行和 Harness 原生上下文各有存储，不等于同一份完整记录。context.json、fork-context.json 仅在相应流程产生，不是每个 Session 都有。",
        "read": "继续同一原生线程时复用上下文；重建时可从可用事件形成有界交接。查历史事实时定位到具体事件并读取正文。",
        "write": "平台保存事件，后台分类器整理共享摘要与个人侧栏。摘要和侧栏分组均不证明项目归属或结果已经验收。"
      },
      "target": {
        "paths": [
          "沿用现有 Session 事件与 Run 存储",
          "拟议：配置目录/project-registry.json 中的 Session 关联"
        ],
        "body": "不为每个 Session 再造一本项目主账。登记默认项目及归属依据，项目条目引用 sessionId + 事件序号。跨项目工作按事项分别关联；不明确的关联保留待核。",
        "read": "先查本次请求的项目归属，再进入相应项目章节和话题依据。项目状态需要时核对当前业务证据。",
        "write": "原文仍在原处；与项目有关的认识写入该项目章节。个人偏好写入相应个人记录，操作过程留在事件中。"
      }
    },
    {
      "id": "group",
      "label": "一个群 / 两个群",
      "question": "群消息和“群记忆”分别在哪里？",
      "current": {
        "paths": [
          "飞书原始群消息与文档",
          "连接器 storageDir/events.jsonl",
          "连接器 storageDir/connector-message-index.json",
          "连接器 storageDir/project-message-streams/<项目 hash>.jsonl",
          "已提交 Request 的 sourceContext 与 Context 事件"
        ],
        "body": "连接器日志记录其接收到的来源，索引用于消息／话题与 Session 绑定。已配置项目对有一个较小的跨群消息流；文字每条最多 900 字符，供近期上下文使用。它不是完整聊天档案或经确认的群共识。未接收到的消息、不可读附件和被截断正文需要另外核对。",
        "read": "跨群输入当前按 24 小时、最多 20 条、总计 6000 字符选择；讨论→干活是默认方向，反向需明确配置。它不是语义检索。",
        "write": "现有消费者保存来源和投递回执；本次核实 bot-2 配置有一对项目群。其他来源覆盖不能由这一对推断。"
      },
      "target": {
        "paths": [
          "同一个 projectId 的项目记忆",
          "范围登记：讨论群 ID + 干活群 ID",
          "原始消息沿用现有来源存储"
        ],
        "body": "群是信源和范围锚点。两群共同维护一份项目共识，不各写一份群主账。群内新话题保留局部约定，项目级约定才进入项目记忆。",
        "read": "从群绑定直接定位项目入口，读取该项目的有效认识，再按话题补相关消息或证据。",
        "write": "接入已存在的群采集／散落讨论处理结果和覆盖回执，不启动第二个消费者。编辑、撤回、缺页及无权限来源要标记。"
      }
    },
    {
      "id": "topic",
      "label": "一个话题",
      "question": "话题约定会不会影响整个项目？",
      "current": {
        "paths": [
          "Session.activeAgreements（chat-sessions.json 内）",
          "Session 事件与来源快照",
          "已有 ~/.remotelab/memory/tasks/ 任务笔记"
        ],
        "body": "activeAgreements 本轮可投影，但最多 6 条、每条 240 字符；它承载局部生效约定，不是完整知识库。更长材料应保留正文和指针。",
        "read": "同话题执行读取有效局部约定与当前工作依据；历史方案需要追溯时再读。",
        "write": "当前明确的约定及原讨论保留在该 Session。已有任务笔记并非自动一 Session 一文件。"
      },
      "target": {
        "paths": [
          "沿用 activeAgreements 与 Session 事件",
          "必要时：~/.remotelab/memory/tasks/<sessionId>.md",
          "项目记忆中的话题指针"
        ],
        "body": "话题可以有自己的方法、临时目标与条件。只有影响整个项目、被相应职责确认的内容才晋升项目约定。长任务笔记按需要建，不给每个新话题增加空文档。",
        "read": "开新话题读取项目有效约定；只读与新任务有关的旧话题，不继承其他话题的临时限制。",
        "write": "局部更新仍在局部位置，项目入口更新相关指针。推广为项目约定时记录生效范围、依据与替代关系。"
      }
    },
    {
      "id": "project",
      "label": "一个项目",
      "question": "我们认可的推进情况以哪里为准？",
      "current": {
        "paths": [
          "~/.remotelab/memory/projects.md（导航）",
          "project-knowledge/projects.md（认知主账）",
          "project-knowledge/daily/YYYY-MM-DD.md（日期视图）",
          "project-review/（来源、检查点与出版回执）"
        ],
        "body": "同名 projects.md 有两个职责：一个带路，一个记录认识。项目认知不包含宿主机凭据、调度配置或原始聊天导出。现有日报来源有边界，尚不证明全组织覆盖。",
        "read": "相关项目工作读主账相应章节；审阅与纠错再查来源索引、原文和真实结果。",
        "write": "现有项目流程增量维护主账及日报。逐条版本、归属和职责确认仍需建设。"
      },
      "target": {
        "paths": [
          "同一 project-knowledge/projects.md 的稳定项目章节",
          "拟议：配置目录/project-registry.json",
          "同一主账派生的日报和个人视图"
        ],
        "body": "初期直接在现有项目章节中维护稳定条目：目标、有效决定、推进情况、依赖、未决问题与组织观察。每条有来源和版本。先不增加平行数据库或单独的“组织共识主账”。",
        "read": "读项目当前有效认识及相关条目；有疑问再沿指针查对应话题、原文或结果。",
        "write": "Agent 可整理、查证和提出修订。负责人确认范围与优先级，个人确认本人承诺，验收人确认实际结果。组织共识是这些项目认识的组合视图。"
      }
    },
    {
      "id": "person",
      "label": "个人偏好",
      "question": "怎么保留合作中的个人特点？",
      "current": {
        "paths": [
          "配置目录/auth.json 的 Person.preferences",
          "~/.remotelab/memory/model-context/preferences.md",
          "Session.personViews"
        ],
        "body": "Person.preferences 已有输入模式、语音快捷键等产品设置。旧 preferences.md 默认按机器／实例维护，不能当作每个人的偏好。personViews 是侧栏排列；默认值也不等于本人明确表达。",
        "read": "产品设置由界面使用；协作偏好需判断究竟是谁、适用于什么。",
        "write": "本人设置与已有人工维护。逐人、有来源的协作偏好库尚未建成。"
      },
      "target": {
        "paths": [
          "拟议：~/.remotelab/memory/reference/people/<personId>.md",
          "产品设置继续在 Person.preferences"
        ],
        "body": "记录本人明确表达的写作、沟通、工作习惯和适用条件，保留来源与生效时间。根据已核对的 Person／外部身份选择；多人共用账号、机器用户名或 Session 创建者都不能自动代表每条消息的作者。",
        "read": "本次协作确实涉及该人的偏好时读对应记录，不加载全员偏好。群输出使用已认可的群／项目要求。",
        "write": "本人明确的修改可更新偏好；转述或 Agent 推断先作为待核候选。一次“这篇写短些”默认只约束本次任务。"
      }
    },
    {
      "id": "company",
      "label": "公司信息",
      "question": "办公位置、时区等公共背景放哪里？",
      "current": {
        "paths": [
          "现有相关文档或原始讨论（需核实）"
        ],
        "body": "本次核对的常用记忆入口中，未找到有来源、持续维护的公司信息主文档。这不代表历史讨论中从未提过。办公地址、常用集合点等现在仍需来源核对，不能凭模型猜测。",
        "read": "具体就餐或出行问题用已知事实；缺少影响方案的地点时再补问。",
        "write": "还没有核实到统一维护位置。"
      },
      "target": {
        "paths": [
          "拟议：~/.remotelab/memory/reference/company.md"
        ],
        "body": "维护公司公开名称、时区、办公室／集合点、常用场地及适用时间。事实与组织制度分开；联系人、门禁与精确敏感位置按已有实例边界保存，不进入公开说明或共享源码。",
        "read": "就餐、出行、访客接待和会议安排相关时读取。普通代码任务不需要公司地址。",
        "write": "指定维护人或可靠原始资料更新，记录来源与更新时间；办公地点变化使旧条目失效。实际信息仍待补全，本页只有字段方案。"
      }
    },
    {
      "id": "agents",
      "label": "AGENTS.md",
      "question": "哪些记忆可以成为 Agent 的操作规则？",
      "current": {
        "paths": [
          "工作区 AGENTS.md",
          "仓库及子目录 AGENTS.md",
          "Harness 自身的加载规则"
        ],
        "body": "本项目使用 AGENTS.md 作为仓库内 AI 操作说明。它可以约束相关目录的编辑、验证与交付；具体加载由 Harness 决定，RemoteLab 的启动指针不证明它已被读取。",
        "read": "进入相应工作区或仓库时按 Harness 规则加载；必要时明确查相关文件。",
        "write": "维护仓库规则时审阅并走其版本控制流程。自动记忆候选不等于批准修改指令文件。"
      },
      "target": {
        "paths": [
          "沿用相应范围的 AGENTS.md",
          "深层知识通过指针引用"
        ],
        "body": "适合存：稳定操作约束、项目维护入口、验证和交付规则。项目状态、个人口味、公司地址、聊天原文与一次事故排障均回到各自维护位置。规则明确适用范围与出处，不能把事实或讨论当成操作授权。",
        "read": "工作区／仓库相关时加载稳定规则，沿指针按需读深层文档。AGENTS.md 不承载全组织业务记忆。",
        "write": "跨任务稳定、范围明确、已经认可的操作要求才整理为规则；项目要求先进入该项目适用的说明，不因有用就晋升工作区通用规则。这里把你说的 agent.md 按现有 AGENTS.md 理解；普通同名文件不会自动获得加载能力。"
      }
    },
    {
      "id": "method",
      "label": "经验 / Skill",
      "question": "好的工作流在哪里被发现和沉淀？",
      "current": {
        "paths": [
          "现有 Skills 与 WORKFLOW",
          "项目原始讨论和真实执行记录"
        ],
        "body": "已有可调用方法，但组织内有价值的实践未必进入了方法目录。没有候选记录不能推出没有优秀流程。",
        "read": "遇到相关任务读取已有 Skill／WORKFLOW，再查真实案例。",
        "write": "沿当前方法维护流程修订；执行记录本身不自动变成通用 Skill。"
      },
      "target": {
        "paths": [
          "项目记忆中的方法候选条目",
          "经验证的现有 Skill／WORKFLOW"
        ],
        "body": "巡检时就记录有用案例、适用问题、步骤、收益、前提与反例，链接原始执行。涉及多个项目时保持一个案例身份，相关项目用指针引用。",
        "read": "先比较现有方法，检查是否重复或互补；任务匹配时复用。",
        "write": "一次真实有用实践可成为候选。独立复用证明适用性后再完善 Skill，并记录失败条件；不要求等到方法成熟才发现它。"
      }
    },
    {
      "id": "candidate",
      "label": "自动候选 / 历史",
      "question": "提炼出来就会立刻影响新 Session 吗？",
      "current": {
        "paths": [
          "~/.remotelab/memory/reference/inbox.md（本实例用户候选）",
          "源码 memory/auto-system-memory.md（系统候选）",
          "writeback-targets.json 与其实际目标目录",
          "原始来源与历史版本"
        ],
        "body": "当前目录仍允许 3 个任务目标，以及用户和系统候选目标。后台评审主要看截断的用户／助手文本，不含完整工具证据；按相同文本去重。不能把“只进 inbox”的说明当作已经强制执行的边界。",
        "read": "治理或追溯时读取候选；不作为无条件生效指令。",
        "write": "由现有代码和实例配置决定。本次没有调整这些运行目标。"
      },
      "target": {
        "paths": [
          "隔离测试根目录中的候选、检查点与测试主账",
          "正式内容仍回到相应项目／个人／公司／方法位置"
        ],
        "body": "提炼只是候选。分类、归属、来源核验与必要确认后，写入唯一维护位置；旧版本保留替代关系。新测试层用代码和写入权限阻止污染正式记忆，不能只靠“请勿写回”的提示。",
        "read": "工作任务读当前有效内容；候选与旧版本在明确需要核验或追溯时读取。",
        "write": "写入边界改成明确允许列表；测试不会写正式 AGENTS.md、偏好、项目主账或活动 Skill。来源更正／撤回要传到派生条目和视图。"
      }
    }
  ],
  "registryFields": [
    [
      "项目身份",
      "稳定 projectId、展示名称和别名、唯一记忆入口；群更名只改变展示。"
    ],
    [
      "信源范围",
      "连接器／租户／群 ID、讨论或干活用途、可读资料入口和排除理由；绑定带生效时间与版本。"
    ],
    [
      "相关话题",
      "Session ID、默认项目、关联理由与待核／已明确状态；本轮跨项目事项另外标注。"
    ],
    [
      "职责与维护",
      "项目负责人、成员与验收职责对应已核对 Person／外部身份；关联由谁更正、何时生效可追溯。"
    ]
  ],
  "scopeRules": [
    [
      "最强依据：明确归属",
      "用户本轮明确指定的项目与事项归属优先；持续的来源绑定先核对是否被明确纠正。若本轮与群默认项目不同，记录为跨项目事项，不静默搬走整个群。"
    ],
    [
      "群内新话题：沿群绑定",
      "以连接器／租户／群 ID 查范围登记，讨论群和干活群解析为同一 projectId。群名只作展示，不作唯一键。"
    ],
    [
      "个人 Session：沿明确工作关联",
      "明确指定项目，或引用已绑定的任务、项目入口、话题时建立关联并记录依据。仅有语义相似、侧栏 group 或历史标题时只提出候选关联。"
    ],
    [
      "混合 Session：逐事项归属",
      "Session 可有默认项目，但条目可同时关联多个项目或人员。共同依赖保存同一事项身份，由相关项目引用，避免重复算两次完成。"
    ],
    [
      "未知项目：暂存待归属",
      "可以继续当前工作并保留原文，候选进入待归属区。不会靠猜测写入某个正式项目，也不把所有未知内容丢进通用记忆。"
    ],
    [
      "归属变化：保留来历",
      "更正关联会更新受影响条目和视图，并保留旧关联与理由。分叉 Session 保留来源谱系；复制上下文不新增独立证据或人的确认。"
    ]
  ],
  "routeExamples": [
    {
      "id": "group-topic",
      "label": "群内开新话题",
      "input": "在“项目甲干活群”开一个转换脚本话题；讨论群已绑定同一个项目。",
      "route": "项目甲；话题保持独立的 Session 身份。",
      "basis": "来源绑定：连接器 + 群 ID → projectId。不需要再根据标题猜一次。",
      "store": "原文 → Session 事件与群来源；临时约定 → 话题；项目有效决定／结果 → 项目甲主账。",
      "read": "项目甲入口与有效项目约定 → 本话题任务与证据 → 匹配的仓库规则／方法。不会自动读项目乙全部历史。"
    },
    {
      "id": "personal-work",
      "label": "个人在项目外开工",
      "input": "成员甲在 Web 新开 Session，明确说“继续项目甲的数据转换任务”。",
      "route": "关联项目甲；本人身份与实际发言身份另行核对。",
      "basis": "本轮明确项目 + 已有任务指针。侧栏分类只帮助显示。",
      "store": "工作过程 → 原 Session；项目结果 → 项目甲条目并引用事件；“以后报告先说结论”的本人偏好 → 成员甲偏好记录。",
      "read": "项目甲相关认识 + 对应任务；确与输出有关时读成员甲写作偏好，不读其他人的偏好。"
    },
    {
      "id": "cross-project",
      "label": "一个话题涉及两项目",
      "input": "项目甲与项目乙讨论共用一个评测流程，需要避免重复建设。",
      "route": "同一依赖／方法事项关联项目甲、乙，分别显示角色与影响。",
      "basis": "已核对的共同任务、来源和相关项目责任；一个事项 ID，多个项目引用。",
      "store": "原讨论只保留原出处；共同事项指定一个维护项目／位置，另一项目用指针引用。各项目自己的承诺仍分别记录。",
      "read": "两项目与该事项相关的认识和证据；不全盘加载两项目所有 Session。"
    },
    {
      "id": "unknown",
      "label": "暂时无法归属",
      "input": "个人说“那个测试还没跑完”，未提供项目或任务；侧栏曾被自动分到项目甲。",
      "route": "待归属；不据侧栏认定项目甲，也不认定测试失败。",
      "basis": "语义与旧分组只有线索，缺可核对事项。",
      "store": "原文保留；候选带待归属标记。后续补足任务关联后再进入项目记忆。",
      "read": "先查本 Session 直接相关的前文和明确指针；仍不清楚时只补问影响归属的事项。"
    }
  ],
  "readingCases": [
    {
      "id": "new-group",
      "label": "群内新话题",
      "steps": [
        [
          "识别范围",
          "从本轮 sourceContext 与群绑定解析项目，核对是否有本轮明确的跨项目指定。"
        ],
        [
          "定位项目",
          "读项目入口和与本次任务有关的有效约定、推进状态、待核事项；按条目定位，不只读长文头尾。"
        ],
        [
          "读局部工作",
          "读当前话题约定、任务材料和需要延续的具体旧话题。临时约定不会横向传给其他话题。"
        ],
        [
          "补方法与依据",
          "相关仓库 AGENTS.md、Skill／WORKFLOW 按任务读取；当前状态向任务、结果或验收系统查证。"
        ]
      ],
      "skip": "其他项目、全员偏好、公司地址、全部历史日报通常无需读取。"
    },
    {
      "id": "new-person",
      "label": "个人新 Session",
      "steps": [
        [
          "核对人和工作",
          "用可信身份和当前请求确定相关个人；明确项目或已绑定任务给出归属。"
        ],
        [
          "进入项目入口",
          "归属明确就读取对应项目认识；未知先保留待归属，不猜一个项目。"
        ],
        [
          "应用相关偏好",
          "写作或协作任务读取这个人的适用偏好；本人本次明确要求在适用范围内替代旧偏好。"
        ],
        [
          "追溯与执行",
          "用话题、任务、仓库和结果指针补齐需要的材料，由 Harness 解释并执行任务。"
        ]
      ],
      "skip": "不把旧机器共用 preferences.md 的全部内容归给当前人，不读取全组织流水。"
    },
    {
      "id": "resume-work",
      "label": "继续旧 Session",
      "steps": [
        [
          "续接已有上下文",
          "原生恢复由 Harness 处理；RemoteLab 继续投影本轮来源和适用局部约定。"
        ],
        [
          "检查变化",
          "涉及当前状态、旧阻塞或人的新纠正时，查项目条目当前版本。文件改变不保证旧上下文自动刷新。"
        ],
        [
          "补相关证据",
          "只核对本次依赖的变化和原始依据，过期认识带失效标记。"
        ],
        [
          "记录结果",
          "新产物回到原 Session，新的项目认识回到该项目条目。"
        ]
      ],
      "skip": "通常不重读全部启动文档，也不把 workSummary 当成实时结果。"
    },
    {
      "id": "meal",
      "label": "公司就餐 / 出行",
      "steps": [
        [
          "明确本次需求",
          "人数、时间、目的地或就餐要求以当前请求为准。"
        ],
        [
          "取公司背景",
          "相关时读公司当前位置／集合点和适用时间；未知地点不猜。"
        ],
        [
          "取个人相关偏好",
          "只使用已核对的饮食、出行或表达偏好，并按适用范围处理。"
        ],
        [
          "查时效信息",
          "餐厅营业、交通、费用等变化信息另行核实。建议不反向改写项目推进状态。"
        ]
      ],
      "skip": "通常不读所有项目主账、训练日志或代码规则。这里仅说明记忆选择，不提供就餐推荐。"
    },
    {
      "id": "pmo-review",
      "label": "组织巡检 / 测试日报",
      "steps": [
        [
          "先看覆盖",
          "列出全部已登记项目、来源、读取范围和缺口；测试读取复用既有采集结果。"
        ],
        [
          "读取各项目变化",
          "读取各项目当前认识与本轮增量；发现矛盾再回原文／结果查证。"
        ],
        [
          "观察跨项目问题",
          "发现依赖、重复工作、风险与方法案例，区分事实、待核报告和 Agent 建议。"
        ],
        [
          "生成共同视图",
          "从同一条目版本生成项目、个人和组织视图；反馈定位条目，后续修订原处。"
        ]
      ],
      "skip": "这是专门巡检任务的范围，普通 Session 不承担全组织巡检的启动负担。"
    }
  ],
  "pointerRules": [
    [
      "指针带用途，正文留原处",
      "索引给出稳定项目／条目 ID、名称、适用场景、精确目标和当前版本或更新时间。它帮助找到信息，不再复制一份认识正文。"
    ],
    [
      "检索整篇中的相关条目",
      "先在已确定的项目范围查条目 ID、名称、任务和关键词，再打开匹配章节与原证据；缺资料时继续找相关来源，不用“只读开头结尾”当检索策略。"
    ],
    [
      "能判断新旧与缺失",
      "当前认识标注有效／被替代／待核。文件迁移保留重定向，源不可访问保留缺口；断链不能当“没有发生”。"
    ],
    [
      "记录本次到底读了什么",
      "后续运行实现可在读取结果里返回来源、条目版本和具体范围。Context 投影、正文读取、状态查证分别留痕；看见路径不等于看过正文。"
    ]
  ],
  "classificationCases": [
    {
      "id": "project-state",
      "label": "项目进展",
      "example": "“转换脚本已提交，但还没经过独立验收。”",
      "type": "项目结果报告",
      "target": "项目记忆条目",
      "paths": [
        "project-knowledge/projects.md#项目章节"
      ],
      "rule": "记录产物已提交与待验收两个状态，链接提交和原发言；不能写成项目已完成。",
      "other": "过程留在 Session；任务状态和验收仍由对应系统维护。"
    },
    {
      "id": "topic-rule",
      "label": "话题临时约定",
      "example": "“这次只处理格式转换，不重跑评测。”",
      "type": "本话题有效约定",
      "target": "Session.activeAgreements；长材料留任务笔记",
      "paths": [
        "chat-sessions.json 内相应 Session",
        "必要时 tasks/<sessionId>.md"
      ],
      "rule": "只影响这个任务。除非明确形成项目级要求，不推广到全部 Session 或 AGENTS.md。",
      "other": "原话与适用条件保留在事件中。"
    },
    {
      "id": "project-rule",
      "label": "项目共同决定",
      "example": "“项目甲今后统一用某个结果入口，并按这套标准验收。”",
      "type": "项目级约定／决定",
      "target": "项目记忆的有效约定",
      "paths": [
        "project-knowledge/projects.md#项目甲"
      ],
      "rule": "核对是否确为项目范围，以及负责人／验收职责的确认。相关话题读取这条约定，不复制到每个话题的独立共识。",
      "other": "若同时影响仓库操作，可在其 AGENTS.md 放稳定操作要求或指针；业务认识仍由主账维护。"
    },
    {
      "id": "writing",
      "label": "个人写作偏好",
      "example": "成员甲明确说：“以后给我的报告先说结论，再解释依据。”",
      "type": "本人跨任务偏好",
      "target": "本人协作偏好记录（拟建设）",
      "paths": [
        "reference/people/<personId>.md"
      ],
      "rule": "核对发言身份和跨任务意图；本轮更具体的要求优先。别人的同一句话不自动覆盖本人偏好。",
      "other": "“这篇先简短些”默认是本次要求，不是终身偏好。"
    },
    {
      "id": "office",
      "label": "公司基础事实",
      "example": "“办公室从下周起迁到地点乙；这周还在地点甲。”",
      "type": "带生效时间的公司背景",
      "target": "公司信息文档（拟建设）",
      "paths": [
        "reference/company.md"
      ],
      "rule": "保留地点、生效时间、来源及维护人；就餐、出行时读当前有效地点。真实地址不出现在公开示例。",
      "other": "不写到 AGENTS.md、全局启动上下文或项目进度里。"
    },
    {
      "id": "repo-rule",
      "label": "稳定操作规则",
      "example": "“改这个仓库后，完成规定验证并提交推送；不能强推。”",
      "type": "仓库范围的执行约束",
      "target": "该仓库 AGENTS.md",
      "paths": [
        "目标仓库/AGENTS.md"
      ],
      "rule": "规则适用范围与认可明确；按仓库交付流程维护。一次事故的具体 PID、地址和临时命令不随它进入规则文件。",
      "other": "工作区通用规则与仓库专用规则分别维护，不把局部要求升级成全局要求。"
    },
    {
      "id": "good-workflow",
      "label": "优秀工作流",
      "example": "“某团队用 To do → 日报反馈的方法，真实解决了一次漏跟进。”",
      "type": "有依据的方法候选",
      "target": "项目记忆的方法观察；验证后完善 Skill",
      "paths": [
        "项目条目 + 原始案例指针",
        "相关 Skill／WORKFLOW"
      ],
      "rule": "现在就发现并记录收益和条件。独立复用成功后再提升为可调用方法；与已有方法先比较是否重复。",
      "other": "不把“似乎不错”的观察写成强制工作规则。"
    },
    {
      "id": "agent-observation",
      "label": "Agent 风险判断",
      "example": "“两项目都在做近似转换工具，可能重复投入。”",
      "type": "有证据的观察／待核建议",
      "target": "相关项目的观察条目",
      "paths": [
        "一个观察身份，关联多个项目"
      ],
      "rule": "说明依据、差异和不确定性。可能共享底层方法，也可能需求不同；由项目负责人确认资源与优先级取舍。",
      "other": "Agent 判断不直接变成人的承诺或正式排期。"
    },
    {
      "id": "environment",
      "label": "机器运行信息",
      "example": "“本实例使用某个端口，旧服务名已停用。”",
      "type": "实例环境事实",
      "target": "现有环境参考文档",
      "paths": [
        "~/.remotelab/memory/reference/ 下对应环境文档"
      ],
      "rule": "带实例、核对时间和读取方法；操作前查当前值。平台通用经验与单机配置分开，秘密不进入知识主账。",
      "other": "只有跨部署有效的方法才适合整理到 memory/system.md。"
    },
    {
      "id": "uncertain",
      "label": "来源不清的说法",
      "example": "“听说某任务已经好了”，缺人名、日期、任务和结果证据。",
      "type": "待核线索",
      "target": "隔离候选／待归属区",
      "paths": [
        "测试根目录/候选与覆盖记录"
      ],
      "rule": "保留原始说法和缺项，不标已确认，不自动写入正式偏好、项目决定或 AGENTS.md。",
      "other": "查不到日志也不能证明人没有工作。"
    }
  ],
  "writeRules": [
    [
      "先保存来源，再整理认识",
      "用消息／事件／提交等稳定身份去重。日报、转述和 Agent 摘要保留同一来源谱系；引用次数不等于独立佐证数量。"
    ],
    [
      "分类看内容用途",
      "同一段话可以同时含项目结果和本人偏好，分别提取到相应位置，但共享原始来源。写入最具体的维护位置，索引只更新指针。"
    ],
    [
      "确认按职责，绑定版本",
      "普通可查证事实可由 Agent 核验；目标取舍由负责人确认，本人承诺由相关个人确认，交付结果由验收人确认。反馈文本也可作为确认依据，须能定位事项和版本。"
    ],
    [
      "业务状态与认识状态分开",
      "计划、进行中、产物已提交、验收通过分别表达；另列证据程度与确认状态。项目负责人说“认可方案”不等于交付已经验收。"
    ],
    [
      "矛盾和纠正不能被覆盖掉",
      "新说法不因更晚出现就自动为真。核对来源、发生时间与证据；明确替代旧条目，保留分歧。实质变更只使受影响的确认失效，无回应仍待确认。"
    ],
    [
      "写入保留唯一维护位置",
      "主账更新需检查并发版本、只改目标条目，形成可回滚版本。多个 Agent 同时修改同一条目时合并证据或标冲突，避免最后一次写入覆盖前人。"
    ],
    [
      "来源变化会影响派生内容",
      "编辑、撤回、失效和访问范围变化要重新审查对应条目、报告与索引。保留必要来源身份与更正记录，按实际保留要求处理原文；本页不新设隐私授权系统。"
    ]
  ],
  "feedbackStory": [
    [
      "来源进入",
      "个人 Session 报告脚本已提交；项目条目记录“产物已提交，待验收”，引用具体事件和提交。"
    ],
    [
      "项目日报展示",
      "日报引用条目 ID 与版本 v1，向相关职责显示待核事项。发布成功仍不表示人已确认。"
    ],
    [
      "人的反馈",
      "验收人指出一个场景未通过。反馈绑定该事项，项目条目成为 v2：验收未通过，列失败证据。"
    ],
    [
      "组织视图更新",
      "组织与个人视图读取 v2。旧日报保留其日期快照与更正指针，当前页可显示新状态；不为了改历史而丢失发生顺序。"
    ],
    [
      "后续重新验收",
      "修复后有新结果，再形成 v3 和新的验收记录。旧 v1 的确认不自动沿用到新交付范围。"
    ]
  ],
  "migration": [
    [
      "导航",
      "保留 bootstrap.md、projects.md、skills.md 的指针结构。项目目录由范围登记生成，只记录入口与用途，不复制主账正文。"
    ],
    [
      "项目主账",
      "先沿用 project-knowledge/projects.md 的项目章节，加稳定 ID、证据与确认属性。增长到确实难维护时才拆文件；原入口保留跳转，原历史保留。"
    ],
    [
      "群与 Session 关联",
      "隔离区建立一份范围登记，适配现有 projectLinks 与话题绑定；后续由同一登记生成连接器配置投影，避免两处手工绑定走散。侧栏 personViews 继续独立服务个人排列。"
    ],
    [
      "旧偏好与公司背景",
      "旧共用偏好逐条核对归属，只迁移有本人依据的内容；公司文档补来源和有效时间。未知项明确列出，不为了目录完整编造内容。"
    ],
    [
      "候选与写回",
      "保留旧候选作审阅材料；新治理流使用明确目标允许列表。旧任务自动写入与通用候选目标需单独核对并迁移，不宣称本次已经关闭。"
    ],
    [
      "报告与回滚",
      "保留既有日报发布／评论锚点流程，报告引用主账条目版本。内容可回滚，但回滚记忆不等于撤销现实部署、发送或已完成工作。"
    ]
  ],
  "acceptanceCases": [
    [
      "两群同项目",
      "讨论群和干活群产生的同一决定只形成一条项目认识；两个群的新话题都能定位这条有效约定。"
    ],
    [
      "个人贡献不串线",
      "个人 Session 的项目结果进入正确项目，本人偏好进入正确 Person；无关内容保持原处。"
    ],
    [
      "跨项目不重复计数",
      "共同依赖只有一个事项身份，各项目角色分别显示；同一次成果不被算成两份独立成果。"
    ],
    [
      "新话题知道该读什么",
      "能定位项目、有效约定、相关话题与方法；不依赖长文头尾，也不要求读取全组织历史。"
    ],
    [
      "未知与分歧可见",
      "缺作者、缺来源、不可读和断链显示为缺口；不靠模型补齐，不把沉默当确认。"
    ],
    [
      "更正能传回原处",
      "日报反馈更新对应条目与版本，项目／个人／组织视图一致；保留历史和确认失效范围。"
    ],
    [
      "方法能被发现",
      "真实巡检能捕捉一个有用实践，比较已有流程；Skill 晋升另有真实独立复用证据。"
    ],
    [
      "测试不影响现有工作",
      "写入正式记忆的尝试被代码／权限拒绝；无必经的新模型调用或全量注入，前台任务效果与延迟不退化。"
    ]
  ],
  "prerequisites": [
    [
      "项目与来源登记",
      "每个项目的稳定 ID、两群绑定、负责人／验收职责、相关资料入口和可读范围；现有一对绑定不能代表全部已覆盖。"
    ],
    [
      "个人归属依据",
      "Person 与外部发言身份核对，哪些旧偏好是本人的明确表达；默认产品设置保持原有用途。"
    ],
    [
      "公司事实来源",
      "名称、时区、办公室／集合点、维护人和生效日期。真实位置尚未在本页补写，也不作为方案发布的前提。"
    ]
  ]
};
