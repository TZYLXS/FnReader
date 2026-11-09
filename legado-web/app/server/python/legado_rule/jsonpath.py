"""JSONPath 求值器 —— AnalyzeByJSonPath.kt 的移植（自研实现）。

Legado 用的是 jayway JsonPath。Python 环境里 ``jsonpath_ng`` 语法与 jayway 差别
较大（尤其是 ``$..x``、``[?...]`` 过滤器、``.length()`` 函数），因此这里按
jayway 的语法自己实现一个子集，覆盖书源里实际出现的写法：

* ``$``、``.name``、``['name']``、``["name"]``
* ``[0]``、``[0,2]``、``[*]``、``[start:end]``、``[start:end:step]``
* ``..name``、``..*``
* ``[?(@.field op value)]``，op 支持 ``== != < <= > >= =~ in nin empty``，
  并支持 ``&&`` / ``||`` / ``!`` 组合（外层已被 RuleAnalyzer 的代码平衡组保护）
* 函数：``.length()``、``.min()/.max()/.avg()/.sum()``、``.keys()``、
  ``.first()/.last()``
"""

from __future__ import annotations

import json
import math
import re
from typing import Any


class JsonPathError(ValueError):
    pass


# ---------------------------------------------------------------------- #
# 语法解析
# ---------------------------------------------------------------------- #
class _Parser:
    def __init__(self, text: str) -> None:
        self.text = text or ""
        self.i = 0

    def parse(self) -> list[tuple]:
        if not self.text.startswith("$"):
            # 书源里常见"裸键名"写法（NativeObject 内容 + 直接写 name）。
            # jayway 严格要求 $ 开头，这里宽松地补一个根节点，属于有意的超集。
            if self.text.startswith("["):
                self.text = "$" + self.text
            else:
                self.text = "$." + self.text
        self.i = 1
        steps: list[tuple] = []
        while self.i < len(self.text):
            ch = self.text[self.i]
            if ch == ".":
                if self.i + 1 < len(self.text) and self.text[self.i + 1] == ".":
                    self.i += 2
                    if self.i < len(self.text) and self.text[self.i] == "*":
                        self.i += 1
                        steps.append(("recursive_wildcard",))
                    elif self.i < len(self.text) and self.text[self.i] == "[":
                        continue
                    else:
                        name = self._read_name()
                        steps.append(("recursive", name))
                else:
                    self.i += 1
                    if self.i < len(self.text) and self.text[self.i] == "*":
                        self.i += 1
                        steps.append(("wildcard",))
                    elif self.i < len(self.text) and self.text[self.i] == "[":
                        continue
                    else:
                        name = self._read_name()
                        if self.i < len(self.text) and self.text[self.i] == "(":
                            args = self._read_parens()
                            steps.append(("function", name, args))
                        else:
                            steps.append(("child", name))
            elif ch == "[":
                steps.append(self._parse_bracket())
            else:
                raise JsonPathError("无法解析的位置 %d: %r" % (self.i, self.text[self.i:]))
        return steps

    # ------------------------------------------------------------------ #
    def _read_name(self) -> str:
        start = self.i
        while self.i < len(self.text) and self.text[self.i] not in ".[]()":
            self.i += 1
        name = self.text[start:self.i].strip()
        if not name:
            raise JsonPathError("缺少字段名: %r" % self.text)
        return name

    def _read_parens(self) -> str:
        # self.i 指向 '('
        depth = 0
        start = self.i
        in_quote: str | None = None
        while self.i < len(self.text):
            ch = self.text[self.i]
            if in_quote:
                if ch == "\\":
                    self.i += 2
                    continue
                if ch == in_quote:
                    in_quote = None
            elif ch in "'\"":
                in_quote = ch
            elif ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    self.i += 1
                    return self.text[start + 1:self.i - 1]
            self.i += 1
        raise JsonPathError("括号未闭合: %r" % self.text)

    def _parse_bracket(self) -> tuple:
        # self.i 指向 '['
        end = _find_bracket_end(self.text, self.i)
        if end < 0:
            raise JsonPathError("方括号未闭合: %r" % self.text)
        inner = self.text[self.i + 1:end].strip()
        self.i = end + 1

        if inner == "*":
            return ("wildcard",)
        if inner.startswith("?"):
            expr = inner[1:].strip()
            if expr.startswith("(") and expr.endswith(")"):
                expr = expr[1:-1]
            return ("filter", _parse_predicate(expr))

        # 多个 key / 多个索引
        parts = _split_top_level(inner, ",")
        if len(parts) > 1:
            items = []
            for part in parts:
                part = part.strip()
                if re.fullmatch(r"-?\d+", part):
                    items.append(int(part))
                elif part.startswith("'") or part.startswith('"'):
                    items.append(_unquote(part))
                else:
                    raise JsonPathError("无法解析的下标: %r" % part)
            return ("union", items)

        if re.fullmatch(r"-?\d+", inner):
            return ("index", int(inner))
        if inner.startswith("'") or inner.startswith('"'):
            return ("child", _unquote(inner))

        # 切片
        pieces = inner.split(":")
        if len(pieces) in (2, 3):
            values: list[int | None] = []
            for piece in pieces:
                piece = piece.strip()
                values.append(int(piece) if piece else None)
            while len(values) < 3:
                values.append(None)
            return ("slice", values[0], values[1], values[2])

        raise JsonPathError("无法解析的方括号内容: %r" % inner)


