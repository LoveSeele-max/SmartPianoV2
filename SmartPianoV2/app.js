/**
 * app.js - 核心控制中枢
 * 负责串联 UI、播放状态机（练习模式/自动播放）、节拍器和进度条逻辑
 */

import { AudioEngine } from './audioEngine.js';
import { MidiController } from './midiController.js';
import { parseSheetFile, parseMusicXML } from './parser.js';
import { getNoteInfo, lookupByMidi, getWhiteKeys } from './noteMap.js';
import { saveToLibrary, getAllSheets, deleteFromLibrary, getLibraryStats } from './sheetLibrary.js';

// ==================== 核心状态 ====================
const audioEngine = new AudioEngine();
const midiController = new MidiController();

// 内置示例曲目
const songs = {
    twinkle: {
        name: '《小星星》',
        data: [
            { note: 'C4', fingering: 1 }, { note: 'C4', fingering: 1 },
            { note: 'G4', fingering: 5 }, { note: 'G4', fingering: 5 },
            { note: 'A4', fingering: 4 }, { note: 'A4', fingering: 4 },
            { note: 'G4', fingering: 5, duration: 2 },
            { note: 'F4', fingering: 4 }, { note: 'F4', fingering: 4 },
            { note: 'E4', fingering: 3 }, { note: 'E4', fingering: 3 },
            { note: 'D4', fingering: 2 }, { note: 'D4', fingering: 2 },
            { note: 'C4', fingering: 1, duration: 2 }
        ]
    }
};

let currentSongInfo = songs.twinkle;
let currentMode = 'auto';
let isPlaying = false;
let isPaused = false;
let currentBeat = 0;
let globalTotalBeats = 10;
let bpm = 100;
let msPerBeat = (60 / bpm) * 1000;

// 播放循环变量
let playStartTime = 0;
let animationId = null;
let uniqueBeats = [];
let currentWaitIndex = 0;
let practiceCurrentBeat = 0;

// Canvas 卷帘窗变量
let canvasCtx = null;
let sheetCanvas = null;
let animationFrameId = null;

// ==================== DOM 引用 ====================
const sheetContainer = document.getElementById('sheet-container');
const keyboardContainer = document.getElementById('virtual-keyboard');
const btnPlayPause = document.getElementById('btn-play-pause');
const btnReset = document.getElementById('btn-reset');
const btnAuto = document.getElementById('mode-auto');
const btnWait = document.getElementById('mode-wait');
const modeSlider = document.getElementById('mode-slider');
const instructionText = document.getElementById('instruction-text');
const currentSongNameUI = document.getElementById('current-song-name');
const uploadInput = document.getElementById('upload-sheet');
const parseModal = document.getElementById('parse-modal');
const parseModalTitle = document.getElementById('parse-modal-title');
const parseModalDetail = document.getElementById('parse-modal-detail');
const parseProgressBar = document.getElementById('parse-progress-bar');
const progressSlider = document.getElementById('progress-slider');
const btnSkipBackward = document.getElementById('btn-skip-backward');
const btnSkipForward = document.getElementById('btn-skip-forward');
const bpmUI = document.getElementById('bpm-ui');
const midiDot = document.getElementById('midi-dot');
const midiStatusText = document.getElementById('midi-status-text');

// ==================== UI 渲染 ====================

