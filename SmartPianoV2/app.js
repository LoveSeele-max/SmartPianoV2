/**
 * app.js - 核心控制中枢
 * 负责串联 UI、播放状态机（练习模式/自动播放）、节拍器和进度条逻辑
 */

import { AudioEngine } from './audioEngine.js';
import { MidiController } from './midiController.js';
import { parseSheetFile, parseMusicXML } from './parser.js';
import { getNoteInfo, lookupByMidi, getWhiteKeys } from './noteMap.js';
import { saveToLibrary, getAllSheets, deleteFromLibrary, getSheetById } from './sheetLibrary.js';

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
let metronomeTimerId = null;
let metronomeBeatIndex = 0;
let playbackSessionId = 0;
let songLoadRequestId = 0;
let currentSheetId = null;
let libraryCache = [];
let playlistRenderRequestId = 0;

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
const modeSelectNative = document.getElementById('mode-select-native');
const metronomeToggle = document.getElementById('metronome-toggle');
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
    if (state === 'playing') {
        btnPlayPause.style.background = '#0891b2';
        btnPlayPause.setAttribute('onmouseover', "this.style.background='#0e7490'");
        btnPlayPause.setAttribute('onmouseout', "this.style.background='#0891b2'");
    } else {
        btnPlayPause.style.background = '#22c55e';
        btnPlayPause.setAttribute('onmouseover', "this.style.background='#16a34a'");
        btnPlayPause.setAttribute('onmouseout', "this.style.background='#22c55e'");
    }
}

function setMetronomeToggle(active) {
    if (metronomeToggle) metronomeToggle.classList.toggle('on', active);
}

function stopActivePlayback() {
    playbackSessionId++;
    isPlaying = false;
    isPaused = false;
    cancelAnimationFrame(animationId);
    animationId = null;
    audioEngine.stopAllNotes();

    if (metronomeTimerId) {
        clearInterval(metronomeTimerId);
        metronomeTimerId = null;
    }
    metronomeBeatIndex = 0;
    setMetronomeToggle(false);
}

function stopMetronome(message = '节拍器已停止。') {
    stopActivePlayback();
    btnPlayPause.innerText = '播放';
    setPlayButtonAppearance('ready');
    instructionText.innerText = message;
}

async function startMetronome() {
    if (metronomeTimerId) stopMetronome();

    isPlaying = true;
    isPaused = false;
    btnPlayPause.innerText = '停止';
    setPlayButtonAppearance('playing');
    setMetronomeToggle(true);
    instructionText.innerText = `节拍器运行中：${bpm} BPM`;

    const tick = () => {
        audioEngine.playMetronomeTick(metronomeBeatIndex % 4 === 0);
        metronomeBeatIndex++;
    };

    playbackSessionId++;
    tick();
    metronomeTimerId = setInterval(tick, msPerBeat);
}

async function togglePlayPause() {
    if (currentMode === 'metro') {
        if (isPlaying) {
            stopMetronome();
        } else {
            await startMetronome();
        }
        return;
    }

    if (!isPlaying && !isPaused) {
        await startPractice();
    } else if (isPlaying && !isPaused) {
        // 暂停
        isPlaying = false;
        isPaused = true;
        playbackSessionId++;
                cancelAnimationFrame(animationId);
        btnPlayPause.innerText = '继续';
        setPlayButtonAppearance('ready');
        instructionText.innerText = '已暂停';
    } else if (!isPlaying && isPaused) {
                // 继续
        isPlaying = true;
        isPaused = false;
        const sessionId = ++playbackSessionId;
        btnPlayPause.innerText = '暂停';
        setPlayButtonAppearance('playing');
        instructionText.innerText = currentMode === 'auto' ? '自动播放中...' : '练习模式：请弹奏到达青色激光线的琥珀色音符。';
        await audioEngine.init();

        if (!isPlaying || isPaused || sessionId !== playbackSessionId) return;

        if (currentMode === 'auto') {
            playStartTime = performance.now() - (currentBeat * msPerBeat);
            animationId = requestAnimationFrame(() => playLoop(sessionId));
        } else {
            highlightWaitingNotes();
        }
    }
}

