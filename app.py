# -*- coding: utf-8 -*-
"""
考研单词记忆 - 桌面应用版
使用 PyWebView 实现本地离线数据持久化
"""

import os
import sys
import json
import time
import webview
from pathlib import Path


def get_app_dir():
    """获取应用根目录（支持打包后的路径）"""
    if getattr(sys, 'frozen', False):
        # PyInstaller 打包后的路径
        return Path(sys.executable).parent
    else:
        # 开发环境下的路径
        return Path(__file__).parent


def get_resource_dir():
    """获取资源目录（HTML等只读文件）"""
    if getattr(sys, 'frozen', False):
        # PyInstaller 打包后，资源在 _MEIPASS 临时目录
        return Path(sys._MEIPASS)
    else:
        return Path(__file__).parent


class DataStore:
    """本地数据存储管理器"""

    def __init__(self):
        # 数据目录（始终在可执行文件旁边）
        self.data_dir = get_app_dir() / "data"
        self.data_dir.mkdir(exist_ok=True)

        # 数据文件路径
        self.stats_file = self.data_dir / "stats.json"
        self.wordbook_file = self.data_dir / "wordbook.json"
        self.mistakes_file = self.data_dir / "mistakes.json"
        self.ebbinghaus_file = self.data_dir / "ebbinghaus.json"
        self.progress_file = self.data_dir / "progress.json"
        self.daily_log_file = self.data_dir / "daily_log.json"

        # 初始化数据
        self._init_data()

    def _init_data(self):
        """初始化数据文件"""
        for file_path in [
            self.stats_file,
            self.wordbook_file,
            self.mistakes_file,
            self.ebbinghaus_file,
            self.progress_file,
            self.daily_log_file,
        ]:
            if not file_path.exists():
                self._save_json(file_path, {})

    def _load_json(self, file_path: Path) -> dict:
        """加载 JSON 文件"""
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, FileNotFoundError):
            return {}

    def _save_json(self, file_path: Path, data: dict):
        """保存 JSON 文件"""
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    # ========== 生词本 ==========
    def get_wordbook(self) -> list:
        """获取生词本"""
        data = self._load_json(self.wordbook_file)
        return data.get("words", [])

    def add_to_wordbook(self, word_json: str) -> str:
        """添加到生词本"""
        word = json.loads(word_json)
        data = self._load_json(self.wordbook_file)
        words = data.get("words", [])

        # 检查是否已存在
        if not any(w["en"] == word["en"] for w in words):
            word["addedAt"] = int(time.time() * 1000)
            words.append(word)
            data["words"] = words
            self._save_json(self.wordbook_file, data)

        return json.dumps({"success": True, "count": len(words)})

    def remove_from_wordbook(self, word_en: str) -> str:
        """从生词本移除"""
        data = self._load_json(self.wordbook_file)
        words = data.get("words", [])
        words = [w for w in words if w["en"] != word_en]
        data["words"] = words
        self._save_json(self.wordbook_file, data)
        return json.dumps({"success": True, "count": len(words)})

    def save_wordbook_json(self, wordbook_json: str) -> str:
        """批量保存生词本（接受 JSON 字符串）"""
        words = json.loads(wordbook_json)
        self._save_json(self.wordbook_file, {"words": words})
        return json.dumps({"success": True, "count": len(words)})

    # ========== 错题本 ==========
    def get_mistakes(self) -> list:
        """获取错题本"""
        data = self._load_json(self.mistakes_file)
        return data.get("words", [])

    def add_to_mistakes(self, word_json: str) -> str:
        """添加到错题本"""
        word = json.loads(word_json)
        data = self._load_json(self.mistakes_file)
        words = data.get("words", [])

        # 查找是否已存在
        existing = next((w for w in words if w["en"] == word["en"]), None)
        if existing:
            existing["count"] = existing.get("count", 1) + 1
            existing["lastWrongAt"] = int(time.time() * 1000)
        else:
            word["count"] = 1
            word["lastWrongAt"] = int(time.time() * 1000)
            words.append(word)

        data["words"] = words
        self._save_json(self.mistakes_file, data)
        return json.dumps({"success": True, "count": len(words)})

    def remove_from_mistakes(self, word_en: str) -> str:
        """从错题本移除"""
        data = self._load_json(self.mistakes_file)
        words = data.get("words", [])
        words = [w for w in words if w["en"] != word_en]
        data["words"] = words
        self._save_json(self.mistakes_file, data)
        return json.dumps({"success": True, "count": len(words)})

    def save_mistakes_json(self, mistakes_json: str) -> str:
        """批量保存错题本（接受 JSON 字符串）"""
        words = json.loads(mistakes_json)
        self._save_json(self.mistakes_file, {"words": words})
        return json.dumps({"success": True, "count": len(words)})

    # ========== 学习进度 ==========
    def get_progress(self, chapter: int) -> dict:
        """获取章节学习进度"""
        data = self._load_json(self.progress_file)
        chapter_key = str(chapter)
        return data.get(chapter_key, {
            "queue": [],
            "index": 0,
            "wordStats": {},
            "sessionStats": {"correct": 0, "total": 0, "reviewCount": 0}
        })

    def save_progress(self, chapter: int, progress_json: str) -> str:
        """保存章节学习进度"""
        progress = json.loads(progress_json)
        data = self._load_json(self.progress_file)
        data[str(chapter)] = progress
        self._save_json(self.progress_file, data)
        return json.dumps({"success": True})

    def get_all_stats(self) -> dict:
        """获取所有章节的统计"""
        return self._load_json(self.stats_file)

    def save_chapter_stats(self, chapter: int, stats_json: str) -> str:
        """保存章节统计"""
        stats = json.loads(stats_json)
        data = self._load_json(self.stats_file)
        data[str(chapter)] = stats
        self._save_json(self.stats_file, data)
        return json.dumps({"success": True})

    # ========== 艾宾浩斯复习 ==========
    def get_ebbinghaus(self) -> dict:
        """获取艾宾浩斯复习计划"""
        return self._load_json(self.ebbinghaus_file)

    def update_ebbinghaus(self, word_en: str, is_correct: bool) -> str:
        """更新艾宾浩斯复习计划"""
        data = self._load_json(self.ebbinghaus_file)
        now = int(time.time() * 1000)

        # 艾宾浩斯间隔（毫秒）
        intervals = [
            20 * 60 * 1000,       # 20分钟
            1 * 60 * 60 * 1000,   # 1小时
            9 * 60 * 60 * 1000,   # 9小时
            1 * 24 * 60 * 60 * 1000,  # 1天
            2 * 24 * 60 * 60 * 1000,  # 2天
            6 * 24 * 60 * 60 * 1000,  # 6天
            31 * 24 * 60 * 60 * 1000  # 31天
        ]

        if word_en not in data:
            data[word_en] = {
                "stage": 0,
                "nextReview": now + intervals[0],
                "lastReview": now
            }

        record = data[word_en]

        if is_correct:
            record["stage"] = min(record["stage"] + 1, len(intervals) - 1)
        else:
            record["stage"] = 0

        record["nextReview"] = now + intervals[record["stage"]]
        record["lastReview"] = now

        data[word_en] = record
        self._save_json(self.ebbinghaus_file, data)

        return json.dumps({"success": True, "record": record})

    # ========== 数据导入导出 ==========
    def export_all_data(self) -> str:
        """导出所有数据"""
        export_data = {
            "version": "1.0",
            "exportDate": int(time.time() * 1000),
            "wordbook": self.get_wordbook(),
            "mistakes": self.get_mistakes(),
            "stats": self._load_json(self.stats_file),
            "progress": self._load_json(self.progress_file),
            "ebbinghaus": self.get_ebbinghaus()
        }
        return json.dumps(export_data, ensure_ascii=False)

    def import_data(self, data_json: str) -> str:
        """导入数据"""
        try:
            data = json.loads(data_json)

            if "wordbook" in data:
                self._save_json(self.wordbook_file, {"words": data["wordbook"]})

            if "mistakes" in data:
                self._save_json(self.mistakes_file, {"words": data["mistakes"]})

            if "stats" in data:
                self._save_json(self.stats_file, data["stats"])

            if "progress" in data:
                self._save_json(self.progress_file, data["progress"])

            if "ebbinghaus" in data:
                self._save_json(self.ebbinghaus_file, data["ebbinghaus"])

            return json.dumps({"success": True, "message": "导入成功"})
        except Exception as e:
            return json.dumps({"success": False, "message": f"导入失败: {str(e)}"})

    # ========== 每日进度日志 ==========
    def get_daily_log(self) -> dict:
        """获取每日进度日志"""
        return self._load_json(self.daily_log_file)

    def save_daily_log_json(self, log_json: str) -> str:
        """保存每日进度日志"""
        data = json.loads(log_json)
        self._save_json(self.daily_log_file, data)
        return json.dumps({"success": True})

    def get_data_dir(self) -> str:
        """获取数据目录路径"""
        return str(self.data_dir)


def main():
    """主函数"""
    # 创建数据存储实例
    store = DataStore()

    # 获取 HTML 文件路径（从资源目录读取）
    html_file = get_resource_dir() / "index.html"

    if not html_file.exists():
        print(f"错误: 找不到 {html_file}")
        return

    # 创建窗口
    window = webview.create_window(
        title="考研单词记忆",
        url=str(html_file),
        js_api=store,
        width=1200,
        height=800,
        min_size=(800, 600),
        resizable=True,
        text_select=True
    )

    # 启动应用
    webview.start(debug=False)


if __name__ == "__main__":
    main()
