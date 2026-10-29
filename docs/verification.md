# 验证记录

本记录对应 0.2.3。环境为 macOS、Node.js 24.19.0、DeepSeek Harness 0.2.1-rc.2、Google Chrome 156.0.8078.48、Playwright 1.62.1。

## 已完成

| 验证 | 结果 |
| --- | --- |
| 单元与组件测试 | 63 项全部通过，0 跳过 |
| 真实 Harness 插件安装 | 从预构建 tgz 通过 dsh plugin 安装，插件自动加入 Web profile 的 bundles |
| 真实 Web 与模型服务 | 使用 Harness 的原生会话、编辑器、插槽、LLM 服务和 HTTP/SSE 路由，未拦截预测接口 |
| 浏览器交互 | 常规 12 项＋会话切换 4 项＋光标 4 项＋速度 4 项，共 24 项全部通过，无 pageerror |
| 实际 HTTP 认证 | 未带认证信息的 POST /composer-autocomplete/v2 返回 401 |
| 打包 | 入口、模块 ID、bundle patch 和必需文件通过校验；生产包无运行时 npm 依赖 |
| 视觉检查 | 已查看浅色续写、设置页、深色窄窗口截图，灰字与 Tab 提示位于编辑器内 |

63 项回归覆盖：双端注册、请求认证、请求体校验、候选清洗、工具上下文、路由和推理参数、逐会话/草稿缓存、超时和断流、请求取消、卸载清理、UTF-8 与 CRLF 分块、过期响应、中文输入法、运行中抑制、开关和延迟的持久化；完整候选提前发布和采纳、按会话序号复用上下文、NONE 缓存与到期失效、缓存容量限制、页面后台取消以及空闲 SSE 读取器释放。

0.2.3 新增快速模式提前终止、适配器取消异常、两种模式的缓存隔离、缩小上下文，以及中文、英文词内、下一句候选、无效编辑与完整消耗候选的复用验证。

0.2.1 新增切换后清理执行前的显示与 Tab 隔离、旧会话晚到响应、A → B → A 快速切换、旧定时器及相同会话序号下的结果／上下文缓存隔离。会话推进后验证旧缓存失效；返回未变化的另一会话仍可命中自己的缓存。

12 项浏览器验证覆盖：回复后下一句灰字、Alt+方向键切换候选、Tab 只插入草稿、中英文续写、Esc 关闭、IME 组合与恢复、其他控件的组合事件隔离、原生 /命令与 @引用、深色与窄窗口、设置与刷新后保存、无浏览器脚本异常；新增在其他候选仍生成时采纳完整首条，并取消余下模型调用。IME 使用合成 composition 事件，未使用操作系统的真实输入法候选窗。

另有 4 项真实浏览器检查：使用不同的 ALPHA／BETA 会话预测反复切换，确认双方实际命中各自缓存；在慢预测期间切换后 Tab 只采纳当前会话内容；推进 ALPHA 新一轮对话后更新缓存并保留 BETA 缓存；切换保持草稿且没有浏览器异常。均经真实 Harness LLM 服务与 SSE 执行，没有拦截预测接口。

0.2.2 补充 4 项原生光标检查：下一句提示、输入续写、Tab 采纳后的方向键和继续输入、鼠标重新定位后编辑。截图设置 `caret: 'initial'` 保留光标，仅在测试中暂停闪烁，不改变原生光标颜色或位置；通过 Pillow 核对选择区实际坐标处的光标像素。恢复旧层级后像素检查失败，修复后的四张截图均通过。

0.2.3 的 4 项浏览器检查验证默认快速模式的一条候选、从下一句转为输入续写、英文单词内后缀、中文非组合态文本插入的复用，以及不同输入触发新请求。六次匹配输入测得 11 ms 中位数，没有新增预测请求；未使用操作系统的输入法候选窗来测复用。

结果 JSON 存在 [常规检查](benchmarks/browser-results.json)、[会话切换检查](benchmarks/session-switch-results.json)、[光标检查](benchmarks/caret-results.json) 和 [速度检查](benchmarks/speed-results.json)，截图保留在本地 `artifacts/` 中。`test/`、测试模型、node_modules、临时 profile、认证信息和浏览器数据均未进入生产安装包。

## 模型验证范围

使用 `tools/fixtures/model/` 中的确定性本地适配器通过 **真实 ctx.llm** 提供流式输出，验证完整链路；未使用 DeepSeek API key、未调用付费云模型。真实 DeepSeek 模型的生成质量、延迟、计费及官方 Electron 桌面端尚未实测。Web 使用原生输入框插槽；兼容性证据仅覆盖 0.2.1-rc.2。

## GitHub 发布验收

- [GitHub Releases](https://github.com/liangzhiyu/dsh-composer-autocomplete/releases) 提供安装包和 SHA256SUMS，可下载后核对。
- [CI](https://github.com/liangzhiyu/dsh-composer-autocomplete/actions/workflows/ci.yml) 覆盖 Ubuntu、macOS、Windows，各运行 Node.js 24.9.0 和 26，共六组单元／组件测试与打包检查；这不代表六组浏览器实机验证。
- 本地验证前，预构建包通过 dsh plugin 安装到隔离 Web profile，bundle 自动注册；已安装的运行时代码与验证源码一致。

## 复现

单元测试与生产包检查，在项目根目录执行：

```sh
node --test test/*.test.mjs
node tools/check-package.mjs
pnpm pack --pack-destination artifacts
```

真实浏览器验证需要已安装的 dsh 0.2.1-rc.2 与 Google Chrome。使用单独的测试目录保存 Harness 数据，避免影响日常配置：

```sh
pnpm install --frozen-lockfile
mkdir -p .verification
pnpm --dir tools/fixtures/model pack --pack-destination ../../../artifacts
export DSH_HOME="$PWD/.verification/home"
dsh plugin --profile web add "$PWD/artifacts/dsh-composer-autocomplete-0.2.3.tgz" "$PWD/artifacts/dsh-autocomplete-fixture-model-0.0.0.tgz"
dsh web --port 3087 --no-open > .verification/harness.log 2>&1
```

然后在另一个终端的项目根目录运行：

```sh
DSH_URL=http://127.0.0.1:3087 node tools/browser-smoke.mjs
DSH_URL=http://127.0.0.1:3087 node tools/session-switch-smoke.mjs
DSH_URL=http://127.0.0.1:3087 node tools/caret-smoke.mjs
DSH_URL=http://127.0.0.1:3087 node tools/speed-smoke.mjs
```

可选截图像素核验（需要 Pillow）：`python3 tools/verify-caret-pixels.py`。

脚本从上述本地日志读取启动认证信息，不将其打印到输出，并且只向名为 Autocomplete fixture 的本地测试模型发送测试消息。验证结束后停止该测试实例。首次安装 Harness 的原生依赖时，按其官方安装说明完成依赖构建。
