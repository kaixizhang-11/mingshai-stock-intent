# 明筛 · 自然语言选股与策略解释器

可注册、可登录的 Web 选股研究产品。用户用中文描述意图，DeepSeek 将其翻译为可编辑条件；确定性引擎用扶摇金融数据筛选上证 50 当前成分股，逐项展示入选、排除、缺失依据。策略保存在按账号隔离的 Cloudflare D1 数据库中，可跨设备读取。

## 在线产品与范围

- 线上地址：[明筛 Web 产品](https://clearstock-ths-2026.mellow-frog-2915.chatgpt.site/)。
- 股票池：扶摇返回的当前上证 50 成分股（`000016.SH`），不是全 A 股。
- 可执行指标：营业收入同比、归母净利润同比、PE TTM、PB MRQ、近 20 个交易日年化波动率。
- 当前操作：注册、登录、退出、账号及策略删除、自然语言解析、手动编辑阈值、冲突检查、可解释筛选、股票比较、云端保存与读取策略。
- 产品不提供回测、交易下单、收益预测或监控任务。

## 运行方式

需要 Node.js 24+。本地预览使用 Node 内置 SQLite 模拟托管 D1；生产环境使用 Sites 提供的 Cloudflare D1 绑定。密钥只放运行环境，不写入源码或公开仓库。

```bash
export FUYAO_API_KEY='在本地环境中设置'
export DEEPSEEK_API_KEY='在本地环境中设置'
export AUTH_PEPPER='为本地或生产环境分别设置的随机长密钥'
npm run build
npm run validate
npm test
npm run dev
```

打开 `http://127.0.0.1:4173/`，注册一个用于测试的邮箱与 12 位以上密码。注册与登录写入本地 `.local/preview.sqlite`；线上写入 D1。首次发布时平台应用 `drizzle/0000_accounts.sql`。本地数据库不会打包进部署产物。

部署环境变量：`FUYAO_API_KEY`、`DEEPSEEK_API_KEY`、`AUTH_PEPPER`。`.openai/hosting.json` 只声明 D1 绑定 `DB`，不包含密钥。`AUTH_PEPPER` 一旦用于注册，不可随意更换，否则旧账号密码无法验证。使用 Sites 的源代码推送、保存版本、发布流程。

## 用户流程

1. 注册或登录；账号会话保存在 7 天有效的 HttpOnly、SameSite=Lax Cookie 中。
2. 输入中文选股意图。DeepSeek 返回条件草案、工作假设、无法支持的要求和待澄清点；用户可补充回答并重新解析，最多三轮。
3. 在条件工作台改指标、比较符与阈值。冲突条件会阻止执行。
4. 查看“入选／排除／待核查”，打开单只股票查看原始字段、来源、时点、单位、口径、请求 ID。
5. 调整阈值后查看新入选与离开入选的股票；勾选至多三只比较；保存条件并在其他设备重新读取。

## 职责与架构

```
浏览器（注册、登录、条件编辑、结果解释）
   ├─ /api/auth/*、/api/session、/api/strategies → Worker → D1（账号/会话/私有策略）
   ├─ /api/interpret → Worker → DeepSeek（只翻译意图，不挑股票）
   └─ /api/market → Worker → 扶摇（行情、估值、利润表、日线）
                              ↓
                         标准化数据 + 来源证据
                              ↓
                    浏览器确定性规则引擎（三态结果）
```

AI 输出只接受五个白名单字段、五种运算符与有限数值；无法执行的要求显式展示。规则引擎不调用模型，缺失值不会按零或通过处理。D1 存账号、会话、策略、调用额度及 15 分钟共享数据缓存。每账号每天最多 20 次 AI 解析，每小时最多 2 次强制刷新。登录/注册按 IP 与邮箱组合限流。

## 数据字段、公式和追溯

| 产品指标 | 扶摇来源 | 计算口径 |
| --- | --- | --- |
| 营业收入同比 | `/api/a-share/financials/income-statements-batch` 的 `operating_income` | 最近已披露报告期的本年累计值 ÷ 上年同一财报期间累计值 − 1。上年值 ≤ 0、未披露或接口异常则缺失。 |
| 归母净利润同比 | 同接口的 `parent_holder_net_profit` | 同上。 |
| PE TTM / PB MRQ | `/api/a-share/valuations/snapshot` 的 `pe_ttm` / `pb_mrq` | 保留接口原值；示例“合理”仅为可编辑的 PE 工作假设。 |
| 近 20 日年化波动率 | `/api/a-share/prices/historical-batch` 的前复权 `close_price` | 最近 21 个收盘价形成 20 个日对数收益率；样本标准差 × √252 × 100%。不足 21 个点则缺失。 |

股票池来自 `/api/a-share-index/constituents/ths-stock-list`，最新价格来自 `/api/a-share/prices/snapshot`。每个指标携带接口、原始字段、报告期/披露日或行情日期、请求 ID、单位与计算口径；取数时间单独显示。来源接口文档见 [扶摇文档](https://fuyao.aicubes.cn/docs/)。

## 账号与安全边界

- 密码先用服务端密钥进行 HMAC-SHA256，再用随机盐与 PBKDF2-SHA256（100,000 次，[Cloudflare Workers 单次上限](https://github.com/cloudflare/workerd/issues/1346)）散列；数据库不存明文。会话使用随机令牌，只存 SHA-256 摘要；策略按 `user_id` 查询，不能跨账号读取或删除。
- 更改状态的请求检查同源 `Origin` / `Sec-Fetch-Site`；Cookie 为 HttpOnly、SameSite=Lax，线上 HTTPS 时设置 Secure。
- 当前无邮箱所有权验证、邮件找回密码或双因素验证；用户可输入当前密码自助删除账号与策略。面向大规模开放注册前，需要补齐邮件服务、账号恢复、监控告警、数据库备份、限流与成本控制，并完成安全审计。
- 财务期、估值快照和价格时点不同；跨行业直接比较 PE 容易失真；当前“经营改善”仅用两个同比指标近似表达。结果是研究线索，不构成买卖建议。

## 测试和 AI 使用记录

见 [TESTING.md](TESTING.md) 与 [AI_USAGE_AND_VALIDATION.md](AI_USAGE_AND_VALIDATION.md)。`npm test` 覆盖账号会话与隔离、规则三态、冲突、数据缺失、接口失败、模型字段白名单及缺少凭据。

## 开源参考

- [TradingAgents](https://github.com/tauricresearch/tradingagents)：借鉴角色边界、工具调用与可解释轨迹；当前采用单个受约束的解析角色，不引入多角色交易辩论或自动交易。
- [tick-stock-panel](https://github.com/shy3130/tick-stock-panel)：参考 AI 策略生成与确定性执行分层、工具可见性；当前自行实现筛选与证据模型。
- [myhhub/stock](https://github.com/myhhub/stock)：参考指标与策略研究方向；当前仅选用可追溯的少数指标。

上述项目用于架构学习和产品取舍，未复制其源码或数据。
