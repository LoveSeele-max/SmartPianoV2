# Smart Piano V2

一款运行在浏览器里的智能钢琴助手，专为 **Yamaha PSR-E383** 优化，同时支持任意 Web MIDI 设备与纯鼠标/触屏操作。

---

## 功能概览

| 功能 | 说明 |
|------|------|
| 🎹 虚拟键盘 | 61 键可视化钢琴，支持鼠标点击、触屏演奏 |
| 🎵 曲谱导入 | 支持 MusicXML (`.xml`)、压缩 MusicXML (`.mxl`)、MIDI (`.mid/.midi`)、JSON 格式 |
| 📚 本地曲谱库 | 基于 IndexedDB 持久化存储，刷新页面不丢失 |
| 🎮 自动播放模式 | 自动按节拍演奏曲谱，同步高亮琴键 |
| 🏋️ 练习模式 | 等待你弹对音符后才继续，适合跟谱练习 |
| 🎛️ BPM 控制 | 实时调整播放速度（10–300 BPM） |
| 🔌 MIDI 输入 | 通过 Web MIDI API 连接外部 MIDI 键盘，支持热插拔 |
| 🔊 真实音色 | 使用 Soundfont 加载真实钢琴音色（acoustic grand piano） |
| 📱 PWA 支持 | 可安装到桌面，支持离线缓存 |

---

## 快速开始

### 环境要求

- 现代浏览器（推荐 **Chrome 89+** 或 **Edge 89+**）
- 使用 MIDI 键盘需要浏览器支持 Web MIDI API（Chrome/Edge 原生支持，Firefox 需插件）
- 需要网络连接以首次加载钢琴音色（约 3–5 MB）

### 本地运行

```bash
# 克隆仓库
git clone https://github.com/LoveSeele-max/SmartPianoV2.git
cd SmartPianoV2/SmartPianoV2

# 启动本地服务器（任选其一）
python -m http.server 8080
# 或
npx serve .
```

然后打开浏览器访问 `http://localhost:8080`。

> ⚠️ 必须通过 HTTP 服务器访问，直接双击 `index.html` 会因浏览器安全策略导致模块加载失败。

---

## 界面说明

```
┌─────────────────────────────────────────────────────────┐
│  Smart Piano V2 (Yamaha PSR-E383)      Device Status    │
├──────────────────────┬──────────────────────────────────┤
│  Device & Mode       │  Sheet Library & Actions         │
│  ┌ MIDI Input      ┐ │  ┌──────────────────────────┐   │
│  │ Mode Select     │ │  │ + Add Sheet / Import MIDI │   │
│  │ BPM             │ │  │ 曲谱列表表格              │   │
│  │ Metronome  ○    │ │  └──────────────────────────┘   │
│  │ [播放] [重置]   │ │                                  │
│  └─────────────────┘ │                                  │
├──────────────────────┴──────────────────────────────────┤
│                    乐谱显示区                            │
├─────────────────────────────────────────────────────────┤
│                  虚拟钢琴键盘 (88键)                     │
└─────────────────────────────────────────────────────────┘
```

---

## 使用指南

### 1. 导入曲谱

点击 **+ Add Sheet / Import MIDI** 按钮，选择以下任意格式的文件：

- **MusicXML** (`.xml`) — 来自 MuseScore、Finale、Sibelius 等软件导出
- **MIDI** (`.mid` / `.midi`) — 标准 MIDI 文件，自动解析 BPM 和音符
- **JSON** — 自定义格式，结构为 `{ "name": "曲名", "data": [...] }`

导入后曲谱会自动保存到本地库，下次打开页面仍然可用。

### 2. 播放曲谱

1. 在曲谱库表格中点击任意一行，或点击 **▶** 图标加载曲谱
2. 点击顶部 **播放** 按钮开始演奏
3. 点击 **重置** 按钮回到曲谱开头

### 3. 选择模式

通过 **Mode Select** 下拉菜单切换：

| 模式 | 说明 |
|------|------|
| **Play（自动播放）** | 程序自动按节拍演奏，适合欣赏或跟随练习 |
| **Practice（练习模式）** | 程序暂停等待，你弹对当前音符后才继续下一个 |
| **Metronome** | 节拍器模式 |

