"""JSONPath 求值器外壳 —— AnalyzeByJSonPath.kt 的移植。"""

from __future__ import annotations

from typing import Any, Callable

from . import jsonpath
from .rule_analyzer import RuleAnalyzer


class AnalyzeByJSonPath:
    def __init__(self, data: Any, on_error: Callable[[Exception], None] | None = None) -> None:
        self.data = data
        self.on_error = on_error

    # ------------------------------------------------------------------ #
    def _read(self, rule: str) -> jsonpath.JsonPathResult:
        return jsonpath.read(self.data, rule)

    def _join(self, result: jsonpath.JsonPathResult) -> str:
        if result.definite:
            if isinstance(result.value, list):
                return "\n".join(jsonpath.as_text(v) for v in result.value)
            return jsonpath.as_text(result.value)
        return "\n".join(jsonpath.as_text(v) for v in result.values)

    def get_string(self, rule: str) -> str | None:
        if not rule:
            return None
        analyzer = RuleAnalyzer(rule, code=True)
        rules = analyzer.split_rule("&&", "||")

        if len(rules) == 1:
            analyzer.reset_pos()
            # 先把 {$...} 内嵌规则替换掉；替换成功则整条结果就是它
            replaced = analyzer.inner_rule("{$.", 1, 1, self.get_string)
            if replaced:
                return replaced
            try:
                return self._join(self._read(rule))
            except Exception as exc:
                if self.on_error:
                    self.on_error(exc)
                return ""

        text_list: list[str] = []
        for rl in rules:
            temp = self.get_string(rl)
            if temp:
                text_list.append(temp)
                if analyzer.elements_type == "||":
                    break
        return "\n".join(text_list)

    def get_string_list(self, rule: str) -> list[str]:
        result: list[str] = []
        if not rule:
            return result
        analyzer = RuleAnalyzer(rule, code=True)
        rules = analyzer.split_rule("&&", "||", "%%")

        if len(rules) == 1:
            analyzer.reset_pos()
            replaced = analyzer.inner_rule("{$.", 1, 1, self.get_string)
            if replaced:
                result.append(replaced)
                return result
            try:
                data = self._read(rule)
            except Exception as exc:
                if self.on_error:
                    self.on_error(exc)
                return result
            if data.definite:
                if isinstance(data.value, list):
                    for item in data.value:
                        result.append(jsonpath.as_text(item))
                else:
                    result.append(jsonpath.as_text(data.value))
            else:
                for item in data.values:
                    result.append(jsonpath.as_text(item))
            return result

        results: list[list[str]] = []
        for rl in rules:
            temp = self.get_string_list(rl)
            if temp:
                results.append(temp)
                if analyzer.elements_type == "||":
                    break
        if results:
            if analyzer.elements_type == "%%":
                for i in range(len(results[0])):
                    for temp in results:
                        if i < len(temp):
                            result.append(temp[i])
            else:
                for temp in results:
                    result.extend(temp)
        return result

    def get_object(self, rule: str) -> Any:
        return self._read(rule).value if rule else None

    def get_list(self, rule: str) -> list[Any] | None:
        result: list[Any] = []
        if not rule:
            return result
        analyzer = RuleAnalyzer(rule, code=True)
        rules = analyzer.split_rule("&&", "||", "%%")
        if len(rules) == 1:
            try:
                data = self._read(rules[0])
            except Exception as exc:
                if self.on_error:
                    self.on_error(exc)
                return None
            if data.definite:
                if isinstance(data.value, list):
                    return list(data.value)
                if data.value is None:
                    return None
                return [data.value]
            return list(data.values)

        results: list[list[Any]] = []
        for rl in rules:
            temp = self.get_list(rl)
            if temp:
                results.append(temp)
                if analyzer.elements_type == "||":
                    break
        if results:
            if analyzer.elements_type == "%%":
                for i in range(len(results[0])):
                    for temp in results:
                        if i < len(temp):
                            result.append(temp[i])
            else:
                for temp in results:
                    result.extend(temp)
        return result
