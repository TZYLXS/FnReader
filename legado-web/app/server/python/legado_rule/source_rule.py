"""规则外壳 —— AnalyzeRule.kt 内部类 ``SourceRule`` 与 ``Mode`` 的移植。

一条书源规则字符串（例如 ``"@CSS:.book@text##\\s+##"``）会先被
:meth:`AnalyzeRule.split_source_rule` 按 ``<js>``/``@js:``/``@webjs:`` 切成
若干"规则段"，每个规则段再交给 :class:`SourceRule` 做三件事：

1. **判定模式**（XPath / Json / Default / Js / Regex / WebJs）。判定顺序是有
   讲究的，``@CSS:`` 不剥前缀（留给 AnalyzeByJSoup 内部再判），``@@`` 才是
   "强制当 CSS 但剥掉前缀"的写法。
2. **拆出预处理片段**：``@put:{...}`` 先被摘掉并解析成 key→rule 映射；
   ``@get:{...}`` 与 ``{{ ... }}`` 被切成"占位参数"，同时把模式改成 Regex
   （除非它们出现在 ``##`` 之后 —— 那时它们是替换文本的一部分，不是规则）。
3. **拆出 ``$1``/``$2`` 引用**：正则模式下的分组引用。

真正的"拼回字符串"发生在 :meth:`SourceRule.make_up_rule`，它按参数类型
（字面量 / 分组引用 / JS 表达式 / @get 变量）把结果拼成最终规则文本，
最后才处理 ``##`` 三段式替换。
"""

from __future__ import annotations

import json
import re
from enum import Enum
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    from .analyze_rule import AnalyzeRule


class Mode(Enum):
    XPATH = "XPath"
    JSON = "Json"
    DEFAULT = "Default"
    JS = "Js"
    REGEX = "Regex"
    WEBJS = "WebJs"


class NotStandardJSON(Exception):
    pass


# \$\d{1,2} —— Kotlin 的 regexPattern，用于识别 $1 / $12 这类分组引用
REGEX_PATTERN = re.compile(r"\$\d{1,2}")


def _load_json_lenient(text: str) -> Any:
    """尽量把 @put 里的 JSON 解析出来。

    Legado 先用严格解析，失败再退回宽松解析（会打一条"JSON 格式不规范"的
    日志）。这里用同样的两步，只是把"宽松"实现为"去掉尾逗号/单引号修正"这样
    的最小集合，足够覆盖书源里的常见脏数据。
    """
    try:
        return json.loads(text)
    except Exception:
        pass
    cleaned = re.sub(r",\s*([}\]])", r"\1", text)
    # 单引号字符串 -> 双引号
    cleaned = re.sub(r"'([^']*)'", r'"\1"', cleaned)
    # 裸键名 -> 带引号（{a:1} / ,b:2）
    cleaned = re.sub(r'([{,]\s*)([A-Za-z_][\w.\-]*)(\s*:)', r'\1"\2"\3', cleaned)
    try:
        return json.loads(cleaned)
    except Exception as exc:  # pragma: no cover - 极端脏数据
        raise NotStandardJSON(str(exc)) from exc


def is_json_text(text: str) -> bool:
    """对应 StringExtensions.kt 的 ``String.isJson()``。"""
    s = (text or "").strip()
    return (s.startswith("{") and s.endswith("}")) or (
        s.startswith("[") and s.endswith("]")
    )


