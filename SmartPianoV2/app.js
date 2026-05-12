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

function resizeSheetCanvas() {
    if (!sheetCanvas || !sheetContainer) return { width: 1200, height: 320 };

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssWidth = Math.max(sheetContainer.clientWidth || 1200, 320);
    const cssHeight = Math.max(sheetContainer.clientHeight || 320, 220);

    sheetCanvas.style.width = '100%';
    sheetCanvas.style.height = '100%';

    const targetWidth = Math.round(cssWidth * dpr);
    const targetHeight = Math.round(cssHeight * dpr);
    if (sheetCanvas.width !== targetWidth || sheetCanvas.height !== targetHeight) {
        sheetCanvas.width = targetWidth;
        sheetCanvas.height = targetHeight;
    }

    if (canvasCtx) canvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width: cssWidth, height: cssHeight };
}

function getVisiblePitchRange() {
    const noteMidis = currentSongInfo.data
        .map(item => item.midi)
        .filter(midi => Number.isFinite(midi));

    if (noteMidis.length === 0) return { min: 36, max: 96 };

    const minMidi = Math.min(...noteMidis);
    const maxMidi = Math.max(...noteMidis);

    return {
        min: Math.max(21, Math.min(36, minMidi - 4)),
        max: Math.min(108, Math.max(96, maxMidi + 4))
    };
}

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
        }
        item.durationBeat = item.durationBeat || item.duration || 1;
        tempBeat = Math.max(tempBeat, item.startTimeBeat + item.durationBeat);

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
    sheetCanvas.className = 'h-full w-full rounded-2xl';
    sheetContainer.appendChild(sheetCanvas);

    canvasCtx = sheetCanvas.getContext('2d');
    resizeSheetCanvas();
    drawSheet(currentBeat);
}

/** 绘制胶囊型发光音符 */
function drawCapsule(ctx, x, y, width, height) {
    const radius = height / 2;
    const safeWidth = Math.max(width, height);
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + safeWidth - radius, y);
    ctx.arc(x + safeWidth - radius, y + radius, radius, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(x + radius, y + height);
    ctx.arc(x + radius, y + radius, radius, Math.PI / 2, -Math.PI / 2);
}

