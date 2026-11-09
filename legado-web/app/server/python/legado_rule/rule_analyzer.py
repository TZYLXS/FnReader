"""规则切分器 —— RuleAnalyzer.kt 的逐行移植。

Legado 的切分器刻意不用正则，而是自己维护一个游标 (pos/start/startX) 在
原始字符串上扫描。这样做有两个目的：

1. 规则里的 ``&&`` / ``||`` / ``%%`` 只有在"规则层级"才是分隔符，
   出现在 CSS 选择器 ``[attr="a&&b"]``、XPath 谓词、JSONPath 过滤器里的
   分隔符必须被跳过。遇到 ``[`` 或 ``(`` 时改用平衡组扫描即可实现。
2. 切分过程不产生中间字符串，只在返回时切片。

平衡组有两套实现，由构造参数 ``code`` 决定，这是最容易混淆的地方：

* ``chomp_rule_balanced``  —— 用于 CSS / XPath。引号内不处理转义，
  引号外 ``\\`` 转义下一个字符；只平衡传入的 open/close 两个字符。
* ``chomp_code_balanced``  —— 用于 JSONPath / JS。额外平衡 ``[`` ``]``，
  并且只有当 ``[]`` 深度为 0 时才统计 open/close 深度；引号处理同样是
  "谁在里面就忽略另一个"，但遇到 ``\\`` 时直接跳过下一个字符。
"""

from __future__ import annotations

from typing import Callable

ESC = "\\"


class RuleAnalyzerError(ValueError):
    """平衡组未闭合。对应 Kotlin 里的 ``throw Error("...后未平衡")``。"""