async function startPractice() {
    isPlaying = true;
    isPaused = false;
    const sessionId = ++playbackSessionId;
    btnPlayPause.innerText = '暂停';
    setPlayButtonAppearance('playing');
    await audioEngine.init();

    if (!isPlaying || isPaused || sessionId !== playbackSessionId) return;

    if (currentMode === 'auto') {
        instructionText.innerText = '自动播放中...';
        playStartTime = performance.now() - (currentBeat * msPerBeat);
        animationId = requestAnimationFrame(() => playLoop(sessionId));
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

function playLoop(sessionId) {
    if (!isPlaying || sessionId !== playbackSessionId) return;

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
                    if (sessionId !== playbackSessionId) {
                        handleNoteOff(note.midi, playedNode);
                        return;
                    }
                    const gapMs = 40;
                    const durationMs = note.durationBeat * msPerBeat;
                    const offTime = durationMs > gapMs + 10 ? durationMs - gapMs : durationMs * 0.8;

                    setTimeout(() => {
                        if (sessionId !== playbackSessionId) return;
                        handleNoteOff(note.midi, playedNode);
                    }, offTime);
                });
            }
        }
    });

    if (currentBeat < globalTotalBeats && !allPlayed) {
        animationId = requestAnimationFrame(() => playLoop(sessionId));
    } else {
        setTimeout(() => finishPlaying(sessionId), 1500);
    }
}

function finishPlaying(sessionId = playbackSessionId) {
    if (sessionId !== playbackSessionId) return;
    isPlaying = false;
    isPaused = false;
    playbackSessionId++;
        cancelAnimationFrame(animationId);
    audioEngine.stopAllNotes();
    instructionText.innerText = '太棒了！曲目播放完成。';
    btnPlayPause.innerText = '重新播放';
    setPlayButtonAppearance('ready');
}

function resetPractice() {
    stopActivePlayback();

    currentBeat = 0;
    progressSlider.value = 0;

    currentSongInfo.data.forEach(note => note.played = false);

        // 重新绘制 Canvas
    drawSheet(0);

    btnPlayPause.innerText = '播放';
    setPlayButtonAppearance('ready');
    if (currentMode === 'metro') {
        instructionText.innerText = '节拍器就绪，点击播放。';
    } else {
        instructionText.innerText = currentMode === 'wait' ? '练习模式就绪，点击播放。' : '自动播放引擎就绪。';
    }
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
            const sessionId = playbackSessionId;
            setTimeout(() => finishPlaying(sessionId), 500);
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
    if (metronomeTimerId) stopMetronome();
    currentMode = mode;
    if (modeSelectNative && modeSelectNative.value !== mode) modeSelectNative.value = mode;

    if (currentMode === 'auto') {
        btnAuto.classList.replace('text-slate-400', 'text-white');
        btnWait.classList.replace('text-white', 'text-slate-400');
        modeSlider.style.transform = 'translateX(0)';
        setMetronomeToggle(false);
        instructionText.innerText = '已切换至自动播放模式。';
    } else if (currentMode === 'wait') {
        btnWait.classList.replace('text-slate-400', 'text-white');
        btnAuto.classList.replace('text-white', 'text-slate-400');
        modeSlider.style.transform = 'translateX(100%)';
        setMetronomeToggle(false);
        instructionText.innerText = '已切换至练习模式：你需要弹对琥珀色高亮琴键，谱面才会前进。';
    } else {
        setMetronomeToggle(false);
        btnPlayPause.innerText = '播放';
        setPlayButtonAppearance('ready');
        instructionText.innerText = '已切换至节拍器模式。';
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

function normalizeSongData(songData) {
    const normalized = {
        ...songData,
        data: (songData.data || [])
            .map((item, idx) => {
                const noteInfo = getNoteInfo(item.note);
                if (!noteInfo) return null;
                const durationBeat = item.durationBeat || item.duration || 1;
                return {
                    ...item,
                    midi: item.midi || noteInfo.midi,
                    fingering: item.fingering || Math.min(5, (idx % 5) + 1),
                    durationBeat,
                    played: false
                };
            })
            .filter(Boolean)
    };

    return normalized;
}

function loadDemoSong(message = '曲谱库已清空，已回到内置示例曲。') {
    stopActivePlayback();
    currentSheetId = null;
    currentSongInfo = normalizeSongData(songs.twinkle);
    currentSongNameUI.innerText = currentSongInfo.name;
    bpm = currentSongInfo.bpm || 100;
    msPerBeat = (60 / bpm) * 1000;
    bpmUI.value = bpm;
    renderSheet();
    resetPractice();
    instructionText.innerText = message;
}

function applyParsedSong(songData, fileName, options = {}) {
    const shouldSaveToLibrary = options.saveToLibrary !== false;
    const delayMs = options.delayMs ?? (shouldSaveToLibrary ? 500 : 0);
    const autoPlay = options.autoPlay === true;
    const loadRequestId = ++songLoadRequestId;
    const normalizedSong = normalizeSongData(songData);

    stopActivePlayback();

    if (normalizedSong.data.length === 0) {
        hideParseModal();
        alert('❌ 未找到有效音符');
        uploadInput.value = '';
        return;
    }

    showParseModal('加载完成!', `解析到 ${normalizedSong.data.length} 个音符`, 100);

    const commitSongLoad = () => {
        if (loadRequestId !== songLoadRequestId) return;

        hideParseModal();
        currentSongInfo = normalizedSong;
        currentSheetId = options.libraryId ?? normalizedSong.id ?? null;

        let displayName = normalizedSong.name || fileName.split('.').slice(0, -1).join('.');
        if (!displayName.startsWith('《')) displayName = '《' + displayName;
        if (!displayName.endsWith('》')) displayName = displayName + '》';
        currentSongNameUI.innerText = displayName;

        // 更新 BPM
        bpm = normalizedSong.bpm || 100;
        msPerBeat = (60 / bpm) * 1000;
        bpmUI.value = bpm;

        if (shouldSaveToLibrary) {
            // 自动保存到本地库
            saveToLibrary(normalizedSong, fileName).then((savedId) => {
                if (loadRequestId === songLoadRequestId) currentSheetId = savedId;
                updatePlaylistUI();
            }).catch(err => {
                console.warn('保存到本地库失败:', err);
            });
        } else {
            updatePlaylistUI();
        }

        renderSheet();
        resetPractice();
        uploadInput.value = '';
        instructionText.innerText = `✅ 已加载 ${displayName}，共 ${normalizedSong.data.length} 个音符，BPM为 ${bpm}。`;
        if (autoPlay) startPractice();
    };

    if (delayMs > 0) {
        setTimeout(commitSongLoad, delayMs);
    } else {
        commitSongLoad();
    }
}

async function parseUploadFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'mxl') {
        const zip = await JSZip.loadAsync(await file.arrayBuffer());
        let xmlFile = Object.values(zip.files).find(f => f.name.endsWith('.xml') && !f.name.startsWith('META-INF'));
        if (!xmlFile) throw new Error('未找到XML');
        const parsed = parseMusicXML(await xmlFile.async('string'));
        return { name: file.name.replace(/\.mxl$/i, ''), data: parsed.notes, bpm: parsed.bpm };
    }

    if (ext === 'mid' || ext === 'midi') {
        return parseSheetFile(file, await file.arrayBuffer());
    }

    return parseSheetFile(file, await file.text());
}