### 4. 调整 BPM

在 **Beat Control (BPM)** 输入框中直接输入数值（10–300），实时生效。  
MIDI 文件导入时会自动读取文件内嵌的 BPM。

### 5. 连接 MIDI 键盘

1. 用 USB 线将 MIDI 键盘连接到电脑
2. 浏览器会弹出 MIDI 权限请求，点击**允许**
3. 顶部状态栏显示 `已连接: 设备名称` 且指示灯变绿即为成功
4. 支持热插拔，断开重连后自动识别

> Yamaha PSR-E383 用户：本项目已针对该型号的心跳包（254）和时钟信号（248）做了专项过滤，不会产生误触发。

### 6. 管理曲谱库

曲谱库表格中每行提供以下操作：

| 图标 | 功能 |
|------|------|
| ▶ | 加载并播放该曲谱 |
| ■ | 停止播放 |
| ✎ | 编辑（预留） |
| 🗑 | 从本地库中删除 |

---

## 支持的文件格式

### MusicXML (`.xml`)

标准乐谱交换格式，可从以下软件导出：
- [MuseScore](https://musescore.org)（免费）
- Finale、Sibelius、Dorico 等专业软件

### MIDI (`.mid` / `.midi`)

- 自动解析 Tempo（BPM）元事件
- 支持多轨道文件，合并所有轨道音符
- 自动过滤无效事件

### JSON

自定义格式示例：

```json
{
  "name": "小星星",
  "data": [
    { "note": "C4", "duration": 1, "fingering": 1 },
    { "note": "C4", "duration": 1, "fingering": 1 },
    { "note": "G4", "duration": 1, "fingering": 5 },
    { "note": "G4", "duration": 1, "fingering": 5 }
  ]
}
```

字段说明：
- `note` — 音名，格式为 `音名 + 八度`，如 `C4`、`F#3`、`Bb5`
- `duration` — 时值，以四分音符为 1（`0.5` = 八分音符，`2` = 二分音符）
- `fingering` — 指法编号（1–5），仅用于显示

---

## 技术架构

```
SmartPianoV2/
├── index.html          # 主界面 HTML + CSS
├── app.js              # 主控制器，协调各模块
├── audioEngine.js      # Web Audio API 音频引擎
├── midiController.js   # Web MIDI API 控制器
├── parser.js           # MusicXML / MIDI / JSON 解析器
├── sheetLibrary.js     # IndexedDB 本地曲谱库
├── noteMap.js          # 音名 ↔ MIDI 编号映射表
└── service-worker.js   # PWA 离线缓存
```

| 技术 | 用途 |
|------|------|
| Web Audio API | 音频上下文、动态压限器、增益控制 |
| Soundfont Player | 真实钢琴音色（acoustic grand piano） |
| Web MIDI API | 外部 MIDI 键盘输入 |
| IndexedDB | 本地曲谱持久化存储 |
| Service Worker | PWA 离线缓存 |
| Tailwind CSS | UI 样式框架 |

---

## 常见问题

**Q: 打开页面没有声音？**  
A: 浏览器要求用户交互后才能播放音频。点击任意键盘按键或播放按钮触发一次交互即可。首次加载需要从网络下载音色库（约 3–5 MB），请耐心等待状态栏提示"钢琴音色加载完成"。

**Q: MIDI 键盘没有被识别？**  
A: 确认使用的是 Chrome 或 Edge 浏览器，并在弹出的权限对话框中点击了"允许"。Firefox 默认不支持 Web MIDI API。

**Q: 导入 MIDI 文件后音符顺序不对？**  
A: 本项目将多轨道 MIDI 合并为单轨顺序播放。复杂的多声部 MIDI 文件建议先用 MuseScore 转换为 MusicXML 再导入。

**Q: 曲谱库的数据存在哪里？**  
A: 存储在浏览器的 IndexedDB 中（数据库名：`PianoSheetDB`）。清除浏览器数据会同时清除曲谱库。

---

## License

MIT