/** 使用 Canvas 绘制卷帘窗（替代 DOM 方式） */
function renderSheet() {
    sheetContainer.innerHTML = '';

    // 计算所有音符的时间信息
    let tempBeat = 0;
    currentSongInfo.data.forEach(item => {
        if (item.startTimeBeat === undefined) {
            item.startTimeBeat = tempBeat;
            item.durationBeat = item.duration || 1;
            tempBeat += item.durationBeat;
        }
        const noteInfo = getNoteInfo(item.note);
        item.midi = item.midi || (noteInfo ? noteInfo.midi : 60);
    });

    // 计算总节拍长度
    globalTotalBeats = Math.max(...currentSongInfo.data.map(n => n.startTimeBeat + n.durationBeat), 10);
    progressSlider.max = globalTotalBeats;
    progressSlider.value = currentBeat;

    // 创建 Canvas 元素
    sheetCanvas = document.createElement('canvas');
    sheetCanvas.id = 'sheet-canvas';
    sheetCanvas.className = 'w-full h-64 rounded-xl';
    sheetCanvas.width = sheetContainer.clientWidth || 1200;
    sheetCanvas.height = 256;
    sheetContainer.classList.add('relative', 'w-full', 'max-w-6xl', 'mx-auto', 'h-64', 'bg-slate-800/80', 'rounded-xl', 'overflow-hidden', 'border', 'border-slate-700', 'shadow-inner', 'mt-2');
    sheetContainer.appendChild(sheetCanvas);

    canvasCtx = sheetCanvas.getContext('2d');
    drawSheet(currentBeat);
}

/** 绘制圆角矩形（兼容性方案，替代 canvas roundRect） */
function roundRect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) {
        ctx.roundRect(x, y, w, h, r);
    } else {
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
    }
}

/** Canvas 绘制卷帘窗 */
function drawSheet(beatPosition) {
    if (!canvasCtx || !sheetCanvas) return;

    const ctx = canvasCtx;
    const w = sheetCanvas.width;
    const h = sheetCanvas.height;
    const pixelsPerBeat = 120;

    // 清空画布
    ctx.clearRect(0, 0, w, h);

    // 绘制背景
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 0.3;

    // 绘制节拍网格线
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 0.5;
    const startBeat = Math.floor(beatPosition - w / pixelsPerBeat / 2);
    const endBeat = Math.ceil(beatPosition + w / pixelsPerBeat / 2);
    for (let b = Math.max(0, startBeat); b <= Math.min(globalTotalBeats, endBeat); b++) {
        const x = (b - beatPosition) * pixelsPerBeat + w / 2;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();

        // 小节号
        if (b % 4 === 0) {
            ctx.fillStyle = '#64748b';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(`m.${b/4 + 1}`, x, 12);
            ctx.fillStyle = '#475569';
        }
    }
    ctx.globalAlpha = 1.0;

    // 绘制音符
    currentSongInfo.data.forEach((item) => {
        const noteX = (item.startTimeBeat - beatPosition) * pixelsPerBeat + w / 2;
        if (noteX < -50 || noteX > w + 50) return;

        const yPercent = 1 - ((item.midi - 36) / (96 - 36));
        const noteY = yPercent * (h - 20) + 10;
        const noteW = item.durationBeat * pixelsPerBeat - 4;
        const noteH = 14;

        let color;
        if (item.played) {
            color = '#64748b'; // 已弹过的音符 → 灰色
            ctx.globalAlpha = 0.5;
        } else if (item.startTimeBeat <= beatPosition + 0.001) {
            color = '#f43f5e'; // 正在播放 → 红色
            ctx.globalAlpha = 1;
        } else {
            color = '#6366f1'; // 未弹 → 紫色
            ctx.globalAlpha = 0.9;
        }

        // 检测是否需要高亮（练习模式等待的音符）
        if (currentMode === 'wait' && !item.played &&
            Math.abs(item.startTimeBeat - practiceCurrentBeat) < 0.01) {
            color = '#eab308';
            ctx.shadowColor = '#eab308';
            ctx.shadowBlur = 15;
        }

        ctx.fillStyle = color;
        ctx.beginPath();
        roundRect(ctx, noteX, noteY, Math.max(noteW, 4), noteH, 3);
        ctx.fill();

        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;

        // 音符名称标签
        if (noteW > 20) {
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 9px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(item.note, noteX + Math.max(noteW, 4) / 2, noteY + noteH / 2);
        }
    });

    // 绘制播放头（红色竖线）
    ctx.strokeStyle = '#f43f5e';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#f43f5e';
    ctx.shadowBlur = 15;
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 绘制顶部音高标记
    ctx.fillStyle = '#94a3b8';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    for (let midi = 36; midi <= 96; midi += 12) {
        const note = lookupByMidi(midi);
        if (note) {
            const y = (1 - (midi - 36) / (96 - 36)) * (h - 20) + 10;
            ctx.fillText(note.name, w - 5, y + 4);
        }
    }
}