// ==================== 播放列表 UI ====================

/** 更新播放列表 UI */
async function updatePlaylistUI() {
    try {
        const renderRequestId = ++playlistRenderRequestId;
        const playlistEl = document.getElementById('playlist-container');
        if (!playlistEl) return;

        const sheets = await getAllSheets();
        if (renderRequestId !== playlistRenderRequestId) return;

        libraryCache = sheets;
        const fragment = document.createDocumentFragment();

        if (sheets.length === 0) {
            libraryCache = [];
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = 5;
            cell.className = 'px-3 py-8 text-center text-zinc-500';
            cell.textContent = '暂无保存的曲谱，上传后自动保存。';
            row.appendChild(cell);
            fragment.appendChild(row);
            const countEl = document.getElementById('playlist-count');
            if (countEl) countEl.textContent = '0 首';
            playlistEl.replaceChildren(fragment);
            return;
        }

        const displayIds = new Map([...sheets].reverse().map((sheet, index) => [sheet.id, index + 1]));
        const countEl = document.getElementById('playlist-count');
        if (countEl) countEl.textContent = `${sheets.length} 首`;

        sheets.forEach(sheet => {
            const ext = (sheet.fileName || sheet.name || '').split('.').pop()?.toUpperCase() || 'SHEET';
            const isLoaded = sheet.id === currentSheetId;
            const statusClass = isLoaded ? 's-playing' : 's-ready';
            const statusText = isLoaded ? 'Playing' : 'Ready';

            const row = document.createElement('tr');
            row.addEventListener('click', () => window.loadSheetFromLibrary(sheet.id));

            const idCell = document.createElement('td');
            idCell.textContent = displayIds.get(sheet.id) || sheet.id;

            const titleCell = document.createElement('td');
            titleCell.className = 'title-cell';
            titleCell.textContent = sheet.name;

            const typeCell = document.createElement('td');
            typeCell.textContent = ext;

            const statusCell = document.createElement('td');
            const statusBadge = document.createElement('span');
            statusBadge.className = statusClass;
            statusBadge.textContent = statusText;
            statusCell.appendChild(statusBadge);

            const actionsCell = document.createElement('td');
            actionsCell.style.textAlign = 'right';

            const playBtn = document.createElement('button');
            playBtn.className = 'act-btn';
            playBtn.title = '播放';
            playBtn.textContent = '▶';
            playBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                window.loadSheetFromLibrary(sheet.id, { autoPlay: true });
            });

            const stopBtn = document.createElement('button');
            stopBtn.className = 'act-btn';
            stopBtn.title = '停止';
            stopBtn.textContent = '■';
            stopBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                resetPractice();
            });

            const editBtn = document.createElement('button');
            editBtn.className = 'act-btn';
            editBtn.title = '编辑';
            editBtn.textContent = '✎';
            editBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                instructionText.innerText = '编辑功能暂未开放。';
            });

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'act-btn del';
            deleteBtn.title = '删除';
            deleteBtn.textContent = '🗑';
            deleteBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                window.deleteSheetFromLibrary(sheet.id);
            });

            actionsCell.append(playBtn, stopBtn, editBtn, deleteBtn);
            row.append(idCell, titleCell, typeCell, statusCell, actionsCell);
            fragment.appendChild(row);
        });

        playlistEl.replaceChildren(fragment);
    } catch (err) {
        console.warn('更新播放列表失败:', err);
    }
}