def _find_bracket_end(text: str, open_idx: int) -> int:
    depth = 0
    in_quote: str | None = None
    i = open_idx
    while i < len(text):
        ch = text[i]
        if in_quote:
            if ch == "\\":
                i += 2
                continue
            if ch == in_quote:
                in_quote = None
        elif ch in "'\"":
            in_quote = ch
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def _unquote(text: str) -> str:
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "'\"":
        return text[1:-1].replace("\\" + text[0], text[0])
    return text


def _split_top_level(text: str, sep: str) -> list[str]:
    out: list[str] = []
    depth = 0
    in_quote: str | None = None
    start = 0
    i = 0
    while i < len(text):
        ch = text[i]
        if in_quote:
            if ch == "\\":
                i += 2
                continue
            if ch == in_quote:
                in_quote = None
        elif ch in "'\"":
            in_quote = ch
        elif ch in "([":
            depth += 1
        elif ch in ")]":
            depth -= 1
        elif ch == sep and depth == 0:
            out.append(text[start:i])
            start = i + 1
        i += 1
    out.append(text[start:])
    return out


# ---------------------------------------------------------------------- #
# 过滤器表达式
# ---------------------------------------------------------------------- #
#  AST: ('or', a, b) / ('and', a, b) / ('not', a) / ('cmp', op, left, right)
#       / ('exists', path) / ('literal', value)
def _parse_predicate(expr: str):
    return _PredParser(expr).parse()


class _PredParser:
    def __init__(self, text: str) -> None:
        self.t = text
        self.i = 0

    def parse(self):
        node = self._or()
        self._skip_ws()
        if self.i < len(self.t):
            # 剩余内容无法识别，退化为整体字符串比较（尽量不抛）
            return ("raw", self.t)
        return node

    def _or(self):
        node = self._and()
        while True:
            self._skip_ws()
            if self.t.startswith("||", self.i):
                self.i += 2
                node = ("or", node, self._and())
            else:
                return node

    def _and(self):
        node = self._unary()
        while True:
            self._skip_ws()
            if self.t.startswith("&&", self.i):
                self.i += 2
                node = ("and", node, self._unary())
            else:
                return node

    def _unary(self):
        self._skip_ws()
        if self.t.startswith("!", self.i) and not self.t.startswith("!=", self.i):
            self.i += 1
            return ("not", self._unary())
        if self.t.startswith("(", self.i):
            self.i += 1
            node = self._or()
            self._skip_ws()
            if self.t.startswith(")", self.i):
                self.i += 1
            return node
        return self._comparison()

    def _comparison(self):
        left = self._operand()
        self._skip_ws()
        for op in ("==", "!=", "<=", ">=", "=~", "<", ">"):
            if self.t.startswith(op, self.i):
                self.i += len(op)
                right = self._operand()
                return ("cmp", op, left, right)
        self._skip_ws()
        for word in ("nin", "in", "empty"):
            if re.match(r"\b%s\b" % word, self.t[self.i:]) and (self.i == 0 or not self.t[self.i - 1].isalnum()):
                m = re.match(r"(%s)\b" % word, self.t[self.i:])
                self.i += m.end()
                self._skip_ws()
                if word == "empty":
                    return ("cmp", "empty", left, ("literal", None))
                right = self._operand()
                return ("cmp", word, left, right)
        return ("exists", left)

    def _operand(self):
        self._skip_ws()
        if self.i >= len(self.t):
            return ("literal", None)
        ch = self.t[self.i]
        if ch == "@" or ch == "$":
            self.i += 1
            start = self.i
            depth = 0
            while self.i < len(self.t):
                c = self.t[self.i]
                if c == "[":
                    depth += 1
                elif c == "]":
                    depth -= 1
                elif depth == 0 and c in " \t)&|<>=!":
                    break
                self.i += 1
            return ("path", self.t[start:self.i], ch)
        if ch == "/":
            end = self.t.find("/", self.i + 1)
            if end > 0:
                pattern = self.t[self.i + 1:end]
                self.i = end + 1
                flags = 0
                while self.i < len(self.t) and self.t[self.i] in "ims":
                    if self.t[self.i] == "i":
                        flags |= re.I
                    elif self.t[self.i] == "m":
                        flags |= re.M
                    elif self.t[self.i] == "s":
                        flags |= re.S
                    self.i += 1
                return ("regex", pattern, flags)
            return ("literal", "/")
        if ch in "'\"":
            quote = ch
            self.i += 1
            buf = []
            while self.i < len(self.t):
                c = self.t[self.i]
                if c == "\\" and self.i + 1 < len(self.t):
                    buf.append(self.t[self.i + 1])
                    self.i += 2
                    continue
                if c == quote:
                    self.i += 1
                    break
                buf.append(c)
                self.i += 1
            return ("literal", "".join(buf))
        m = re.match(r"-?\d+(?:\.\d+)?", self.t[self.i:])
        if m:
            text = m.group(0)
            self.i += m.end()
            return ("literal", float(text) if "." in text else int(text))
        m = re.match(r"(true|false|null)", self.t[self.i:])
        if m:
            self.i += m.end()
            return ("literal", {"true": True, "false": False, "null": None}[m.group(0)])
        return ("literal", None)

    def _skip_ws(self):
        while self.i < len(self.t) and self.t[self.i] in " \t\r\n":
            self.i += 1


