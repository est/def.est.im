# AI 英语词典词条 YAML Schema（铺平式 v1）

## 背景与动机

- 之前用裸 JSON 输出，模型手写序列化，引号转义频繁翻车。
- 改 YAML + block scalar 可缓解，但深嵌套 schema 依然会让模型偷工减料（漏层、瞎填）。
- 结论：**schema 越平，模型越听话**。每个 entry 是"词性 + 单义项 + 单例句"的一行式记录，无嵌套；所有集合一律 block 风格，不出现任何方括号。

## Schema

```yaml
word: run
phonetic_uk: /rʌn/
phonetic_us: /rʌn/
entries:
  - pos: verb
    def_en: to move quickly using your legs
    def_zh: 跑，奔跑
    example_en: She runs five miles every morning.
    example_zh: 她每天早上跑五英里。
    synonyms:
      - sprint
      - dash
    antonyms:
      - walk
    collocations:
      - run fast
      - run a marathon
    register: informal
  - pos: verb
    def_en: to move something in a particular direction or position
    def_zh: 使…移动，推（某物）
    example_en: He ran his fingers through his hair.
    example_zh: 他用手指拨了拨头发。
  - pos: noun
    def_en: a period of continuous activity or use
    def_zh: 一段连续时期
    example_en: The printer had a long run without breaking.
    example_zh: 这台打印机连续运转了很久都没坏。
    register: informal
  - pos: idiom
    pattern: run into sb.
    def_en: to meet someone by chance
    def_zh: 偶然遇到
    example_en: I ran into an old friend at the mall.
    example_zh: 我在商场偶然遇到一个老朋友。
inflections:
  - form: third_person_singular
    value: runs
  - form: present_participle
    value: running
  - form: past
    value: ran
    sense: 1
  - form: past_participle
    value: run
  - form: plural
    value: runs
other_notes: |     # 可选，放在最后；仅补充其它字段无法表达的内容
  特殊说明
```

虚词示例（验证"没有就省略"规则）：

```yaml
word: the
phonetic_uk: /ðə/
phonetic_us: /ðə/
entries:
  - pos: article
    def_en: used before a noun to refer to a specific thing already mentioned or known
    def_zh: 这，那（特指）
    example_en: The book on the table is mine.
    example_zh: 桌上的那本书是我的。
    usage_notes: 名词前已有 this/that/my 等限定词时，不再用 the。
```

### 字段定义

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `word` | string | 是 | 查询词原样回显，用于校验 AI 未改词条 |
| `phonetic_uk` / `phonetic_us` | string | 否 | 主音标（最常见读音），尽量必填 |
| `cefr` | string | 否 | A1/A2/B1/B2/C1/C2，大概估计即可，作遍历优先级 |
| `other_notes` | string | 否 | 放在 YAML 最后；仅补充其它专用字段无法表达的内容（次要读音、同形词两套变形原因等），不重复 phonetic/inflections/entries 里已有的信息 |
| `inflections` | list（block 序列） | 否 | 变形表，每条 `form + value`（可选 `sense` 归属义项序号）；省略 sense = 词级通用 |
| `entries` | list | 是 | 铺平的一行式记录，**一条 = 一个词性 + 一个义项 + 至多一个例句** |
| `pos` | string | 是 | 白名单（**全称，勿用缩写**）：noun, verb, adjective, adverb, preposition, conjunction, pronoun, interjection, article, phrase, idiom |
| `pattern` | string | 否 | 仅 idiom/phrase 义项：槽位化模式（`run into sb.`），用 base form + sb./sth. 占位，供检索命中 |
| `def_en` | string | 是 | 英文释义，简洁单句 |
| `def_zh` | string | 是 | 中文释义 |
| `example_en` | string | 否 | 例句，必须与 `example_zh` 成对出现 |
| `example_zh` | string | 否 | 例句翻译，必须与 `example_en` 成对出现 |
| `synonyms` | list（block 序列） | 否 | 同义词，绑定义项，一条一行 |
| `antonyms` | list（block 序列） | 否 | 反义词，绑定义项，一条一行 |
| `collocations` | list（block 序列） | 否 | 常用搭配，绑定在义项上，一条一行 `- item` |
| `register` | string | 否 | formal / informal / slang / literary 等 |
| `usage_notes` | string | 否 | 语法模式、易错点、中式英语提醒，可多行（block scalar） |