/** 从本地库加载曲谱 */
window.loadSheetFromLibrary = async function(id, options = {}) {
    try {
        if (!Number.isFinite(id)) return;
        const sheet = libraryCache.find(item => item.id === id) || await getSheetById(id);
        if (sheet) {
            applyParsedSong(sheet, sheet.fileName || sheet.name, {
                saveToLibrary: false,
                libraryId: id,
                autoPlay: options.autoPlay === true,
                delayMs: 0
            });
        }
    } catch (err) {
        console.error('加载本地曲谱失败:', err);
    }
};

/** 从本地库删除曲谱 */
window.deleteSheetFromLibrary = async function(id) {
    try {
        const wasCurrentSheet = id === currentSheetId;
        await deleteFromLibrary(id);
        const remainingSheets = await getAllSheets();

        if (remainingSheets.length === 0) {
            libraryCache = [];
            loadDemoSong('曲谱库已清空，下一次上传会从 ID 1 开始。');
            await updatePlaylistUI();
            return;
        }

        libraryCache = remainingSheets;

        if (wasCurrentSheet) {
            await window.loadSheetFromLibrary(remainingSheets[0].id);
            instructionText.innerText = '当前曲谱已删除，已切换到曲谱库中的下一首。';
            return;
        }

        await updatePlaylistUI();
    } catch (err) {
        console.error('删除曲谱失败:', err);
        instructionText.innerText = '删除曲谱失败，请刷新页面后重试。';
    }
};

// ==================== 事件绑定 ====================

btnPlayPause.addEventListener('click', togglePlayPause);
btnReset.addEventListener('click', resetPractice);
btnAuto.addEventListener('click', () => setMode('auto'));
btnWait.addEventListener('click', () => setMode('wait'));
if (modeSelectNative) {
    modeSelectNative.addEventListener('change', (e) => setMode(e.target.value));
}
if (metronomeToggle) {
    metronomeToggle.addEventListener('click', () => {
        if (currentMode !== 'metro') setMode('metro');
        if (isPlaying) {
            stopMetronome();
        } else {
            startMetronome();
        }
    });
}

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
        if (currentMode === 'metro' && metronomeTimerId) {
            clearInterval(metronomeTimerId);
            metronomeTimerId = setInterval(() => {
                audioEngine.playMetronomeTick(metronomeBeatIndex % 4 === 0);
                metronomeBeatIndex++;
            }, msPerBeat);
            instructionText.innerText = `节拍器运行中：${bpm} BPM`;
        } else {
            playStartTime = performance.now() - (currentBeat * msPerBeat);
        }
    }
});

document.getElementById('volume-slider').addEventListener('input', (e) => {
    audioEngine.setVolume(e.target.value);
});

// 文件上传
uploadInput.addEventListener('change', async function(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    try {
        let lastParsed = null;
        for (let index = 0; index < files.length; index++) {
            const file = files[index];
            showParseModal(
                files.length > 1 ? `解析曲谱 ${index + 1}/${files.length}...` : '解析曲谱...',
                file.name,
                Math.round((index / files.length) * 80) + 10
            );
            lastParsed = { song: await parseUploadFile(file), fileName: file.name };
            await saveToLibrary(normalizeSongData(lastParsed.song), file.name);
        }

        if (lastParsed) {
            const sheets = await getAllSheets();
            libraryCache = sheets;
            const newestSheet = sheets[0];
            if (newestSheet) {
                applyParsedSong(newestSheet, newestSheet.fileName || newestSheet.name, {
                    saveToLibrary: false,
                    libraryId: newestSheet.id,
                    delayMs: 0
                });
            }
        }
    } catch (err) {
        hideParseModal();
        alert('❌ 解析失败: ' + err.message);
    } finally {
        uploadInput.value = '';
        updatePlaylistUI();
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