# ---------------------------------------------------------------------- #
# 求值
# ---------------------------------------------------------------------- #
def _walk_recursive(node: Any, key: str | None) -> list[Any]:
    """``$..key``：深度优先收集所有匹配的键值（不含根自身）。"""
    out: list[Any] = []
    if isinstance(node, dict):
        for k, v in node.items():
            if key is None or k == key:
                out.append(v)
            out.extend(_walk_recursive(v, key))
    elif isinstance(node, list):
        for item in node:
            out.extend(_walk_recursive(item, key))
    return out


def _resolve_profile(root: Any, path: str, sigil: str) -> list[Any]:
    """解析过滤器里的 ``@.a.b`` / ``$.a``。"""
    steps = []
    p = "".join(["$", path])
    try:
        steps = _Parser(p).parse()
    except JsonPathError:
        return []
    nodes = [root]
    nodes = _apply_steps(nodes, steps)
    if sigil == "@":
        return nodes
    return nodes


def _apply_steps(nodes: list[Any], steps: list[tuple]) -> list[Any]:
    for step in steps:
        kind = step[0]
        if kind == "child":
            name = step[1]
            out = []
            for node in nodes:
                if isinstance(node, dict) and name in node:
                    out.append(node[name])
                elif isinstance(node, list):
                    for item in node:
                        if isinstance(item, dict) and name in item:
                            out.append(item[name])
            nodes = out
        elif kind == "wildcard":
            out = []
            for node in nodes:
                if isinstance(node, dict):
                    out.extend(node.values())
                elif isinstance(node, list):
                    out.extend(node)
            nodes = out
        elif kind == "index":
            out = []
            for node in nodes:
                if isinstance(node, list):
                    try:
                        out.append(node[step[1]])
                    except IndexError:
                        continue
            nodes = out
        elif kind == "union":
            out = []
            for node in nodes:
                if isinstance(node, list):
                    for idx in step[1]:
                        if isinstance(idx, int):
                            try:
                                out.append(node[idx])
                            except IndexError:
                                continue
                        elif isinstance(node, dict):
                            out.append(node.get(idx))
                elif isinstance(node, dict):
                    for key in step[1]:
                        if key in node:
                            out.append(node[key])
            nodes = out
        elif kind == "slice":
            out = []
            for node in nodes:
                if isinstance(node, list):
                    out.extend(node[step[1]:step[2]:step[3]])
            nodes = out
        elif kind == "recursive":
            out = []
            for node in nodes:
                out.extend(_walk_recursive(node, step[1]))
            nodes = out
        elif kind == "recursive_wildcard":
            out = []
            for node in nodes:
                out.extend(_walk_recursive(node, None))
            nodes = out
        elif kind == "filter":
            out = []
            for node in nodes:
                if isinstance(node, list):
                    for item in node:
                        if _eval_pred(step[1], item):
                            out.append(item)
                elif isinstance(node, dict):
                    for item in node.values():
                        if isinstance(item, (dict, list)) and _eval_pred(step[1], item):
                            out.append(item)
            nodes = out
        elif kind == "function":
            nodes = _apply_function(nodes, step[1], step[2])
        else:  # pragma: no cover
            nodes = []
    return nodes