/** Canvas 绘制卷帘窗 */
function drawSheet(beatPosition) {
    if (!canvasCtx || !sheetCanvas) return;

    const ctx = canvasCtx;
    const { width: w, height: h } = resizeSheetCanvas();
    const { min: pitchMin, max: pitchMax } = getVisiblePitchRange();
    const pitchSpan = Math.max(1, pitchMax - pitchMin);
    const gutterW = 58;
    const rulerH = 34;
    const bottomPad = 26;
    const playheadX = gutterW + (w - gutterW) * 0.43;
    const pixelsPerBeat = Math.max(64, Math.min(120, (w - gutterW) / 11));
    const visibleLeftBeats = (playheadX - gutterW) / pixelsPerBeat;
    const visibleRightBeats = (w - playheadX) / pixelsPerBeat;
    const trackTop = rulerH + 12;
    const trackBottom = h - bottomPad;
    const trackHeight = Math.max(120, trackBottom - trackTop);

    ctx.save();
    ctx.fillStyle = isPlaying ? 'rgba(9, 9, 11, 0.34)' : '#09090b';
    ctx.fillRect(0, 0, w, h);

    const stageGradient = ctx.createLinearGradient(0, 0, w, h);
    stageGradient.addColorStop(0, 'rgba(34, 211, 238, 0.10)');
    stageGradient.addColorStop(0.34, 'rgba(24, 24, 27, 0.72)');
    stageGradient.addColorStop(1, 'rgba(3, 7, 18, 0.95)');
    ctx.fillStyle = stageGradient;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(24, 24, 27, 0.88)';
    ctx.fillRect(0, 0, gutterW, h);
    ctx.fillStyle = 'rgba(9, 9, 11, 0.74)';
    ctx.fillRect(gutterW, 0, w - gutterW, rulerH);
    ctx.strokeStyle = 'rgba(63, 63, 70, 0.90)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gutterW + 0.5, 0);
    ctx.lineTo(gutterW + 0.5, h);
    ctx.moveTo(0, rulerH + 0.5);
    ctx.lineTo(w, rulerH + 0.5);
    ctx.stroke();

        for (let midi = pitchMin; midi <= pitchMax; midi++) {
        const y = trackTop + (1 - (midi - pitchMin) / pitchSpan) * trackHeight;
        const isOctave = midi % 12 === 0;
        ctx.strokeStyle = isOctave ? 'rgba(34, 211, 238, 0.13)' : 'rgba(255, 255, 255, 0.035)';
        ctx.lineWidth = isOctave ? 1 : 0.5;
        ctx.beginPath();
        ctx.moveTo(gutterW, y);
        ctx.lineTo(w, y);
        ctx.stroke();

        if (isOctave) {
            const note = lookupByMidi(midi);
            if (note) {
                ctx.fillStyle = 'rgba(212, 212, 216, 0.68)';
                ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';
                ctx.fillText(note.name, gutterW - 9, y);
            }
        }
    }

    const staffGap = 9;
    const staffCenters = [trackTop + trackHeight * 0.32, trackTop + trackHeight * 0.68];
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.11)';
    staffCenters.forEach((center, idx) => {
        for (let i = -2; i <= 2; i++) {
            const y = center + i * staffGap;
            ctx.beginPath();
            ctx.moveTo(gutterW, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
        ctx.fillStyle = 'rgba(34, 211, 238, 0.35)';
        ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(idx === 0 ? 'TREBLE' : 'BASS', gutterW + 10, center - 34);
    });

    const startBeat = Math.floor(beatPosition - visibleLeftBeats) - 1;
    const endBeat = Math.ceil(beatPosition + visibleRightBeats) + 1;
    for (let b = Math.max(0, startBeat); b <= Math.min(globalTotalBeats, endBeat); b++) {
        const x = (b - beatPosition) * pixelsPerBeat + playheadX;
        const isMeasure = b % 4 === 0;

        if (isMeasure) {
            ctx.fillStyle = 'rgba(34, 211, 238, 0.045)';
            ctx.fillRect(x, rulerH, pixelsPerBeat * 4, h - rulerH);
        }

        ctx.strokeStyle = isMeasure ? 'rgba(34, 211, 238, 0.30)' : 'rgba(255, 255, 255, 0.07)';
        ctx.lineWidth = isMeasure ? 1.2 : 0.5;
        ctx.beginPath();
        ctx.moveTo(x, rulerH);
        ctx.lineTo(x, h);
        ctx.stroke();

        ctx.fillStyle = isMeasure ? 'rgba(103, 232, 249, 0.90)' : 'rgba(161, 161, 170, 0.52)';
        ctx.font = isMeasure ? 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace' : '9px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(isMeasure ? `M${Math.floor(b / 4) + 1}` : `${b + 1}`, x, rulerH / 2);
    }

    currentSongInfo.data.forEach((item) => {
        const noteX = (item.startTimeBeat - beatPosition) * pixelsPerBeat + playheadX;
        const noteW = Math.max(item.durationBeat * pixelsPerBeat - 12, 22);
        if (noteX < gutterW - noteW - 60 || noteX > w + 60) return;

        const noteH = 18;
        const noteY = Math.max(
            trackTop + noteH / 2,
            Math.min(trackBottom - noteH / 2, trackTop + (1 - (item.midi - pitchMin) / pitchSpan) * trackHeight)
        );
        const isWaiting = currentMode === 'wait' && !item.played && Math.abs(item.startTimeBeat - practiceCurrentBeat) < 0.01;
        const isActive = beatPosition >= item.startTimeBeat - 0.001 && beatPosition <= item.startTimeBeat + item.durationBeat + 0.03 && !isWaiting;
        const isPlayed = item.played && !isActive;

        let fill = '#22d3ee';
        let edge = '#67e8f9';
        let shadow = '#22d3ee';
        let blur = 12;
        let alpha = 0.82;

        if (isWaiting) {
            fill = '#fbbf24';
            edge = '#fed7aa';
            shadow = '#f59e0b';
            blur = 24;
            alpha = 1;
        } else if (isActive) {
            fill = '#67e8f9';
            edge = '#ecfeff';
            shadow = '#22d3ee';
            blur = 26;
            alpha = 1;
        } else if (isPlayed) {
            fill = '#52525b';
            edge = '#71717a';
            shadow = 'rgba(82, 82, 91, 0)';
            blur = 0;
            alpha = 0.42;
        }

        if (!isPlayed) {
            const trail = ctx.createLinearGradient(noteX - 46, 0, noteX + noteW, 0);
            trail.addColorStop(0, 'rgba(34, 211, 238, 0)');
            trail.addColorStop(1, isWaiting ? 'rgba(245, 158, 11, 0.20)' : 'rgba(34, 211, 238, 0.18)');
            ctx.fillStyle = trail;
            ctx.fillRect(noteX - 46, noteY - noteH / 2 - 4, noteW + 46, noteH + 8);
        }

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = fill;
        ctx.strokeStyle = edge;
        ctx.lineWidth = 1;
        ctx.shadowColor = shadow;
        ctx.shadowBlur = blur;
        ctx.beginPath();
        drawCapsule(ctx, noteX, noteY - noteH / 2, noteW, noteH);
        ctx.fill();
        ctx.stroke();

        if (!isPlayed) {
            ctx.shadowBlur = 0;
            ctx.globalAlpha = 0.58;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.48)';
            ctx.beginPath();
            drawCapsule(ctx, noteX + 4, noteY - noteH / 2 + 4, Math.max(noteW - 8, noteH), 4);
            ctx.fill();
        }
        ctx.restore();

        if (noteW > 38) {
            ctx.save();
            ctx.fillStyle = isPlayed ? 'rgba(212, 212, 216, 0.48)' : '#082f49';
            ctx.font = 'bold 9px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(item.note, noteX + noteW / 2, noteY + 0.5);
            ctx.restore();
        }
    });

    const beam = ctx.createLinearGradient(playheadX - 16, 0, playheadX + 16, 0);
    beam.addColorStop(0, 'rgba(34, 211, 238, 0)');
    beam.addColorStop(0.5, 'rgba(34, 211, 238, 0.16)');
    beam.addColorStop(1, 'rgba(34, 211, 238, 0)');
    ctx.fillStyle = beam;
    ctx.fillRect(playheadX - 16, rulerH, 32, h - rulerH);

    const laserGradient = ctx.createLinearGradient(playheadX, 0, playheadX, h);
    laserGradient.addColorStop(0, 'rgba(34, 211, 238, 0.10)');
    laserGradient.addColorStop(0.5, 'rgba(34, 211, 238, 1)');
    laserGradient.addColorStop(1, 'rgba(34, 211, 238, 0.10)');
    ctx.strokeStyle = laserGradient;
    ctx.lineWidth = 2.4;
    ctx.shadowColor = '#22d3ee';
    ctx.shadowBlur = 26;
    ctx.beginPath();
    ctx.moveTo(playheadX, rulerH);
    ctx.lineTo(playheadX, h);
    ctx.stroke();

    ctx.fillStyle = '#22d3ee';
    ctx.beginPath();
    ctx.arc(playheadX, h - 12, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.restore();
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
        keyDiv.innerHTML = `<span class="key-label">${keyName}</span>`;
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
        keyDiv.className = 'key-black absolute flex items-end justify-center pb-4 text-[9px] font-bold cursor-pointer z-10';
        keyDiv.style.width = `${blackKeyWidth}px`;
        keyDiv.style.height = blackKeyHeight;
        keyDiv.style.left = `${left}px`;
                keyDiv.style.top = '0';
        keyDiv.innerHTML = `<span class="key-label">${name.replace('#', '♯')}</span>`;

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

function setPlayButtonAppearance(state) {
    btnPlayPause.className = state === 'playing'
        ? 'rounded-xl border border-cyan-300/50 bg-cyan-500/20 px-4 py-3 text-sm font-black text-cyan-50 shadow-[0_0_22px_rgba(34,211,238,0.32)] transition-all hover:bg-cyan-400/25'
        : 'rounded-xl border border-cyan-400/30 bg-zinc-900 px-4 py-3 text-sm font-black text-cyan-300 shadow-[0_0_18px_rgba(34,211,238,0.14)] transition-all hover:border-cyan-300 hover:bg-cyan-400/10 hover:text-cyan-100';
}

async function togglePlayPause() {
    if (!isPlaying && !isPaused) {
        await startPractice();
    } else if (isPlaying && !isPaused) {
        // 暂停
        isPlaying = false;
        isPaused = true;
                cancelAnimationFrame(animationId);
        btnPlayPause.innerText = '继续';
        setPlayButtonAppearance('ready');
        instructionText.innerText = '已暂停';
    } else if (!isPlaying && isPaused) {
                // 继续
        isPlaying = true;
        isPaused = false;
        btnPlayPause.innerText = '暂停';
        setPlayButtonAppearance('playing');
        instructionText.innerText = currentMode === 'auto' ? '自动播放中...' : '练习模式：请弹奏到达青色激光线的琥珀色音符。';
        await audioEngine.init();

        if (!isPlaying || isPaused) return;

        if (currentMode === 'auto') {
            playStartTime = performance.now() - (currentBeat * msPerBeat);
            requestAnimationFrame(playLoop);
        } else {
            highlightWaitingNotes();
        }
    }
}

async function startPractice() {
    isPlaying = true;
    isPaused = false;
    btnPlayPause.innerText = '暂停';
    setPlayButtonAppearance('playing');
    await audioEngine.init();

    if (!isPlaying || isPaused) return;

    if (currentMode === 'auto') {
        instructionText.innerText = '自动播放中...';
        playStartTime = performance.now() - (currentBeat * msPerBeat);
        requestAnimationFrame(playLoop);
    } else {
        instructionText.innerText = '练习模式：请弹奏到达青色激光线的琥珀色音符。';
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

                handleNoteOn(note.midi).then((playedNode) => {
                    const gapMs = 40;
                    const durationMs = note.durationBeat * msPerBeat;
                    const offTime = durationMs > gapMs + 10 ? durationMs - gapMs : durationMs * 0.8;

                    setTimeout(() => {
                        handleNoteOff(note.midi, playedNode);
                    }, offTime);
                });
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
    setPlayButtonAppearance('ready');
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
    setPlayButtonAppearance('ready');
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

async function handleNoteOn(midiNumber) {
    if (!audioEngine.getContext()) await audioEngine.init();

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
        instructionText.innerText = '已切换至练习模式：你需要弹对琥珀色高亮琴键，谱面才会前进。';
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

        renderSheet();
        resetPractice();
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
            playlistEl.innerHTML = '<tr><td colspan="5" class="px-3 py-8 text-center text-zinc-500">暂无保存的曲谱，上传后自动保存。</td></tr>';
            const countEl = document.getElementById('playlist-count');
            if (countEl) countEl.textContent = '0 首';
            return;
        }

        const sheets = await getAllSheets();
        const countEl = document.getElementById('playlist-count');
        if (countEl) countEl.textContent = `${sheets.length} 首`;

        let html = '';
        sheets.forEach(sheet => {
            const ext = (sheet.fileName || sheet.name || '').split('.').pop()?.toUpperCase() || 'SHEET';
            const statusText = currentSongNameUI.innerText.includes(sheet.name) ? 'Loaded' : 'Ready';
            const statusColor = statusText === 'Loaded' ? 'bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.8)]' : 'bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.7)]';
            html += `
                <tr class="group cursor-pointer transition-colors hover:bg-zinc-800/80" onclick="window.loadSheetFromLibrary(${sheet.id})">
                    <td class="px-3 py-2 font-mono text-xs text-zinc-500">#${sheet.id}</td>
                    <td class="max-w-[220px] truncate px-3 py-2 font-semibold text-zinc-200">${sheet.name}</td>
                    <td class="px-3 py-2"><span class="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] font-bold text-cyan-300">${ext}</span></td>
                    <td class="px-3 py-2"><span class="inline-flex items-center gap-2 text-xs text-zinc-400"><span class="h-2 w-2 rounded-full ${statusColor}"></span>${statusText}</span></td>
                    <td class="px-3 py-2 text-right">
                        <button class="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs font-bold text-cyan-300 opacity-80 transition hover:border-cyan-400 hover:opacity-100" onclick="event.stopPropagation(); window.loadSheetFromLibrary(${sheet.id})">播放</button>
                        <button class="ml-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs font-bold text-zinc-500 opacity-80 transition hover:border-red-400 hover:text-red-300 hover:opacity-100" onclick="event.stopPropagation(); window.deleteSheetFromLibrary(${sheet.id})">删除</button>
                    </td>
                </tr>
            `;
        });
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
        resizeSheetCanvas();
        drawSheet(currentBeat);
    }
});

// ==================== 初始化 ====================

export function init() {
    renderSheet();
    renderKeyboard();
    setMode(currentMode);
    setPlayButtonAppearance('ready');
    bpmUI.value = bpm;
    const volumeSlider = document.getElementById('volume-slider');
    if (volumeSlider) volumeSlider.value = 8;
    midiController.init();

    // 初始化播放列表
    updatePlaylistUI();
}

// 自动初始化
init();
