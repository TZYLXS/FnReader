# legado_rule

Legado（「阅读」App）书源规则解析器的**纯 Python** 实现。语义对齐官方 Kotlin 实现
（`LegadoTeam/legado` master 分支 `app/src/main/java/io/legado/app/model/analyzeRule/`）。

解析结果直接产出结构化参数，交给 FPK 前端渲染 —— 前端不需要再解析规则，也不经过 node.js。

## 快速开始

```bash
pip install -r requirements.txt
```

```python
from legado_rule import AnalyzeRule

rule = AnalyzeRule().set_content(html, "https://example.com/book/1")
rule.get_string(".book@text")
rule.get_string("tag.a@href", is_url=True)
rule.get_string_list("class.item@tag.a@text")
```

书源级（输出可直接给前端）：

```python
from legado_rule import BookSourceEngine
engine = BookSourceEngine(source_dict)
books  = engine.search("剑来")
info   = engine.book_info(books[0]["bookUrl"])
tocs   = engine.chapters(info["tocUrl"])
body   = engine.content(tocs[0]["url"])
```

## 能力范围

- 规则切分：`&&` / `||` / `%%`（含"首个分隔符锁定"）、括号与引号平衡组
- 拆段：`<js>` / `@js:` / `@webjs:`、`allInOne` 前置冒号正则
- 模式判定：`@CSS:`（不剥前缀）/ `@@` / `@XPath:` / `@Json:` / `$.` / `/`
- 变量：`@put:{...}` / `@get:{...}` / `{{ }}` / `$1`、`###` 只替首个匹配
- CSS：选择器链、`class.` / `tag.` / `id.` / `text.` 首段特判、新旧三套索引、排除索引不污染 DOM
- 取值尾缀：`text` / `textNodes` / `ownText` / `html`（去 script/style）/ `all` / 属性（自动去重）
- XPath：JsoupXpath 取值语义、`</td>` / `</tr>` 包裹
- JSONPath：自研实现（递归、切片、过滤、函数、`{$...}` 内嵌）
- JS：quickjs 沙箱，注入 `result` / `src` / `baseUrl` / `book` / `chapter` / `page` 等，`java.*` 常用方法
- 书源引擎：分组式与扁平式规则、URL 规则、请求选项尾缀、相对地址补全、错误降级

## 测试

```bash
python -m unittest discover -s tests -v
```

94 个用例，包含 Legado 官方 `AnalyzeByJSoupDomTest` 的移植用例、端到端离线链路、17,077 条真实书源回归。

## 文档

- `接口说明.md` —— 全部类/方法/字段/规则语法，含可跑的离线实测输出
- `实现说明.md` —— 逐条语义、Kotlin↔Python 对照、性能数据、已知差异

## 示例脚本

```bash
python examples/api_demo.py     # 不联网，把所有接口跑一遍并打印结果
python examples/demo.py         # 单条规则演示
```

## 许可

仅用于个人学习与自用书源解析。请遵守目标站点的使用条款。
