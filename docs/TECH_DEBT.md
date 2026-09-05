# wwj 技术债与未来路线备忘（TECH_DEBT）

> 建立于 2026-09-05（v1.9.1 封版时点）。本文件的目的：**把第三方评审（GPT）中被采纳的技术认知固化下来**，防止重启项目时从头重新发现。wwj 当前处于冻结状态——记录在案，但**冻结期内不偿还任何一项**。

## 一、已确认的技术债（冻结期不修）

### 1. Python 单进程锁（优先级最高）

`index.html` 中运行状态是全局单例：

```js
const pyState = { runProc: null, installing: false };
```

含义：**整个应用同时只能跑一个 Python 代码块**。v1.9.1 的交互约束（面板未关闭不可重复运行、改代码停运行）都是围绕这个单例设计的，逻辑自洽，非 bug。

**未来解法**：改为 `Map<blockId, Process>`，按块管理进程生命周期。估计工程量 1–2 天（含交互约束重设计）。

### 2. index.html 过胖（2109 行）

单文件承载：UI、CSS、Markdown 渲染、文件系统、搜索替换、即时编辑、Mermaid、KaTeX、Python 运行 UI、环境管理、导出、状态管理、设置。

**未来解法（GPT 建议的分层，记录备用）**：

```
src/
├── main/main.js + ipc/{files,python,export,system}.js
├── renderer/{index.html, css/*, js/{editor,renderer,live-editor,files,search,python,environment,export,settings}}
├── core/{markdown,blocks,document}
└── plugins/
```

**注意**：重构不产生用户价值，只有决定长期迭代时才做。

### 3. 进程隔离 ≠ 环境隔离（设计权衡，非缺陷）

现状：每个代码块独立**进程**，但共享同一个 venv（`%APPDATA%\wwj\pyenv`）。

- 这对 Notebook 式体验是**刻意选择**：Block A 装完 torch，Block B 直接 import 可用
- 若未来做"项目级开发"，需要升级为：全局 Runtime → 项目 Environment → 文档 Environment → 代码块 Process，env 落到 `项目/.wwj/pyenv`

### 4. 安全模型缺失

`spawn(python, [tmp])` 意味着代码块可以执行用户权限下的任意操作。未来加插件系统前必须先建 **Workspace Trust**（打开含可执行代码的文档时询问信任），Agent 化后所有"执行代码/删文件/装依赖/跑 shell"操作要走用户确认。

### 5. .wwj/ 元数据目录（未来项目的数据规范）

坚持 .md 永远是用户真正拥有的数据（无 vendor lock-in 是长期优势）；运行结果、env、cache 等元数据应放项目下 `.wwj/` 目录，不污染文档本体。

## 二、未来功能 backlog（来自 GPT 评审，已裁决）

重启 wwj 前这些一律不做。工程量为当时评估值。

| 功能 | 评级 | 工程量 | 备注 |
| --- | --- | --- | --- |
| PDF → Markdown | S | 2–3 天 | 拖入 PDF → 文本/标题/表格/图片识别 → .md + 图片目录；大纲联动是分水岭 |
| 项目工作区（打开文件夹） | S | 1–2 周 | "文件是编辑器思维，项目是 IDE 思维" |
| 插件系统（轻量 API） | S→最后 | 2–4 周 | plugin.json + registerCommand/Menu/Panel/CodeRunner；**用户数=1 时不做生态** |
| Python 多块并行 | S（唯一便宜项） | 1–2 天 | 即上述债 1 |
| AI 文档 Agent | S | 1–2 周 | 不是侧边聊天框；选中段落解释/改写/翻译；进阶：读文档→跑代码→改文档闭环 |
| Git 基础（init/diff/commit） | A | — | Markdown diff 价值高 |
| 全文运行（Notebook 化） | A | — | 保持 Markdown 本位，一键按序执行全部代码块 |
| DataFrame/图片输出渲染 | A | — | 运行结果富媒体展示 |
| Workspace Trust | A | — | 见债 4 |
| JS/Shell/Java/C++ 运行 | B | — | 顺序靠后 |

**明确不做**：云同步、社交、在线协作、手机端、自建云盘、一上手支持多语言、与 VS Code 正面竞争。

## 三、重启 wwj 的前置条件与顺序

1. 学业主线关卡完成之后
2. 先验证需求再写代码：仓库转公开 → 发 V2EX/小红书 → 看有没有第二个人下载
3. **有 100 个真实用户之前，不做任何新功能**；插件系统是最后一个才碰的
4. 还债顺序：单进程锁（1–2 天）→ index.html 分层重构 → 项目工作区 → 再谈功能