/** Pointer Events 驱动的虚拟键盘渲染（修复鼠标滑动卡键问题） */
function renderKeyboard() {
    keyboardContainer.innerHTML = '';
    const whiteKeyWidth = 40;
    const blackKeyWidth = 24;
    const blackKeyHeight = '60%';
    const whiteKeysOnly = getWhiteKeys();
    const blackKeyPositions = [];

    keyboardContainer.style.position = 'relative';

    // 第1遍：渲染所有白键
    whiteKeysOnly.forEach((keyName, idx) => {
        const noteInfo = getNoteInfo(keyName);
        if (!noteInfo) return;

        const keyDiv = document.createElement('div');
        keyDiv.id = `key-${noteInfo.midi}`;
        keyDiv.className = 'key-white w-10 h-full mx-[1px] flex items-end justify-center pb-3 text-xs font-bold cursor-pointer shrink-0';
        keyDiv.innerText = keyName;
        keyDiv.style.width = `${whiteKeyWidth}px`;
        keyDiv.dataset.whiteIndex = idx;

        // 改用 Pointer Events
        keyDiv.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            handleNoteOn(noteInfo.midi);
        });
        keyDiv.addEventListener('pointerup', () => handleNoteOff(noteInfo.midi));
        keyDiv.addEventListener('pointercancel', () => handleNoteOff(noteInfo.midi));
        keyDiv.addEventListener('pointerleave', () => handleNoteOff(noteInfo.midi));

        keyboardContainer.appendChild(keyDiv);

        // 检查黑键位置
        const baseNote = keyName.slice(0, -1);
        const octave = keyName.slice(-1);
        const blackNoteNames = { 'C': 'C#', 'D': 'D#', 'F': 'F#', 'G': 'G#', 'A': 'A#' };
        if (blackNoteNames[baseNote]) {
            const blackName = blackNoteNames[baseNote] + octave;
            const blackInfo = getNoteInfo(blackName);
            if (blackInfo) {
                const leftPos = (idx + 1) * (whiteKeyWidth + 2) - (blackKeyWidth / 2) - 1;
                blackKeyPositions.push({ left: leftPos, name: blackName, midi: blackInfo.midi });
            }
        }
    });

    // 第2遍：叠加黑键
    blackKeyPositions.forEach(({ left, name, midi }) => {
        const keyDiv = document.createElement('div');
        keyDiv.id = `key-${midi}`;
        keyDiv.className = 'absolute bg-gray-900 rounded-b-md border border-gray-700 border-t-0 flex items-end justify-center pb-4 text-[9px] font-bold text-gray-300 cursor-pointer z-10 shadow-lg';
        keyDiv.style.width = `${blackKeyWidth}px`;
        keyDiv.style.height = blackKeyHeight;
        keyDiv.style.left = `${left}px`;
        keyDiv.style.top = '0';
        keyDiv.style.background = 'linear-gradient(180deg, #1e293b 0%, #0f172a 100%)';
        keyDiv.innerText = name.replace('#', '♯');

        keyDiv.addEventListener('pointerdown', (e) => { e.stopPropagation(); handleNoteOn(midi); });
        keyDiv.addEventListener('pointerup', (e) => { e.stopPropagation(); handleNoteOff(midi); });
        keyDiv.addEventListener('pointercancel', (e) => { e.stopPropagation(); handleNoteOff(midi); });

        keyboardContainer.appendChild(keyDiv);
    });

    // 全局 pointerup 保障：防止任何卡键
    document.addEventListener('pointerup', () => {
        document.querySelectorAll('.key-pressed').forEach(el => el.classList.remove('key-pressed'));
    });
}

