# Smart Piano V2

Smart Piano V2 是一款运行在浏览器里的智能钢琴练习助手，当前界面针对
Yamaha PSR-E383 的 61 键范围做了优化，也支持鼠标、触屏和 Web MIDI
设备输入。项目可以导入 MusicXML、MIDI 和 JSON 曲谱，并在本地保存曲谱库。

## 功能概览

| 功能 | 说明 |
| --- | --- |
| 虚拟键盘 | 61 键可视化钢琴，支持鼠标点击、触屏演奏和 MIDI 输入 |
| 曲谱导入 | 支持 MusicXML (`.xml`)、压缩 MusicXML (`.mxl`)、MIDI (`.mid/.midi`) 和 JSON |
| 本地曲谱库 | 使用 IndexedDB 保存已导入曲谱，刷新页面后仍可继续使用 |
| 自动播放 | 按曲谱节拍自动演奏，并同步高亮虚拟琴键 |
| 练习模式 | 等待用户弹对当前音符后才推进，适合跟谱练习 |
| 瀑布模式 | 音符从上向下落到琴键判定线，并与下方真实琴键位置对齐 |
| 节拍器 | 使用当前 BPM 播放节拍提示音 |
| BPM 控制 | 支持 10 到 300 BPM，MIDI 文件可自动读取 tempo |
| 真实音色 | 使用 Soundfont Player 加载 acoustic grand piano 音色 |
| PWA 缓存 | 通过 Service Worker 缓存核心资源和音色文件 |

## 快速开始

### 环境要求

- Chrome 89+ 或 Edge 89+。
- 使用外部 MIDI 键盘时，需要浏览器支持 Web MIDI API。
- 首次加载钢琴音色需要联网，音色资源缓存后再次打开会更快。
- 请通过 HTTP 本地服务访问页面，不要直接双击 `index.html`。

### 本地运行

从仓库根目录运行：

```bash
start-smart-piano.bat
```

或者手动启动静态服务：

```bash
cd SmartPianoV2
python -m http.server 8080
```

然后打开：

```text
http://127.0.0.1:8080/
```

## 使用方式

### 1. 导入曲谱

点击顶部的 `Add Sheet / Import MIDI`，选择 `.xml`、`.mxl`、`.mid`、`.midi`
或 `.json` 文件。导入成功后，曲谱会自动保存到本地曲谱库。

### 2. 选择模式

通过 `Mode Select` 下拉框切换模式：

| 模式 | 说明 |
| --- | --- |
| Play | 横向时间轴自动播放，适合听曲或跟随练习 |
| Practice | 等待弹对当前音符后再继续，适合逐音练习 |
| Waterfall | 瀑布式下落音符，音符横向位置对应下方虚拟琴键 |
| Metronome | 只播放节拍器提示音 |

瀑布模式下也可以点击独立的 `Waterfall` 按钮快速切换。该模式会根据下方
虚拟键盘的 DOM 位置计算每个音符的下落轨道，因此白键和黑键都会落到对应
琴键中心。

### 3. 播放和控制

- 点击 `播放` 开始当前模式。
- 点击 `暂停` 暂停播放。
- 点击 `重置` 回到曲谱开头。
- 在 `Beat Control (BPM)` 中输入新数值可调整速度。
- 打开 `Metronome` 开关可进入并播放节拍器模式。

### 4. 连接 MIDI 键盘

1. 用 USB 将 MIDI 键盘连接到电脑。
2. 在浏览器权限弹窗中允许 MIDI 访问。
3. 顶部设备状态显示已连接后即可弹奏。

项目会过滤 Yamaha PSR-E383 的心跳包和时钟信号，避免这些系统消息误触发
音符事件。

## 支持的曲谱格式

### MusicXML

支持 MuseScore、Finale、Sibelius、Dorico 等软件导出的 `.xml` 或 `.mxl`
文件。

### MIDI

- 支持 `.mid` 和 `.midi`。
- 自动解析 tempo 元事件。
- 多轨道文件会合并为统一播放序列。

### JSON

示例：

```json
{
  "name": "小星星",
  "bpm": 100,
  "data": [
    { "note": "C4", "duration": 1, "fingering": 1 },
    { "note": "C4", "duration": 1, "fingering": 1 },
    { "note": "G4", "duration": 1, "fingering": 5 },
    { "note": "G4", "duration": 1, "fingering": 5 }
  ]
}
```

字段说明：

- `note`：音名，例如 `C4`、`F#3`、`Bb5`。
- `duration`：以四分音符为 1 的时值。
- `durationBeat`：可选，直接指定节拍长度。
- `startTimeBeat`：可选，直接指定起始节拍。
- `fingering`：可选，用于显示指法。

## 项目结构

```text
SmartPianoV2/
├── index.html          # 主界面
├── app.js              # UI、播放状态机、Canvas 绘制和模式切换
├── audioEngine.js      # Web Audio 和 Soundfont 音色
├── midiController.js   # Web MIDI 输入
├── parser.js           # MusicXML、MIDI、JSON 解析
├── sheetLibrary.js     # IndexedDB 本地曲谱库
├── noteMap.js          # 音名和 MIDI 编号映射
├── service-worker.js   # PWA 和音色缓存
└── manifest.json       # PWA 清单
```

## 技术说明

- Canvas 负责曲谱视图绘制，避免大量 DOM 音符节点导致卡顿。
- Play 和 Practice 使用横向时间轴视图。
- Waterfall 使用垂直下落视图，并读取虚拟琴键的实时位置完成轨道对齐。
- AudioEngine 使用 Web Audio API、动态压限器和 Soundfont Player。
- SheetLibrary 使用 IndexedDB 保存导入过的曲谱。
- Service Worker 缓存核心文件和音色资源，提高二次打开速度。

## 常见问题

**页面没有声音怎么办？**

浏览器要求用户交互后才能播放音频。请先点击播放按钮或任意虚拟琴键。首次
加载音色需要联网下载，请等待状态栏提示音色加载完成。

**MIDI 键盘没有被识别怎么办？**

请确认使用 Chrome 或 Edge，并在浏览器权限弹窗中允许 MIDI 访问。Firefox
默认不支持 Web MIDI API。

**导入 MIDI 后音符顺序不符合预期怎么办？**

复杂多声部 MIDI 会被合并为统一时间序列。若曲谱结构复杂，建议先在
MuseScore 中整理并导出 MusicXML。

**瀑布模式为什么看不到全部琴键？**

键盘区域可以横向滚动。滚动后瀑布视图会重新按当前键盘位置绘制，保证音符
仍然对应可见琴键。

## License

MIT