变形 `form` 白名单：`plural`、`third_person_singular`、`present_participle`、`past`、`past_participle`、`comparative`、`superlative`，按词性取用（名词取 `plural`，动词取时态四项，形容词/副词取比较级）。同一词性的变形通常对所有义项一致，此时省略 `sense`（词级）；若不同义项的变形不同（lie 躺→lay / 说谎→lied），每项用 `sense` 标明归属义项序号。`inflections` 放在 `entries` 之后输出，便于引用刚写过的义项序号。

注意：`usage_notes` 里如果出现冒号、引号等，用 YAML 块标量：

```yaml
usage_notes: |
  不要用 run 表达"跑业务"。
  常见错误："run the business" 是对的，但"run 业务"不适用所有语境。
```

## AI 输出规则（写进 prompt 的硬约束）

1. **直接输出 YAML 正文**：不加 ```yaml 围栏、不加 `---` 文档头、不加任何说明文字。
2. **所有集合一律 block 风格**：`- item` 每条一行，禁止 flow 风格（`[a, b]`、`{a: b}`）——方括号、逗号、对齐是模型手写集合时的主要翻车点。
3. **一条 entry 只有一个义项**：不要合并义项，不要在一个 definition 里写两个意思。
4. **一条 entry 至多一个例句**：例句必须 en/zh 成对，要么都有、要么都省略。
5. **没有就省略键**：不输出 `key: null`、不输出空字符串。
6. **义项按常用度降序排列**，口语义项放最后。
7. **主音标只填最常见读音**（尽量必填）；变形尽量列全（尤其不规则动词/复数），若不同义项的变形不同（lie 躺→lay / 说谎→lied），`inflections` 每项用 `sense` 标明归属义项序号。已在 phonetic/inflections/entries 里体现的信息不重复；`other_notes` 放在最后，仅补充专用字段无法表达的内容。
8. **短语归属**：短语/习语作为其核心词（通常是首词）词条内的 idiom / phrase 义项输出，不单独成词——词形还原检索依赖此约定。
9. **顶层 `cefr` 字段**：A1/A2/B1/B2/C1/C2，大概估计即可（作遍历优先级），不确定可省略。

## 校验与重试管线

```
生成 YAML → yaml.parse → schema 校验 → 通过则落盘，失败则把报错喂回模型重试（≤2 次）
```

校验规则（机器可执行）：

1. `word` 与查询词完全一致，且与文件名一致（文件名 = `word` 或 `word-N`），否则重试。
2. `entries` 非空且 ≤ 16，每条含非空 `pos` / `def_en` / `def_zh`。
3. `pos` 在枚举白名单内（全称）。
4. `example_en` 与 `example_zh` 成对（同有同无）。
5. `synonyms` / `antonyms` / `collocations` 若存在，必须是字符串列表且非空。
6. `inflections` 若存在，每条必须含 `form`（白名单内）和 `value`（非空）；`sense` 若存在须为整数且在义项范围内。
7. `pattern` 仅允许出现在 idiom / phrase 义项，且 idiom / phrase 义项**必须**带 `pattern`（短语检索的唯一入口）。
8. `cefr` 若存在须在 A1/A2/B1/B2/C1/C2 白名单内。
9. flow 风格（`[a, b]` / `{a: b}`）可检出——仅警告不拒绝，解析成功即可入库。
10. 解析失败或任一规则不过 → 附带解析器报错原文重试。

## 文件组织

- 一个词一个文件：`words/run.yaml`、`words/the.yaml`，git diff 友好、便于人工校对。
- 同形词（同拼写不同读音/语义，如 tear 眼泪 / tear 撕）：第二份文件加数字后缀 `words/tear-2.yaml`，`word` 字段不变，入库时按后缀解析为 variant 区分。
- 校对是必须环节：AI 生成的词典不可直接用，逐词人工过一遍再入库。

## 已知取舍（v1 接受）

- **单例句**：同一义项想要多个例句，v1 需要重复 definition 再开一条 entry。若后期成为痛点，再引入 `example_en_2` 或 `examples` 列表，此处先不做。
- **无 sense 编号**：义项顺序即输出顺序，靠 prompt 约束"按常用度降序"，不支持显式排序/引用。
- **无词频 / CEFR**：模型输出的是猜测值而非实测，先不做。
- **变形形式有幻觉风险**：不规则动词的过去式/过去分词是模型高频编造点，产出后建议用离线词表（Wiktionary 转储等）批量校验，AI 输出仅作初稿。
- **collocations 逐条冗余**：搭配本就绑定义项，铺平后重复出现在多条 entry 中可接受。

## 待定问题

- 例句数量上限是否需要放开（放开的形式：重复 entry vs `examples` 列表）。
- 是否需要 `sense_id` 以支持后续义项级引用。