// ==================== 播放控制 ====================

function togglePlayPause() {
    if (!isPlaying && !isPaused) {
        startPractice();
    } else if (isPlaying && !isPaused) {
        // 暂停
        isPlaying = false;
        isPaused = true;
        cancelAnimationFrame(animationId);
        btnPlayPause.innerText = '继续';
        btnPlayPause.classList.replace('bg-rose-600', 'bg-emerald-600');
        instructionText.innerText = '已暂停';
    } else if (!isPlaying && isPaused) {
        // 继续
        isPlaying = true;
        isPaused = false;
        btnPlayPause.innerText = '暂停';
        btnPlayPause.classList.replace('bg-emerald-600', 'bg-rose-600');
        instructionText.innerText = currentMode === 'auto' ? '自动播放中...' : '练习模式：请在琴键上弹奏到达红线的高亮音符！';
        audioEngine.init();

        if (currentMode === 'auto') {
            playStartTime = performance.now() - (currentBeat * msPerBeat);
            requestAnimationFrame(playLoop);
        } else {
            highlightWaitingNotes();
        }
    }
}

function startPractice() {
    isPlaying = true;
    isPaused = false;
    btnPlayPause.innerText = '暂停';
    btnPlayPause.classList.replace('bg-emerald-600', 'bg-rose-600');
    audioEngine.init();

    if (currentMode === 'auto') {
        instructionText.innerText = '自动播放中...';
        playStartTime = performance.now() - (currentBeat * msPerBeat);
        requestAnimationFrame(playLoop);
    } else {
        instructionText.innerText = '练习模式：请在琴键上弹奏到达红线的高亮音符！';
        const beatsSet = new Set();
        currentSongInfo.data.forEach(n => beatsSet.add(n.startTimeBeat));
        uniqueBeats = Array.from(beatsSet).sort((a, b) => a - b);

        currentWaitIndex = uniqueBeats.findIndex(b => b >= currentBeat - 0.01);
        if (currentWaitIndex === -1) currentWaitIndex = 0;

        if (uniqueBeats.length > 0) {
            practiceCurrentBeat = uniqueBeats[currentWaitIndex];
            currentBeat = practiceCurrentBeat;
            updatePracticeScroll();
            highlightWaitingNotes();
        } else {
            finishPlaying();
        }
    }
}

function playLoop() {
    if (!isPlaying) return;

    const now = performance.now();
    currentBeat = (now - playStartTime) / msPerBeat;
    progressSlider.value = currentBeat;

    // 直接绘制 Canvas（不产生新的 RAF，避免循环嵌套）
    drawSheet(currentBeat);

    let allPlayed = true;
    currentSongInfo.data.forEach((note, index) => {
        if (!note.played) {
            allPlayed = false;
            if (currentBeat >= note.startTimeBeat) {
                note.played = true;

                const playedNode = handleNoteOn(note.midi);

                const gapMs = 40;
                const durationMs = note.durationBeat * msPerBeat;
                const offTime = durationMs > gapMs + 10 ? durationMs - gapMs : durationMs * 0.8;

                setTimeout(() => {
                    handleNoteOff(note.midi, playedNode);
                }, offTime);
            }
        }
    });

    if (currentBeat < globalTotalBeats && !allPlayed) {
        animationId = requestAnimationFrame(playLoop);
    } else {
        setTimeout(finishPlaying, 1500);
    }
}

function finishPlaying() {
    isPlaying = false;
    isPaused = false;
    cancelAnimationFrame(animationId);
    instructionText.innerText = '太棒了！曲目播放完成。';
    btnPlayPause.innerText = '重新播放';
    btnPlayPause.classList.replace('bg-rose-600', 'bg-emerald-600');
}