def _apply_function(nodes: list[Any], name: str, args: str) -> list[Any]:
    name = name.lower()
    if name in ("length", "size"):
        out = []
        for node in nodes:
            if isinstance(node, (list, dict, str)):
                out.append(len(node))
            elif node is None:
                out.append(0)
            else:
                out.append(1)
        return out
    if name == "keys":
        out = []
        for node in nodes:
            if isinstance(node, dict):
                out.append(list(node.keys()))
        return out
    if name in ("min", "max", "avg", "sum"):
        out = []
        for node in nodes:
            seq = node if isinstance(node, list) else [node]
            nums = [x for x in seq if isinstance(x, (int, float)) and not isinstance(x, bool)]
            if not nums:
                continue
            if name == "min":
                out.append(min(nums))
            elif name == "max":
                out.append(max(nums))
            elif name == "sum":
                out.append(sum(nums))
            else:
                out.append(sum(nums) / len(nums))
        return out
    if name == "first":
        return nodes[:1]
    if name == "last":
        return nodes[-1:] if nodes else []
    if name == "concat":
        joined = ""
        for node in nodes:
            joined += str(node)
        return [joined]
    return nodes


def _eval_pred(node, item: Any) -> bool:
    kind = node[0]
    if kind == "or":
        return _eval_pred(node[1], item) or _eval_pred(node[2], item)
    if kind == "and":
        return _eval_pred(node[1], item) and _eval_pred(node[2], item)
    if kind == "not":
        return not _eval_pred(node[1], item)
    if kind == "exists":
        return bool(_operand_value(node[1], item))
    if kind == "cmp":
        op = node[1]
        left = _operand_value(node[2], item)
        right = _operand_value(node[3], item)
        if op == "=~":
            if isinstance(node[3], tuple) and node[3][0] == "regex":
                return bool(re.search(node[3][1], str(left), node[3][2])) if left is not None else False
            return bool(re.search(str(right), str(left))) if left is not None else False
        if op == "in":
            return left in right if isinstance(right, list) else False
        if op == "nin":
            return left not in right if isinstance(right, list) else True
        if op == "empty":
            return left in (None, "", [], {})
        return _compare(op, left, right)
    if kind == "raw":
        return False
    return False


def _operand_value(node, item: Any) -> Any:
    kind = node[0]
    if kind == "literal":
        return node[1]
    if kind == "regex":
        return node[1]
    if kind == "path":
        return _first_value(item, node[1])
    return None


def _first_value(item: Any, path: str) -> Any:
    try:
        steps = _Parser("$" + path).parse()
    except JsonPathError:
        return None
    nodes = _apply_steps([item], steps)
    return nodes[0] if nodes else None


def _compare(op: str, left: Any, right: Any) -> bool:
    if left is None or right is None:
        if op == "==":
            return left is None and right is None
        if op == "!=":
            return not (left is None and right is None)
    # 数值/字符串互转，模拟 jayway 的类型宽松比较
    if isinstance(left, str) and isinstance(right, (int, float)):
        try:
            left = float(left)
        except ValueError:
            return False
    if isinstance(right, str) and isinstance(left, (int, float)):
        try:
            right = float(right)
        except ValueError:
            return False
    if isinstance(left, bool) != isinstance(right, bool):
        return False
    try:
        if op == "==":
            return left == right
        if op == "!=":
            return left != right
        if op == "<":
            return left < right
        if op == "<=":
            return left <= right
        if op == ">":
            return left > right
        if op == ">=":
            return left >= right
    except TypeError:
        return False
    return False


# ---------------------------------------------------------------------- #
# 对外 API
# ---------------------------------------------------------------------- #
class JsonPathResult:
    def __init__(self, value: Any, values: list[Any], definite: bool) -> None:
        self.value = value
        self.values = values
        self.definite = definite


_DEFINITE_STEPS = {"child", "index", "function"}


def read(root: Any, path: str) -> JsonPathResult:
    if isinstance(root, str):
        try:
            root = json.loads(root)
        except Exception as exc:
            raise JsonPathError("内容不是合法 JSON: %s" % exc) from exc
    steps = _Parser(path).parse()
    definite = all(s[0] in _DEFINITE_STEPS for s in steps)
    values = _apply_steps([root], steps)
    value = values[0] if (definite and values) else None
    return JsonPathResult(value, values, definite)


def as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        if value != int(value):
            return repr(value)
        return "%.1f" % value
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)
