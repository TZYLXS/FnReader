"""legado_rule —— Legado（「阅读」App）书源规则解析器的 Python 版。

对外只需要两样东西：

    from legado_rule import AnalyzeRule
    rule = AnalyzeRule()
    rule.set_content(html, "https://example.com/book/1")
    rule.get_string(".book@text")

以及把整条链路跑通、直接产出前端参数的门面：

    from legado_rule import BookSourceEngine
    engine = BookSourceEngine(source_json)
    engine.search("斗罗大陆")
"""

from .analyze_by_jsoup import AnalyzeByJSoup
from .analyze_by_jsonpath import AnalyzeByJSonPath
from .analyze_by_regex import AnalyzeByRegex
from .analyze_by_xpath import AnalyzeByXPath
from .analyze_rule import AnalyzeRule
from .book_source import BookSourceEngine
from .js_engine import JsEngine
from .models import Book, BookChapter, BaseSource, RuleData
from .rule_analyzer import RuleAnalyzer
from .source_rule import Mode, SourceRule

__all__ = [
    "AnalyzeRule",
    "AnalyzeByJSoup",
    "AnalyzeByXPath",
    "AnalyzeByJSonPath",
    "AnalyzeByRegex",
    "RuleAnalyzer",
    "SourceRule",
    "Mode",
    "BookSourceEngine",
    "JsEngine",
    "Book",
    "BookChapter",
    "BaseSource",
    "RuleData",
]

__version__ = "1.0.0"
