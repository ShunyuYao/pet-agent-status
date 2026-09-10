#!/usr/bin/env node
// 移植 stub：外部仓无飞书封装，熔断通知只打日志（监工经 cron 轮询接管人工裁决）。
console.log("[notify-halt] (stub)", process.argv.slice(2).join(" "));