function resetPractice() {
    isPlaying = false;
    isPaused = false;
    cancelAnimationFrame(animationId);

    currentBeat = 0;
    progressSlider.value = 0;

    currentSongInfo.data.forEach(note => note.played = false);

    // 重新绘制 Canvas
    drawSheet(0);

    btnPlayPause.innerText = '播放';
    btnPlayPause.classList.remove('bg-rose-600');
    btnPlayPause.classList.add('bg-emerald-600');
    instructionText.innerText = currentMode === 'wait' ? '练习模式就绪，点击播放。' : '自动播放引擎就绪。';
}

function seekToBeat(targetBeat) {
    targetBeat = Math.max(0, Math.min(targetBeat, globalTotalBeats));

    if (currentMode === 'wait') {
        let closestIdx = 0;
        let minDiff = Infinity;
        for (let i = 0; i < uniqueBeats.length; i++) {
            let diff = Math.abs(uniqueBeats[i] - targetBeat);
            if (diff < minDiff) { minDiff = diff; closestIdx = i; }
        }
        if (uniqueBeats.length > 0) {
            currentWaitIndex = closestIdx;
            practiceCurrentBeat = uniqueBeats[currentWaitIndex];
            currentBeat = practiceCurrentBeat;
        }
    } else {
        currentBeat = targetBeat;
        if (isPlaying) {
            playStartTime = performance.now() - (currentBeat * msPerBeat);
        }
    }

    progressSlider.value = currentBeat;

    // 更新音符状态
    currentSongInfo.data.forEach((note) => {
        if (note.startTimeBeat < currentBeat - 0.001) {
            note.played = true;
        } else {
            note.played = false;
        }
    });

    // 重绘 Canvas
    drawSheet(currentBeat);

    if (currentMode === 'wait' && (isPlaying || isPaused)) {
        highlightWaitingNotes();
    }
}

function updatePracticeScroll() {
    progressSlider.value = currentBeat;
    drawSheet(currentBeat);
}

function highlightWaitingNotes() {
    // Canvas 绘制逻辑已包含高亮
    drawSheet(currentBeat);
}

function checkPracticeNote(midiNumber) {
    let hit = false;
    let allPlayedInCurrentBeat = true;

    currentSongInfo.data.forEach((note) => {
        if (Math.abs(note.startTimeBeat - practiceCurrentBeat) < 0.001) {
            if (!note.played) {
                if (note.midi === midiNumber) {
                    note.played = true;
                    hit = true;
                } else {
                    allPlayedInCurrentBeat = false;
                }
            }
        }
    });

    if (hit && allPlayedInCurrentBeat) {
        currentWaitIndex++;
        if (currentWaitIndex < uniqueBeats.length) {
            practiceCurrentBeat = uniqueBeats[currentWaitIndex];
            currentBeat = practiceCurrentBeat;
            updatePracticeScroll();
            highlightWaitingNotes();
        } else {
            setTimeout(finishPlaying, 500);
        }
    }

    // 每次弹奏后重绘
    drawSheet(currentBeat);
}

// ==================== 音符事件处理 ====================

function handleNoteOn(midiNumber) {
    if (!audioEngine.getContext()) audioEngine.init();

    const keyElement = document.getElementById(`key-${midiNumber}`);
    if (keyElement) {
        keyElement.classList.remove('key-pressed');
        void keyElement.offsetWidth;
        keyElement.classList.add('key-pressed');
    }

    const playedNode = audioEngine.playNote(midiNumber);
    if (currentMode === 'wait' && isPlaying) checkPracticeNote(midiNumber);
    return playedNode;
}

function handleNoteOff(midiNumber, specificNode = null) {
    const keyElement = document.getElementById(`key-${midiNumber}`);
    if (keyElement) keyElement.classList.remove('key-pressed');

    audioEngine.stopNote(midiNumber, specificNode);
}

// ==================== 模式切换 ====================