class SourceRule:
    """一条规则段的解析结果。

    Parameters
    ----------
    rule_str:
        原始规则段文本。
    mode:
        上层传入的默认模式（``splitSourceRule`` 里 ``allInOne`` / ``isRegex``
        会把它预置成 Regex）。
    owner:
        反向引用 :class:`AnalyzeRule`，用于 ``{{ }}`` 里的规则求值、JS 求值
        以及 ``@get`` 变量取值。
    """

    GET_RULE_TYPE = -2
    JS_RULE_TYPE = -1
    DEFAULT_RULE_TYPE = 0

    def __init__(
        self,
        rule_str: str,
        mode: Mode = Mode.DEFAULT,
        owner: "AnalyzeRule | None" = None,
    ) -> None:
        self.mode: Mode = mode
        self.owner = owner
        self.replace_regex: str = ""
        self.replacement: str = ""
        self.replace_first: bool = False
        self.put_map: dict[str, str] = {}
        self.rule_param: list[str] = []
        self.rule_type: list[int] = []

        self.rule: str = self._init_rule(rule_str)
        # 1) 摘掉 @put
        self.rule = self._split_put_rule(self.rule, self.put_map)
        # 2) 切 @get / {{ }} / $n
        self._split_eval_and_regex(self.rule)

    # ------------------------------------------------------------------ #
    # 模式判定
    # ------------------------------------------------------------------ #
    def _init_rule(self, rule_str: str) -> str:
        # Kotlin 的 when 分支顺序不能改，尤其 @CSS: 与 @@ 的顺序、
        # 以及 isJSON 与 "/" 开头的先后。
        if self.mode in (Mode.JS, Mode.REGEX):
            return rule_str
        if rule_str.lower().startswith("@css:"):
            self.mode = Mode.DEFAULT
            return rule_str  # 注意：保留前缀，交给 AnalyzeByJSoup 处理
        if rule_str.startswith("@@"):
            self.mode = Mode.DEFAULT
            return rule_str[2:]
        if rule_str.lower().startswith("@xpath:"):
            self.mode = Mode.XPATH
            return rule_str[7:]
        if rule_str.lower().startswith("@json:"):
            self.mode = Mode.JSON
            return rule_str[6:]

        content = self.owner.content if self.owner is not None else None
        is_json_content = isinstance(content, (dict, list)) or (
            isinstance(content, str) and is_json_text(content)
        )
        if is_json_content or rule_str.startswith("$.") or rule_str.startswith("$["):
            self.mode = Mode.JSON
            return rule_str
        if rule_str.startswith("/"):
            self.mode = Mode.XPATH
            return rule_str
        return rule_str

    # ------------------------------------------------------------------ #
    # @put
    # ------------------------------------------------------------------ #
    def _split_put_rule(self, rule_str: str, put_map: dict[str, str]) -> str:
        from .analyze_rule import PUT_PATTERN  # 避免循环引用

        while True:
            m = PUT_PATTERN.search(rule_str)
            if not m:
                return rule_str
            rule_str = rule_str.replace(m.group(0), "", 1)
            payload = m.group(1)
            try:
                parsed = _load_json_lenient(payload)
            except NotStandardJSON:
                continue
            if isinstance(parsed, dict):
                put_map.update({str(k): str(v) for k, v in parsed.items()})

    # ------------------------------------------------------------------ #
    # @get / {{ }} / $n
    # ------------------------------------------------------------------ #
    def _split_eval_and_regex(self, rule: str) -> None:
        from .analyze_rule import EVAL_PATTERN

        start = 0
        first = EVAL_PATTERN.search(rule)
        if first:
            before = rule[start:first.start()]
            # 只有出现在 ## 之前，@get / {{ }} 才算"规则"；出现在 ## 之后
            # 它们是替换文本，不能因此把整条规则改成 Regex。
            if self.mode not in (Mode.JS, Mode.REGEX) and (
                first.start() == 0 or "##" not in before
            ):
                self.mode = Mode.REGEX

            for m in EVAL_PATTERN.finditer(rule):
                if m.start() > start:
                    self._split_regex(rule[start:m.start()])
                token = m.group(0)
                low = token.lower()
                if low.startswith("@get:"):
                    self.rule_type.append(self.GET_RULE_TYPE)
                    # Kotlin: tmp.substring(6, tmp.lastIndex) —— 去掉 @get:{ 与 }
                    self.rule_param.append(token[6:-1])
                elif token.startswith("{{"):
                    self.rule_type.append(self.JS_RULE_TYPE)
                    self.rule_param.append(token[2:-2])
                else:  # pragma: no cover - 正则不会走到这里
                    self._split_regex(token)
                start = m.end()

        if len(rule) > start:
            self._split_regex(rule[start:])

    def _split_regex(self, rule_str: str) -> None:
        start = 0
        head = rule_str.split("##")[0]
        found = False
        for m in REGEX_PATTERN.finditer(head):
            found = True
            if m.start() > start:
                self.rule_type.append(self.DEFAULT_RULE_TYPE)
                self.rule_param.append(rule_str[start:m.start()])
            token = m.group(0)
            self.rule_type.append(int(token[1:]))
            self.rule_param.append(token)
            start = m.end()
        if found and self.mode not in (Mode.JS, Mode.REGEX):
            self.mode = Mode.REGEX
        if len(rule_str) > start:
            self.rule_type.append(self.DEFAULT_RULE_TYPE)
            self.rule_param.append(rule_str[start:])

    # ------------------------------------------------------------------ #
    # 拼回
    # ------------------------------------------------------------------ #
    def make_up_rule(self, result: Any) -> None:
        """把 ``{{ }}`` / ``@get`` / ``$n`` 拼回成最终规则文本，并解析 ``##``。"""
        if self.rule_param:
            parts: list[str] = []
            for idx in range(len(self.rule_param) - 1, -1, -1):
                reg_type = self.rule_type[idx]
                if reg_type > self.DEFAULT_RULE_TYPE:
                    # $n：结果必须是 list 且长度足够，否则保留字面量
                    if isinstance(result, list) and len(result) > reg_type:
                        if result[reg_type] is not None:
                            parts.insert(0, str(result[reg_type]))
                    else:
                        parts.insert(0, self.rule_param[idx])
                elif reg_type == self.JS_RULE_TYPE:
                    param = self.rule_param[idx]
                    if self._is_rule(param):
                        parts.insert(0, self._eval_rule_text(param))
                    else:
                        js_eval = self._eval_js(param, result)
                        parts.insert(0, self._js_to_text(js_eval))
                elif reg_type == self.GET_RULE_TYPE:
                    parts.insert(0, self._get(self.rule_param[idx]))
                else:
                    parts.insert(0, self.rule_param[idx])
            self.rule = "".join(parts)

        sections = self.rule.split("##")
        self.rule = sections[0].strip()
        if len(sections) > 1:
            self.replace_regex = sections[1]
        if len(sections) > 2:
            self.replacement = sections[2]
        if len(sections) > 3:
            self.replace_first = True

    @staticmethod
    def _is_rule(rule_str: str) -> bool:
        # Kotlin: 以 @ 开头 / $.(或 $[) 开头 / // 开头 → 当规则；否则当 JS 表达式
        return (
            rule_str.startswith("@")
            or rule_str.startswith("$.")
            or rule_str.startswith("$[")
            or rule_str.startswith("//")
        )

    @staticmethod
    def _js_to_text(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, float) and value.is_integer():
            return "%.0f" % value
        if isinstance(value, (list, dict)):
            return json.dumps(value, ensure_ascii=False)
        return str(value)

    def _eval_rule_text(self, rule_str: str) -> str:
        """``{{ }}`` 里如果写的是规则，就用"单规则"重新求值。"""
        if self.owner is None:
            return ""
        return self.owner.get_string_rules([SourceRule(rule_str, Mode.DEFAULT, self.owner)])

    def _eval_js(self, code: str, result: Any) -> Any:
        if self.owner is None:
            return None
        return self.owner.eval_js(code, result)

    def _get(self, key: str) -> str:
        if self.owner is None:
            return ""
        return self.owner.get(key)

    def get_param_size(self) -> int:
        return len(self.rule_param)