class RuleAnalyzer:
    """按 Legado 的游标扫描算法切分规则字符串。"""

    def __init__(self, data: str, code: bool = False) -> None:
        self.queue: str = data or ""
        self.pos: int = 0
        self.start: int = 0
        self.start_x: int = 0
        self.rule: list[str] = []
        self.step: int = 0
        self.elements_type: str = ""
        self.code: bool = code
        # Kotlin: val chompBalanced = if (code) ::chompCodeBalanced else ::chompRuleBalanced
        self.chomp_balanced: Callable[[str, str], bool] = (
            self.chomp_code_balanced if code else self.chomp_rule_balanced
        )

    # ------------------------------------------------------------------ #
    # 游标基础操作
    # ------------------------------------------------------------------ #
    def trim(self) -> None:
        """修剪当前规则之前的 ``@`` 或者空白符。

        对应 Kotlin 的 ``trim()``。注意它同时推进 ``start`` 与 ``startX``，
        而不是只推进游标。
        """
        n = len(self.queue)
        if self.pos >= n:
            return
        ch = self.queue[self.pos]
        if ch == "@" or ord(ch) < ord("!"):
            self.pos += 1
            while self.pos < n:
                ch = self.queue[self.pos]
                if ch == "@" or ord(ch) < ord("!"):
                    self.pos += 1
                else:
                    break
            self.start = self.pos
            self.start_x = self.pos

    def reset_pos(self) -> None:
        """对应 ``reSetPos()``：把 pos 归零以便复用同一个解析器。"""
        self.pos = 0
        self.start_x = 0

    def consume_to(self, seq: str) -> bool:
        """从剩余字串中拉出一个字符串，直到但不包括 ``seq``（区分大小写）。

        成功时 ``start`` 指向本段起点、``pos`` 指向分隔符起点。
        """
        self.start = self.pos
        offset = self.queue.find(seq, self.pos)
        if offset != -1:
            self.pos = offset
            return True
        return False

    def consume_to_any(self, *seq: str) -> bool:
        """匹配参数列表中任意一项即成功，同时把命中项长度记到 ``step``。"""
        pos = self.pos
        n = len(self.queue)
        while pos != n:
            for s in seq:
                if self.queue.startswith(s, pos):
                    self.step = len(s)
                    self.pos = pos
                    return True
            pos += 1
        return False

    def find_to_any(self, *chars: str) -> int:
        """返回剩余字串中第一个命中的字符下标，没有则 -1（不修改 pos）。"""
        pos = self.pos
        n = len(self.queue)
        while pos != n:
            if self.queue[pos] in chars:
                return pos
            pos += 1
        return -1

    # ------------------------------------------------------------------ #
    # 平衡组
    # ------------------------------------------------------------------ #
    def chomp_code_balanced(self, open_ch: str, close_ch: str) -> bool:
        """代码平衡组（JSONPath / JS）。"""
        pos = self.pos
        n = len(self.queue)
        depth = 0
        other_depth = 0
        in_single_quote = False
        in_double_quote = False

        while True:
            if pos == n:
                break
            c = self.queue[pos]
            pos += 1
            if c != ESC:
                if c == "'" and not in_double_quote:
                    in_single_quote = not in_single_quote
                elif c == '"' and not in_single_quote:
                    in_double_quote = not in_double_quote

                if in_single_quote or in_double_quote:
                    if not (depth > 0 or other_depth > 0):
                        break
                    continue

                if c == "[":
                    depth += 1
                elif c == "]":
                    depth -= 1
                elif depth == 0:
                    if c == open_ch:
                        other_depth += 1
                    elif c == close_ch:
                        other_depth -= 1
            else:
                pos += 1
            if not (depth > 0 or other_depth > 0):
                break

        if depth > 0 or other_depth > 0:
            return False
        self.pos = pos
        return True

    def chomp_rule_balanced(self, open_ch: str, close_ch: str) -> bool:
        """规则平衡组（CSS / XPath）。"""
        pos = self.pos
        n = len(self.queue)
        depth = 0
        in_single_quote = False
        in_double_quote = False

        while True:
            if pos == n:
                break
            c = self.queue[pos]
            pos += 1
            if c == "'" and not in_double_quote:
                in_single_quote = not in_single_quote
            elif c == '"' and not in_single_quote:
                in_double_quote = not in_double_quote

            if in_single_quote or in_double_quote:
                if not depth > 0:
                    break
                continue
            elif c == ESC:
                pos += 1
                if not depth > 0:
                    break
                continue

            if c == open_ch:
                depth += 1
            elif c == close_ch:
                depth -= 1

            if not depth > 0:
                break

        if depth > 0:
            return False
        self.pos = pos
        return True

    # ------------------------------------------------------------------ #
    # 切分
    # ------------------------------------------------------------------ #
    def split_rule(self, *split: str) -> list[str]:
        """按分隔符切分规则，返回规则片段列表（已去掉分隔符）。

        * 只传一个分隔符时走"首段匹配"分支（:meth:`_split_rule_next`）；
        * 传多个分隔符时先 ``consumeToAny`` 试探一次，命中哪一项就把
          ``elementsType`` 定为哪一项，之后整条规则都按这个分隔符切。
          这就是 ``"&&"``、``"||"``、``"%%"`` 混用时"以首次出现的为准"的来源。
        """
        if not split:
            raise TypeError("split_rule requires at least one separator")

        while True:
            if len(split) == 1:
                self.elements_type = split[0]
                if not self.consume_to(self.elements_type):
                    self.rule.append(self.queue[self.start_x:])
                    return self.rule
                self.step = len(self.elements_type)
                return self._split_rule_next()

            if not self.consume_to_any(*split):
                self.rule.append(self.queue[self.start_x:])
                return self.rule

            end = self.pos
            self.pos = self.start

            while True:
                st = self.find_to_any("[", "(")

                if st == -1:
                    self.rule = [self.queue[self.start_x:end]]
                    self.elements_type = self.queue[end:end + self.step]
                    self.pos = end + self.step
                    while self.consume_to(self.elements_type):
                        self.rule.append(self.queue[self.start:self.pos])
                        self.pos += self.step
                    self.rule.append(self.queue[self.pos:])
                    return self.rule

                if st > end:
                    self.rule = [self.queue[self.start_x:end]]
                    self.elements_type = self.queue[end:end + self.step]
                    self.pos = end + self.step
                    while self.consume_to(self.elements_type) and self.pos < st:
                        self.rule.append(self.queue[self.start:self.pos])
                        self.pos += self.step
                    if self.pos > st:
                        self.start_x = self.start
                        return self._split_rule_next()
                    self.rule.append(self.queue[self.pos:])
                    return self.rule

                self.pos = st
                next_ch = "]" if self.queue[self.pos] == "[" else ")"
                if not self.chomp_balanced(self.queue[self.pos], next_ch):
                    raise RuleAnalyzerError(
                        self.queue[:self.start] + "后未平衡"
                    )
                if not end > self.pos:
                    break

            self.start = self.pos
            # Kotlin: return splitRule(*split) —— 回到循环顶部重新 consumeToAny

    def _split_rule_next(self) -> list[str]:
        """二段匹配：``elementsType`` 已确定，直接按它查找，比首段更快。"""
        while True:
            end = self.pos
            self.pos = self.start

            while True:
                st = self.find_to_any("[", "(")

                if st == -1:
                    self.rule.append(self.queue[self.start_x:end])
                    self.pos = end + self.step
                    while self.consume_to(self.elements_type):
                        self.rule.append(self.queue[self.start:self.pos])
                        self.pos += self.step
                    self.rule.append(self.queue[self.pos:])
                    return self.rule

                if st > end:
                    self.rule.append(self.queue[self.start_x:end])
                    self.pos = end + self.step
                    while self.consume_to(self.elements_type) and self.pos < st:
                        self.rule.append(self.queue[self.start:self.pos])
                        self.pos += self.step
                    if self.pos > st:
                        self.start_x = self.start
                        break  # 递归 splitRule()：重跑外层
                    self.rule.append(self.queue[self.pos:])
                    return self.rule

                self.pos = st
                next_ch = "]" if self.queue[self.pos] == "[" else ")"
                if not self.chomp_balanced(self.queue[self.pos], next_ch):
                    raise RuleAnalyzerError(
                        self.queue[:self.start] + "后未平衡"
                    )
                if not end > self.pos:
                    break

            self.start = self.pos
            if not self.consume_to(self.elements_type):
                self.rule.append(self.queue[self.start_x:])
                return self.rule

    # ------------------------------------------------------------------ #
    # 内嵌规则替换
    # ------------------------------------------------------------------ #
    def inner_rule(
        self,
        inner: str,
        start_step: int = 1,
        end_step: int = 1,
        fr: Callable[[str], "str | None"] | None = None,
    ) -> str:
        """替换 ``{$...}`` 形式的嵌套规则（JSONPath 用）。

        返回值语义：如果一次都没有成功替换，返回空串（Kotlin 用 ``startX == 0``
        判断），调用方据此决定"整条规则是否就是内嵌规则"。
        """
        if fr is None:
            raise TypeError("inner_rule requires a callback")
        st: list[str] = []
        while self.consume_to(inner):
            pos_pre = self.pos
            if self.chomp_code_balanced("{", "}"):
                frv = fr(self.queue[pos_pre + start_step:self.pos - end_step])
                if frv:
                    st.append(self.queue[self.start_x:pos_pre] + frv)
                    self.start_x = self.pos
                    continue
            self.pos += len(inner)

        if self.start_x == 0:
            return ""
        st.append(self.queue[self.start_x:])
        return "".join(st)

    def inner_rule_pair(
        self,
        start_str: str,
        end_str: str,
        fr: Callable[[str], "str | None"],
    ) -> str:
        """按"起始串 + 结束串"替换内嵌规则（``{{ }}`` 形式的备用实现）。"""
        st: list[str] = []
        while self.consume_to(start_str):
            self.pos += len(start_str)
            pos_pre = self.pos
            if self.consume_to(end_str):
                frv = fr(self.queue[pos_pre:self.pos])
                st.append(self.queue[self.start_x:pos_pre - len(start_str)] + (frv or ""))
                self.pos += len(end_str)
                self.start_x = self.pos

        if self.start_x == 0:
            return self.queue
        st.append(self.queue[self.start_x:])
        return "".join(st)