function setMode(mode) {
    if (isPlaying || isPaused) resetPractice();
    currentMode = mode;

    if (currentMode === 'auto') {
        btnAuto.classList.replace('text-slate-400', 'text-white');
        btnWait.classList.replace('text-white', 'text-slate-400');
        modeSlider.style.transform = 'translateX(0)';
        instructionText.innerText = '已切换至自动播放模式。';
    } else {
        btnWait.classList.replace('text-slate-400', 'text-white');
        btnAuto.classList.replace('text-white', 'text-slate-400');
        modeSlider.style.transform = 'translateX(100%)';
        instructionText.innerText = '已切换至练习模式：你需要弹对高亮的琴键，谱面才会前进。';
    }
}

// ==================== 文件解析与加载 ====================

function showParseModal(title, detail, progress) {
    parseModal.classList.replace('hidden', 'flex');
    parseModalTitle.textContent = title;
    parseModalDetail.textContent = detail;
    parseProgressBar.style.width = progress + '%';
}

function hideParseModal() {
    parseModal.classList.replace('flex', 'hidden');
}

function applyParsedSong(songData, fileName) {
    songData.data = songData.data
        .map((item, idx) => ({ ...item, fingering: item.fingering || Math.min(5, (idx % 5) + 1) }))
        .filter(item => getNoteInfo(item.note));

    if (songData.data.length === 0) {
        hideParseModal();
        alert('❌ 未找到有效音符');
        uploadInput.value = '';
        return;
    }

    showParseModal('加载完成!', `解析到 ${songData.data.length} 个音符`, 100);

    setTimeout(() => {
        hideParseModal();
        currentSongInfo = songData;

        let displayName = songData.name || fileName.split('.').slice(0, -1).join('.');
        if (!displayName.startsWith('《')) displayName = '《' + displayName;
        if (!displayName.endsWith('》')) displayName = displayName + '》';
        currentSongNameUI.innerText = displayName;

        // 更新 BPM
        bpm = songData.bpm || 100;
        msPerBeat = (60 / bpm) * 1000;
        bpmUI.value = bpm;

        // 自动保存到本地库
        saveToLibrary(songData, fileName).then(() => {
            updatePlaylistUI();
        }).catch(err => {
            console.warn('保存到本地库失败:', err);
        });

        resetPractice();
        renderSheet();
        uploadInput.value = '';
        instructionText.innerText = `✅ 解析完成！共 ${songData.data.length} 个音符，BPM为 ${bpm}。`;
    }, 500);
}

// ==================== 播放列表 UI ====================

