"""最小数据模型：书源 / 书籍 / 章节 / 规则数据。

Legado 的这几个类都实现 ``RuleDataInterface``（一套 ``getVariable`` /
``putVariable`` 的键值存储），``AnalyzeRule`` 的 ``put`` / ``get`` 正是沿着
"chapter → book → ruleData → source" 这条链找变量的。这里保持同样的顺序。
"""

from __future__ import annotations

from typing import Any


class Variables:
    def __init__(self) -> None:
        self.vars: dict[str, Any] = {}

    def get_variable(self, key: str) -> str:
        value = self.vars.get(key)
        if value is None:
            return ""
        return value if isinstance(value, str) else str(value)

    def put_variable(self, key: str, value: Any) -> None:
        self.vars[key] = value

    def get(self, key: str) -> str:
        return self.get_variable(key)

    def put(self, key: str, value: Any) -> None:
        self.put_variable(key, value)


class RuleData(Variables):
    pass


class BaseSource(Variables):
    """书源本体（只保留规则解析真正用得到的字段）。"""

    def __init__(
        self,
        book_source_url: str = "",
        book_source_name: str = "",
        js_lib: str | None = None,
    ) -> None:
        super().__init__()
        self.book_source_url = book_source_url
        self.book_source_name = book_source_name
        self.js_lib = js_lib

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BaseSource":
        return cls(
            book_source_url=data.get("bookSourceUrl", ""),
            book_source_name=data.get("bookSourceName", ""),
            js_lib=data.get("jsLib"),
        )


class Book(Variables):
    def __init__(
        self,
        name: str = "",
        author: str = "",
        book_url: str = "",
        origin: str = "",
    ) -> None:
        super().__init__()
        self.name = name
        self.author = author
        self.book_url = book_url
        self.origin = origin
        self.cover_url = ""
        self.intro = ""
        self.kind = ""
        self.last_chapter = ""


class BookChapter(Variables):
    def __init__(self, title: str = "", url: str = "", book_url: str = "") -> None:
        super().__init__()
        self.title = title
        self.url = url
        self.book_url = book_url
        self.index = 0