/** 更新播放列表 UI */
async function updatePlaylistUI() {
    try {
        const count = await getLibraryStats();
        // 如果播放列表容器存在则渲染
        const playlistEl = document.getElementById('playlist-container');
        if (!playlistEl) return;

        if (count === 0) {
            playlistEl.innerHTML = '<div class="text-slate-500 text-sm p-4 text-center">暂无保存的曲谱，上传后自动保存。</div>';
            return;
        }

        const sheets = await getAllSheets();
        let html = '<div class="space-y-1 max-h-40 overflow-y-auto no-scrollbar p-2">';
        sheets.forEach(sheet => {
            const date = new Date(sheet.timestamp);
            const dateStr = `${date.getMonth()+1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
            html += `
                <div class="flex items-center justify-between bg-slate-700/50 hover:bg-slate-700 rounded px-3 py-1.5 cursor-pointer group"
                     onclick="window.loadSheetFromLibrary(${sheet.id})">
                    <span class="text-sm text-slate-200 truncate">${sheet.name}</span>
                    <div class="flex items-center gap-2">
                        <span class="text-xs text-slate-500">${dateStr}</span>
                        <span class="text-xs text-indigo-400">${sheet.bpm}BPM</span>
                        <span class="text-xs text-slate-500 opacity-0 group-hover:opacity-100 cursor-pointer hover:text-red-400"
                              onclick="event.stopPropagation(); window.deleteSheetFromLibrary(${sheet.id})">✕</span>
                    </div>
                </div>
            `;
        });
        html += '</div>';
        playlistEl.innerHTML = html;
    } catch (err) {
        console.warn('更新播放列表失败:', err);
    }
}

/** 从本地库加载曲谱 */
window.loadSheetFromLibrary = async function(id) {
    try {
        const { getSheetById } = await import('./sheetLibrary.js');
        const sheet = await getSheetById(id);
        if (sheet) {
            applyParsedSong(sheet, sheet.fileName || sheet.name);
        }
    } catch (err) {
        console.error('加载本地曲谱失败:', err);
    }
};

/** 从本地库删除曲谱 */
window.deleteSheetFromLibrary = async function(id) {
    try {
        await deleteFromLibrary(id);
        updatePlaylistUI();
    } catch (err) {
        console.error('删除曲谱失败:', err);
    }
};

// ==================== 事件绑定 ====================

btnPlayPause.addEventListener('click', togglePlayPause);
btnReset.addEventListener('click', resetPractice);
btnAuto.addEventListener('click', () => setMode('auto'));
btnWait.addEventListener('click', () => setMode('wait'));

progressSlider.addEventListener('input', (e) => seekToBeat(parseFloat(e.target.value)));
btnSkipBackward.addEventListener('click', () => seekToBeat(currentBeat - 4));
btnSkipForward.addEventListener('click', () => seekToBeat(currentBeat + 4));

bpmUI.addEventListener('change', (e) => {
    let newBpm = parseInt(e.target.value);
    if (isNaN(newBpm) || newBpm < 10) newBpm = 10;
    if (newBpm > 300) newBpm = 300;
    e.target.value = newBpm;

    bpm = newBpm;
    msPerBeat = (60 / bpm) * 1000;

    if (isPlaying) {
        playStartTime = performance.now() - (currentBeat * msPerBeat);
    }
});

document.getElementById('volume-slider').addEventListener('input', (e) => {
    audioEngine.setVolume(e.target.value);
});

// 文件上传
uploadInput.addEventListener('change', async function(e) {
    const file = e.target.files[0];
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();

    try {
        if (ext === 'mxl') {
            showParseModal('正在解压 MXL...', file.name, 20);
            const zip = await JSZip.loadAsync(await file.arrayBuffer());
            let xmlFile = Object.values(zip.files).find(f => f.name.endsWith('.xml') && !f.name.startsWith('META-INF'));
            if (!xmlFile) throw new Error('未找到XML');
            const parsed = parseMusicXML(await xmlFile.async('string'));
            applyParsedSong({ name: file.name.replace(/\.mxl$/i, ''), data: parsed.notes, bpm: parsed.bpm }, file.name);
        } else if (ext === 'mid' || ext === 'midi') {
            showParseModal('解析MIDI...', file.name, 50);
            applyParsedSong(parseSheetFile(file, await file.arrayBuffer()), file.name);
        } else {
            showParseModal('解析文本曲谱...', file.name, 50);
            applyParsedSong(parseSheetFile(file, await file.text()), file.name);
        }
    } catch (err) {
        hideParseModal();
        alert('❌ 解析失败: ' + err.message);
        uploadInput.value = '';
    }
});

// ==================== MIDI 控制器回调 ====================

midiController.onNoteOn((midi) => handleNoteOn(midi));
midiController.onNoteOff((midi) => handleNoteOff(midi));
midiController.onStatusChange((text, connected) => {
    midiStatusText.innerText = text;
    if (connected) {
        midiDot.classList.replace('midi-disconnected', 'midi-connected');
    } else {
        midiDot.classList.replace('midi-connected', 'midi-disconnected');
    }
});

// 音频引擎状态回调
audioEngine.onStatusChange((text) => {
    instructionText.innerText = text;
});

// 窗口大小变化时重绘 Canvas
window.addEventListener('resize', () => {
    if (sheetCanvas) {
        sheetCanvas.width = sheetContainer.clientWidth || 1200;
        drawSheet(currentBeat);
    }
});

// ==================== 初始化 ====================

export function init() {
    renderSheet();
    renderKeyboard();
    setMode(currentMode);
    bpmUI.value = bpm;
    midiController.init();

    // 初始化播放列表
    updatePlaylistUI();
}

// 自动初始化
init();
