/**
 * app.js - 核心控制中枢
 * 负责串联 UI、播放状态机（练习模式/自动播放）、节拍器和进度条逻辑
 */

import { AudioEngine } from './audioEngine.js?v=20260603-compact-keyboard';
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
let keyboardMetricsKey = '';
let keyboardGlobalEventsBound = false;
const activePointerNotes = new Map();
const pointerNoteCounts = new Map();
const KEYBOARD_LAYOUT_STORAGE_KEY = 'smart-piano-v2-keyboard-layout';
const COMPACT_KEYBOARD_START_MIN = 24;
const COMPACT_KEYBOARD_START_MAX = 84;
const COMPACT_KEYBOARD_SPAN = 23;
let keyboardLayoutMode = getInitialKeyboardLayoutMode();

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
const btnWaterfall = document.getElementById('mode-waterfall');
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
const volumeValueUI = document.getElementById('volume-value');
const keyboardLayoutToggle = document.getElementById('keyboard-layout-toggle');
const keyboardLayoutValue = document.getElementById('keyboard-layout-value');
const midiDot = document.getElementById('midi-dot');
const midiStatusText = document.getElementById('midi-status-text');
const midiInputSelect = document.getElementById('midi-input-select');

function isAutoPlaybackMode() {
    return currentMode === 'auto' || currentMode === 'waterfall';
}

function updateVolumeDisplay(value) {
    if (!volumeValueUI) return;
    const normalizedVolume = Math.max(0, Math.min(1, parseFloat(value) || 0));
    volumeValueUI.textContent = `${Math.round(normalizedVolume * 100)}%`;
}

function getInitialKeyboardLayoutMode() {
    const queryMode = new URLSearchParams(window.location.search).get('keyboard');
    if (queryMode === 'compact' || queryMode === 'full') return queryMode;

    try {
        return localStorage.getItem(KEYBOARD_LAYOUT_STORAGE_KEY) === 'compact' ? 'compact' : 'full';
    } catch (err) {
        return 'full';
    }
}

function isCompactKeyboardMode() {
    return keyboardLayoutMode === 'compact';
}

function getWhiteKeysInMidiRange(minMidi, maxMidi) {
    const keys = [];
    for (let midi = minMidi; midi <= maxMidi; midi++) {
        const note = lookupByMidi(midi);
        if (note?.type === 'white') keys.push(note.name);
    }
    return keys;
}

function getCompactKeyboardWhiteKeys() {
    const noteMidis = currentSongInfo.data
        .map(item => item.midi)
        .filter(midi => Number.isFinite(midi));

    const minMidi = noteMidis.length ? Math.min(...noteMidis) : 60;
    const maxMidi = noteMidis.length ? Math.max(...noteMidis) : 69;
    let startMidi = Math.floor(minMidi / 12) * 12;

    if (maxMidi <= startMidi - 12 + COMPACT_KEYBOARD_SPAN) startMidi -= 12;
    while (maxMidi > startMidi + COMPACT_KEYBOARD_SPAN) startMidi += 12;
    startMidi = Math.max(COMPACT_KEYBOARD_START_MIN, Math.min(COMPACT_KEYBOARD_START_MAX, startMidi));

    return getWhiteKeysInMidiRange(startMidi, startMidi + COMPACT_KEYBOARD_SPAN);
}

function getKeyboardWhiteKeys() {
    if (!isCompactKeyboardMode()) return getWhiteKeys();
    return getCompactKeyboardWhiteKeys();
}

function updateKeyboardLayoutToggle() {
    if (keyboardLayoutToggle) {
        keyboardLayoutToggle.classList.toggle('on', isCompactKeyboardMode());
        keyboardLayoutToggle.setAttribute('aria-pressed', String(isCompactKeyboardMode()));
    }
    if (keyboardLayoutValue) {
        keyboardLayoutValue.textContent = isCompactKeyboardMode() ? '2 Oct' : 'Full';
    }
}

function setKeyboardLayoutMode(mode, options = {}) {
    const nextMode = mode === 'compact' ? 'compact' : 'full';
    const changed = keyboardLayoutMode !== nextMode;
    keyboardLayoutMode = nextMode;
    updateKeyboardLayoutToggle();

    if (options.persist !== false) {
        try {
            localStorage.setItem(KEYBOARD_LAYOUT_STORAGE_KEY, keyboardLayoutMode);
        } catch (err) { /* localStorage may be unavailable in private contexts. */ }
    }

    if (options.render !== false && changed) {
        renderKeyboard();
        if (sheetCanvas) drawSheet(currentBeat);
    }
}

function normalizeLibraryId(id) {
    const numericId = Number(id);
    return Number.isInteger(numericId) && numericId > 0 ? numericId : null;
}

function resetPlaybackProgress(redraw = true) {
    currentBeat = 0;
    progressSlider.value = 0;
    currentWaitIndex = 0;
    practiceCurrentBeat = 0;
    currentSongInfo.data.forEach(note => note.played = false);
    if (redraw) drawSheet(0);
}

function isPlaybackComplete() {
    return currentBeat >= globalTotalBeats - 0.001 ||
        (currentSongInfo.data.length > 0 && currentSongInfo.data.every(note => note.played));
}

function updateMidiInputSelect(label, connected = false) {
    if (!midiInputSelect) return;

    const option = document.createElement('option');
    option.textContent = label;
    option.value = connected ? label : '';
    midiInputSelect.replaceChildren(option);
    midiInputSelect.disabled = true;
}

function getReadyMessage() {
    if (currentMode === 'wait') return '练习模式就绪，点击播放。';
    if (currentMode === 'waterfall') return '瀑布模式就绪，音符会从上方落到琴键线。';
    return '自动播放引擎就绪。';
}

function getRunningMessage() {
    if (currentMode === 'wait') return '练习模式：请弹奏到达青色激光线的琥珀色音符。';
    if (currentMode === 'waterfall') return '瀑布模式播放中：音符从上方落下。';
    return '自动播放中...';
}

// ==================== UI 渲染 ====================

/** 使用 Canvas 绘制卷帘窗（替代 DOM 方式） */
function renderSheet() {
    sheetContainer.replaceChildren();

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

function drawRoundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
}

function getWaterfallKeyLayout(canvasWidth) {
    const canvasRect = sheetCanvas.getBoundingClientRect();
    const keys = new Map();
    let trackLeft = Infinity;
    let trackRight = -Infinity;

    for (let midi = 36; midi <= 96; midi++) {
        const keyElement = document.getElementById(`key-${midi}`);
        const note = lookupByMidi(midi);
        if (!keyElement || !note) continue;

        const rect = keyElement.getBoundingClientRect();
        const left = rect.left - canvasRect.left;
        const right = rect.right - canvasRect.left;
        const center = left + rect.width / 2;

        keys.set(midi, {
            left,
            right,
            center,
            width: rect.width,
            note,
            isBlack: note.type === 'black'
        });

        trackLeft = Math.min(trackLeft, left);
        trackRight = Math.max(trackRight, right);
    }

    if (!Number.isFinite(trackLeft) || !Number.isFinite(trackRight)) {
        return {
            keys,
            trackLeft: 24,
            trackRight: Math.max(24, canvasWidth - 24),
            trackW: Math.max(1, canvasWidth - 48)
        };
    }

    const clampedLeft = Math.max(0, Math.min(canvasWidth, trackLeft));
    const clampedRight = Math.max(0, Math.min(canvasWidth, trackRight));

    return {
        keys,
        trackLeft: clampedLeft,
        trackRight: clampedRight,
        trackW: Math.max(1, clampedRight - clampedLeft)
    };
}

function drawWaterfallSheet(beatPosition) {
    if (!canvasCtx || !sheetCanvas) return;

    const ctx = canvasCtx;
    const { width: w, height: h } = resizeSheetCanvas();
    const keyLayout = getWaterfallKeyLayout(w);
    const { keys: keyPositions, trackLeft, trackRight, trackW } = keyLayout;
    const topPad = 18;
    const hitLineY = Math.max(128, h - 42);
    const pixelsPerBeat = Math.max(54, Math.min(96, (hitLineY - topPad) / 4.8));
    const visibleFutureBeats = (hitLineY - topPad) / pixelsPerBeat;
    const visiblePastBeats = (h - hitLineY + 80) / pixelsPerBeat;

    ctx.save();
    ctx.fillStyle = isPlaying ? 'rgba(7, 10, 18, 0.38)' : '#070a12';
    ctx.fillRect(0, 0, w, h);

    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, 'rgba(8, 13, 24, 0.98)');
    bg.addColorStop(0.58, 'rgba(12, 21, 32, 0.95)');
    bg.addColorStop(1, 'rgba(4, 8, 12, 0.98)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    keyPositions.forEach((key, midi) => {
        const isOctave = midi % 12 === 0;

        ctx.fillStyle = key.isBlack ? 'rgba(15, 23, 42, 0.66)' : 'rgba(30, 41, 59, 0.26)';
        ctx.fillRect(key.left, topPad, key.width, h - topPad);

        ctx.strokeStyle = isOctave ? 'rgba(34, 211, 238, 0.26)' : 'rgba(148, 163, 184, 0.08)';
        ctx.lineWidth = isOctave ? 1 : 0.5;
        ctx.beginPath();
        ctx.moveTo(key.left + 0.5, topPad);
        ctx.lineTo(key.left + 0.5, h);
        ctx.stroke();

        if (isOctave && key.width > 8) {
            ctx.fillStyle = 'rgba(226, 232, 240, 0.56)';
            ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(key.note.name, key.center, 9);
        }
    });

    const startBeat = Math.floor(beatPosition - visiblePastBeats) - 1;
    const endBeat = Math.ceil(beatPosition + visibleFutureBeats) + 1;
    for (let b = Math.max(0, startBeat); b <= Math.min(globalTotalBeats, endBeat); b++) {
        const y = hitLineY - (b - beatPosition) * pixelsPerBeat;
        if (y < topPad || y > h) continue;

        const isMeasure = b % 4 === 0;
        ctx.strokeStyle = isMeasure ? 'rgba(34, 211, 238, 0.28)' : 'rgba(255, 255, 255, 0.07)';
        ctx.lineWidth = isMeasure ? 1.2 : 0.5;
        ctx.beginPath();
        ctx.moveTo(trackLeft, y);
        ctx.lineTo(trackRight, y);
        ctx.stroke();

        if (isMeasure) {
            ctx.fillStyle = 'rgba(34, 211, 238, 0.70)';
            ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(`M${Math.floor(b / 4) + 1}`, trackLeft + 6, y - 8);
        }
    }

    const targetGlow = ctx.createLinearGradient(0, hitLineY - 24, 0, hitLineY + 24);
    targetGlow.addColorStop(0, 'rgba(34, 211, 238, 0)');
    targetGlow.addColorStop(0.5, 'rgba(34, 211, 238, 0.20)');
    targetGlow.addColorStop(1, 'rgba(34, 211, 238, 0)');
    ctx.fillStyle = targetGlow;
    ctx.fillRect(trackLeft, hitLineY - 24, trackW, 48);

    currentSongInfo.data.forEach((item) => {
        const key = keyPositions.get(item.midi);
        if (!key) return;

        const noteBottom = hitLineY - (item.startTimeBeat - beatPosition) * pixelsPerBeat;
        const noteH = Math.max(item.durationBeat * pixelsPerBeat, 18);
        const noteTop = noteBottom - noteH;
        if (noteBottom < topPad - 36 || noteTop > h + 80) return;

        const noteW = Math.max(6, key.width * (key.isBlack ? 0.76 : 0.72));
        const x = key.center - noteW / 2;
        const clippedTop = Math.max(noteTop, topPad - 6);
        const clippedBottom = Math.min(noteBottom, h + 24);
        const clippedH = Math.max(4, clippedBottom - clippedTop);
        const isActive = beatPosition >= item.startTimeBeat - 0.001 &&
            beatPosition <= item.startTimeBeat + item.durationBeat + 0.03;
        const isPlayed = item.played && !isActive;

        let fillTop = 'rgba(34, 211, 238, 0.22)';
        let fillBottom = 'rgba(34, 211, 238, 0.95)';
        let edge = '#67e8f9';
        let shadow = '#22d3ee';
        let alpha = 0.88;
        let blur = 12;

        if (isActive) {
            fillTop = 'rgba(74, 222, 128, 0.34)';
            fillBottom = 'rgba(103, 232, 249, 1)';
            edge = '#ecfeff';
            shadow = '#67e8f9';
            alpha = 1;
            blur = 26;
        } else if (isPlayed) {
            fillTop = 'rgba(63, 63, 70, 0.25)';
            fillBottom = 'rgba(82, 82, 91, 0.55)';
            edge = 'rgba(113, 113, 122, 0.52)';
            shadow = 'rgba(82, 82, 91, 0)';
            alpha = 0.45;
            blur = 0;
        }

        const fill = ctx.createLinearGradient(0, clippedTop, 0, clippedBottom);
        fill.addColorStop(0, fillTop);
        fill.addColorStop(1, fillBottom);

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = fill;
        ctx.strokeStyle = edge;
        ctx.lineWidth = 1;
        ctx.shadowColor = shadow;
        ctx.shadowBlur = blur;
        ctx.beginPath();
        drawRoundedRect(ctx, x, clippedTop, noteW, clippedH, Math.min(8, noteW / 2));
        ctx.fill();
        ctx.stroke();

        if (!isPlayed && noteW > 8) {
            ctx.shadowBlur = 0;
            ctx.globalAlpha = Math.min(alpha, 0.55);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.46)';
            ctx.beginPath();
            drawRoundedRect(ctx, x + Math.max(2, noteW * 0.18), clippedTop + 4, Math.max(2, noteW * 0.18), Math.max(4, clippedH - 8), 3);
            ctx.fill();
        }

        ctx.restore();

        if (noteW > 16 && clippedH > 30) {
            ctx.save();
            ctx.fillStyle = isPlayed ? 'rgba(226, 232, 240, 0.48)' : '#082f49';
            ctx.font = 'bold 9px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(item.note, x + noteW / 2, Math.max(clippedTop + 14, clippedBottom - 14));
            ctx.restore();
        }
    });

    ctx.strokeStyle = 'rgba(236, 254, 255, 0.92)';
    ctx.lineWidth = 2.4;
    ctx.shadowColor = '#22d3ee';
    ctx.shadowBlur = 24;
    ctx.beginPath();
    ctx.moveTo(trackLeft, hitLineY);
    ctx.lineTo(trackRight, hitLineY);
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = 'rgba(2, 6, 23, 0.68)';
    ctx.fillRect(trackLeft, hitLineY + 2, trackW, Math.max(0, h - hitLineY - 2));
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.18)';
    ctx.strokeRect(trackLeft + 0.5, hitLineY + 2.5, trackW - 1, Math.max(0, h - hitLineY - 3));

    keyPositions.forEach((key, midi) => {
        if (midi % 12 !== 0 || key.width <= 13) return;
        ctx.fillStyle = 'rgba(226, 232, 240, 0.50)';
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(key.note.name, key.center, hitLineY + 21);
    });

    ctx.restore();
}

/** Canvas 绘制卷帘窗 */
function drawSheet(beatPosition) {
    if (!canvasCtx || !sheetCanvas) return;
    if (currentMode === 'waterfall') {
        drawWaterfallSheet(beatPosition);
        return;
    }

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

function getKeyboardMetrics() {
    const isCoarsePointer = window.matchMedia?.('(pointer: coarse)').matches;
    const viewportWidth = window.visualViewport?.width || window.innerWidth;
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const mobileLandscape = viewportHeight <= 520 && viewportWidth > viewportHeight && viewportWidth <= 960;
    const whiteKeyCount = getKeyboardWhiteKeys().length || 36;

    if (mobileLandscape) {
        const shellWidth = keyboardContainer?.parentElement?.clientWidth || viewportWidth;
        const keyboardStyle = keyboardContainer ? window.getComputedStyle(keyboardContainer) : null;
        const paddingX = keyboardStyle
            ? (parseFloat(keyboardStyle.paddingLeft) || 0) + (parseFloat(keyboardStyle.paddingRight) || 0)
            : 8;
        const whiteKeyMarginX = 2;
        const safetySpace = 4;
        const maxWhiteKeyWidth = isCompactKeyboardMode() ? 52 : 36;
        const minWhiteKeyWidth = isCompactKeyboardMode() ? 20 : 10;
        const availableWidth = Math.max(shellWidth - paddingX - safetySpace, whiteKeyCount * minWhiteKeyWidth);
        const fittedWhiteKeyWidth = Math.floor((availableWidth - (whiteKeyCount * whiteKeyMarginX)) / whiteKeyCount);
        const whiteKeyWidth = Math.max(minWhiteKeyWidth, Math.min(maxWhiteKeyWidth, fittedWhiteKeyWidth));
        const blackKeyWidth = Math.max(8, Math.round(whiteKeyWidth * 0.58));
        const blackKeyHeight = '64%';

        return {
            whiteKeyWidth,
            blackKeyWidth,
            blackKeyHeight,
            key: `${keyboardLayoutMode}:fit:${whiteKeyCount}:${Math.round(shellWidth)}:${whiteKeyWidth}:${blackKeyWidth}:${blackKeyHeight}`
        };
    }

    const compactViewport = window.innerWidth <= 720 || window.innerHeight <= 520;
    const whiteKeyWidth = isCompactKeyboardMode() ? (compactViewport ? 46 : isCoarsePointer ? 54 : 50) : compactViewport ? 36 : isCoarsePointer ? 44 : 40;
    const blackKeyWidth = Math.round(whiteKeyWidth * 0.6);
    const blackKeyHeight = compactViewport ? '62%' : '60%';

    return {
        whiteKeyWidth,
        blackKeyWidth,
        blackKeyHeight,
        key: `${keyboardLayoutMode}:${whiteKeyCount}:${whiteKeyWidth}:${blackKeyWidth}:${blackKeyHeight}`
    };
}

function getPointerKeyMidi(target) {
    const keyElement = target?.closest?.('[data-midi]');
    const midi = Number(keyElement?.dataset.midi);
    return Number.isFinite(midi) ? midi : null;
}

function getPointerKeyMidiFromPoint(clientX, clientY) {
    return getPointerKeyMidi(document.elementFromPoint(clientX, clientY));
}

function releasePointerNote(pointerId) {
    const midi = activePointerNotes.get(pointerId);
    if (midi === undefined) return;

    activePointerNotes.delete(pointerId);
    const nextCount = (pointerNoteCounts.get(midi) || 1) - 1;
    if (nextCount <= 0) {
        pointerNoteCounts.delete(midi);
        handleNoteOff(midi);
    } else {
        pointerNoteCounts.set(midi, nextCount);
    }
}

function pressPointerNote(pointerId, midi) {
    const currentMidi = activePointerNotes.get(pointerId);
    if (currentMidi === midi) return;
    if (currentMidi !== undefined) releasePointerNote(pointerId);

    activePointerNotes.set(pointerId, midi);
    const currentCount = pointerNoteCounts.get(midi) || 0;
    pointerNoteCounts.set(midi, currentCount + 1);
    if (currentCount === 0) handleNoteOn(midi, () => pointerNoteCounts.has(midi));
}

function releaseAllPointerNotes() {
    activePointerNotes.clear();
    pointerNoteCounts.forEach((_, midi) => handleNoteOff(midi));
    pointerNoteCounts.clear();
    document.querySelectorAll('.key-pressed').forEach(el => el.classList.remove('key-pressed'));
}

function handleKeyPointerDown(event, midi) {
    event.preventDefault();
    event.stopPropagation();
    try {
        event.currentTarget.setPointerCapture(event.pointerId);
    } catch (e) { /* 某些浏览器/测试环境可能不支持捕获 */ }
    pressPointerNote(event.pointerId, midi);
}

function handleKeyPointerMove(event) {
    if (!activePointerNotes.has(event.pointerId) || event.pointerType === 'mouse') return;

    event.preventDefault();
    event.stopPropagation();
    const nextMidi = getPointerKeyMidiFromPoint(event.clientX, event.clientY);
    if (nextMidi === null) {
        releasePointerNote(event.pointerId);
    } else {
        pressPointerNote(event.pointerId, nextMidi);
    }
}

function handleKeyPointerUp(event) {
    event.preventDefault();
    event.stopPropagation();
    releasePointerNote(event.pointerId);
    try {
        event.currentTarget.releasePointerCapture(event.pointerId);
    } catch (e) { /* 忽略未捕获或不支持的指针 */ }
}

function handleKeyPointerLeave(event) {
    if (event.pointerType === 'mouse') releasePointerNote(event.pointerId);
}

function bindKeyboardGlobalEvents() {
    if (keyboardGlobalEventsBound) return;
    keyboardGlobalEventsBound = true;

    document.addEventListener('pointerup', (event) => releasePointerNote(event.pointerId));
    document.addEventListener('pointercancel', (event) => releasePointerNote(event.pointerId));
    window.addEventListener('blur', releaseAllPointerNotes);
}

/** Pointer Events 驱动的虚拟键盘渲染（支持移动端多指触控） */
function renderKeyboard() {
    keyboardContainer.replaceChildren();
    releaseAllPointerNotes();
    bindKeyboardGlobalEvents();

    const { whiteKeyWidth, blackKeyWidth, blackKeyHeight, key } = getKeyboardMetrics();
    keyboardMetricsKey = key;
    const whiteKeysOnly = getKeyboardWhiteKeys();
    const blackKeyPositions = [];

    keyboardContainer.style.position = 'relative';

    // 第1遍：渲染所有白键
    whiteKeysOnly.forEach((keyName, idx) => {
        const noteInfo = getNoteInfo(keyName);
        if (!noteInfo) return;

        const keyDiv = document.createElement('div');
        keyDiv.id = `key-${noteInfo.midi}`;
        keyDiv.dataset.midi = String(noteInfo.midi);
        keyDiv.className = 'key-white h-full mx-[1px] flex items-end justify-center pb-3 text-xs font-bold cursor-pointer shrink-0';
        const keyLabel = document.createElement('span');
        keyLabel.className = 'key-label';
        keyLabel.textContent = keyName;
        keyDiv.appendChild(keyLabel);
        keyDiv.style.width = `${whiteKeyWidth}px`;
        keyDiv.dataset.whiteIndex = idx;

        keyDiv.addEventListener('pointerdown', (e) => handleKeyPointerDown(e, noteInfo.midi));
        keyDiv.addEventListener('pointermove', handleKeyPointerMove);
        keyDiv.addEventListener('pointerup', handleKeyPointerUp);
        keyDiv.addEventListener('pointercancel', handleKeyPointerUp);
        keyDiv.addEventListener('pointerleave', handleKeyPointerLeave);

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
        keyDiv.dataset.midi = String(midi);
        keyDiv.className = 'key-black absolute flex items-end justify-center pb-4 text-[9px] font-bold cursor-pointer z-10';
        keyDiv.style.width = `${blackKeyWidth}px`;
        keyDiv.style.height = blackKeyHeight;
        keyDiv.style.left = `${left}px`;
        keyDiv.style.top = '0';
        const keyLabel = document.createElement('span');
        keyLabel.className = 'key-label';
        keyLabel.textContent = name.replace('#', '♯');
        keyDiv.appendChild(keyLabel);

        keyDiv.addEventListener('pointerdown', (e) => handleKeyPointerDown(e, midi));
        keyDiv.addEventListener('pointermove', handleKeyPointerMove);
        keyDiv.addEventListener('pointerup', handleKeyPointerUp);
        keyDiv.addEventListener('pointercancel', handleKeyPointerUp);
        keyDiv.addEventListener('pointerleave', handleKeyPointerLeave);

        keyboardContainer.appendChild(keyDiv);
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
    if (!metronomeToggle) return;
    metronomeToggle.classList.toggle('on', active);
    metronomeToggle.setAttribute('aria-pressed', active ? 'true' : 'false');
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
    updatePlaylistUI();
}

async function startMetronome() {
    if (metronomeTimerId) stopActivePlayback();

    isPlaying = true;
    isPaused = false;
    btnPlayPause.innerText = '停止';
    setPlayButtonAppearance('playing');
    setMetronomeToggle(true);
    instructionText.innerText = `节拍器运行中：${bpm} BPM`;
    updatePlaylistUI();

    const tick = () => {
        audioEngine.playMetronomeTick(metronomeBeatIndex % 4 === 0)
            .catch(err => console.warn('节拍器播放失败:', err));
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
        updatePlaylistUI();
    } else if (!isPlaying && isPaused) {
                // 继续
        isPlaying = true;
        isPaused = false;
        const sessionId = ++playbackSessionId;
        btnPlayPause.innerText = '暂停';
        setPlayButtonAppearance('playing');
        instructionText.innerText = getRunningMessage();
        updatePlaylistUI();
        await audioEngine.init();

        if (!isPlaying || isPaused || sessionId !== playbackSessionId) return;

        if (isAutoPlaybackMode()) {
            playStartTime = performance.now() - (currentBeat * msPerBeat);
            animationId = requestAnimationFrame(() => playLoop(sessionId));
        } else {
            highlightWaitingNotes();
        }
    }
}

async function startPractice() {
    if (isPlaybackComplete()) {
        resetPlaybackProgress(false);
    }

    isPlaying = true;
    isPaused = false;
    const sessionId = ++playbackSessionId;
    btnPlayPause.innerText = '暂停';
    setPlayButtonAppearance('playing');
    updatePlaylistUI();
    await audioEngine.init();

    if (!isPlaying || isPaused || sessionId !== playbackSessionId) return;

    if (isAutoPlaybackMode()) {
        instructionText.innerText = getRunningMessage();
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
    animationId = null;
    audioEngine.stopAllNotes();
    currentBeat = globalTotalBeats;
    progressSlider.value = currentBeat;
    drawSheet(currentBeat);
    instructionText.innerText = '太棒了！曲目播放完成。';
    btnPlayPause.innerText = '重新播放';
    setPlayButtonAppearance('ready');
    updatePlaylistUI();
}

function resetPractice() {
    stopPlayback(currentMode === 'metro' ? '节拍器就绪，点击播放。' : getReadyMessage());
}

function stopPlayback(message = '已停止播放并回到开头。') {
    stopActivePlayback();
    audioEngine.stopAllNotes();
    resetPlaybackProgress();
    btnPlayPause.innerText = '播放';
    setPlayButtonAppearance('ready');
    instructionText.innerText = message;
    updatePlaylistUI();
}

function stopFromPlaylist(sheetId) {
    if (sheetId !== currentSheetId && !isPlaying && !isPaused) {
        instructionText.innerText = '这首曲谱当前没有播放。';
        return;
    }

    stopPlayback();
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

async function handleNoteOn(midiNumber, shouldStillPlay = null) {
    if (!audioEngine.getContext()) {
        await audioEngine.ensureContext();
        audioEngine.init().catch(err => console.warn('音色后台加载失败:', err));
    } else {
        await audioEngine.ensureContext();
    }

    if (shouldStillPlay && !shouldStillPlay()) return null;

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

    btnAuto.classList.toggle('text-white', currentMode === 'auto');
    btnAuto.classList.toggle('text-slate-400', currentMode !== 'auto');
    btnWait.classList.toggle('text-white', currentMode === 'wait');
    btnWait.classList.toggle('text-slate-400', currentMode !== 'wait');
    if (btnWaterfall) {
        btnWaterfall.classList.toggle('text-white', currentMode === 'waterfall');
        btnWaterfall.classList.toggle('text-slate-400', currentMode !== 'waterfall');
        btnWaterfall.classList.toggle('active', currentMode === 'waterfall');
    }

    if (currentMode === 'auto') {
        modeSlider.style.transform = 'translateX(0)';
        setMetronomeToggle(false);
        instructionText.innerText = '已切换至自动播放模式。';
    } else if (currentMode === 'wait') {
        modeSlider.style.transform = 'translateX(100%)';
        setMetronomeToggle(false);
        instructionText.innerText = '已切换至练习模式：你需要弹对琥珀色高亮琴键，谱面才会前进。';
    } else if (currentMode === 'waterfall') {
        modeSlider.style.transform = 'translateX(200%)';
        setMetronomeToggle(false);
        instructionText.innerText = '已切换至瀑布模式：音符会从上方落到琴键线。';
    } else {
        setMetronomeToggle(false);
        btnPlayPause.innerText = '播放';
        setPlayButtonAppearance('ready');
        instructionText.innerText = '已切换至节拍器模式。';
    }

    drawSheet(currentBeat);
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
    const shouldAutoSave = typeof options.autoSave === 'boolean' ? options.autoSave : options.saveToLibrary === true;
    const delayMs = options.delayMs ?? (shouldAutoSave ? 500 : 0);
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
        currentSheetId = normalizeLibraryId(options.libraryId ?? normalizedSong.id);

        let displayName = normalizedSong.name || fileName.split('.').slice(0, -1).join('.');
        if (!displayName.startsWith('《')) displayName = '《' + displayName;
        if (!displayName.endsWith('》')) displayName = displayName + '》';
        currentSongNameUI.innerText = displayName;

        // 更新 BPM
        bpm = normalizedSong.bpm || 100;
        msPerBeat = (60 / bpm) * 1000;
        bpmUI.value = bpm;

        if (shouldAutoSave) {
            // 自动保存到本地库
            saveToLibrary(normalizedSong, fileName).then((savedId) => {
                if (loadRequestId === songLoadRequestId) currentSheetId = normalizeLibraryId(savedId);
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

        const displayIds = new Map(
            [...sheets].reverse()
                .map((sheet, index) => [normalizeLibraryId(sheet.id), index + 1])
                .filter(([sheetId]) => sheetId !== null)
        );
        const countEl = document.getElementById('playlist-count');
        if (countEl) countEl.textContent = `${sheets.length} 首`;

        sheets.forEach(sheet => {
            const sheetId = normalizeLibraryId(sheet.id);
            if (sheetId === null) return;

            const ext = (sheet.fileName || sheet.name || '').split('.').pop()?.toUpperCase() || 'SHEET';
            const isLoaded = sheetId === currentSheetId;
            const isRunning = isLoaded && (isPlaying || isPaused);
            const statusClass = isRunning ? 's-playing' : isLoaded ? 's-learning' : 's-ready';
            const statusText = isRunning ? (isPaused ? 'Paused' : 'Playing') : isLoaded ? 'Loaded' : 'Ready';

            const row = document.createElement('tr');
            row.addEventListener('click', () => window.loadSheetFromLibrary(sheetId));

            const idCell = document.createElement('td');
            idCell.textContent = displayIds.get(sheetId) || sheetId;

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
            playBtn.type = 'button';
            playBtn.className = 'act-btn';
            playBtn.title = '播放';
            playBtn.textContent = '▶';
            playBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                window.loadSheetFromLibrary(sheetId, { autoPlay: true });
            });

            const stopBtn = document.createElement('button');
            stopBtn.type = 'button';
            stopBtn.className = 'act-btn';
            stopBtn.title = '停止';
            stopBtn.textContent = '■';
            stopBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                stopFromPlaylist(sheetId);
            });

            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'act-btn';
            editBtn.title = '编辑';
            editBtn.textContent = '✎';
            editBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                instructionText.innerText = '编辑功能暂未开放。';
            });

            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'act-btn del';
            deleteBtn.title = '删除';
            deleteBtn.textContent = '🗑';
            deleteBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                window.deleteSheetFromLibrary(sheetId);
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
        const sheetId = normalizeLibraryId(id);
        if (sheetId === null) return;

        const sheet = libraryCache.find(item => normalizeLibraryId(item.id) === sheetId) || await getSheetById(sheetId);
        if (sheet) {
            applyParsedSong(sheet, sheet.fileName || sheet.name, {
                autoSave: false,
                libraryId: sheetId,
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
        const sheetId = normalizeLibraryId(id);
        if (sheetId === null) return;

        const wasCurrentSheet = sheetId === currentSheetId;
        await deleteFromLibrary(sheetId);
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
if (btnWaterfall) {
    btnWaterfall.addEventListener('click', () => setMode('waterfall'));
}
if (modeSelectNative) {
    modeSelectNative.addEventListener('change', (e) => setMode(e.target.value));
}
if (metronomeToggle) {
    metronomeToggle.addEventListener('click', async () => {
        if (currentMode !== 'metro') setMode('metro');
        if (isPlaying) {
            stopMetronome();
        } else {
            await startMetronome();
        }
    });
}
if (keyboardLayoutToggle) {
    keyboardLayoutToggle.addEventListener('click', () => {
        setKeyboardLayoutMode(isCompactKeyboardMode() ? 'full' : 'compact');
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
                audioEngine.playMetronomeTick(metronomeBeatIndex % 4 === 0)
                    .catch(err => console.warn('节拍器播放失败:', err));
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
    updateVolumeDisplay(e.target.value);
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
            const parsedSong = await parseUploadFile(file);
            if (index === files.length - 1) {
                lastParsed = { song: parsedSong, fileName: file.name };
            } else {
                await saveToLibrary(normalizeSongData(parsedSong), file.name);
            }
        }

        if (lastParsed) {
            applyParsedSong(lastParsed.song, lastParsed.fileName, {
                autoSave: true,
                delayMs: 0
            });
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
    updateMidiInputSelect(connected ? midiController.getDeviceName() || text : text, connected);
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
    const nextKeyboardMetricsKey = getKeyboardMetrics().key;
    if (nextKeyboardMetricsKey !== keyboardMetricsKey) {
        renderKeyboard();
    }

    if (sheetCanvas) {
        resizeSheetCanvas();
        drawSheet(currentBeat);
    }
});

// ==================== 初始化 ====================

if (keyboardContainer && keyboardContainer.parentElement) {
    keyboardContainer.parentElement.addEventListener('scroll', () => {
        if (sheetCanvas) drawSheet(currentBeat);
    }, { passive: true });
}

export function init() {
    renderSheet();
    setKeyboardLayoutMode(keyboardLayoutMode, { persist: false, render: false });
    renderKeyboard();
    setMode(currentMode);
    setPlayButtonAppearance('ready');
    bpmUI.value = bpm;
    const volumeSlider = document.getElementById('volume-slider');
    if (volumeSlider) {
        volumeSlider.value = 1;
        audioEngine.setVolume(volumeSlider.value);
        updateVolumeDisplay(volumeSlider.value);
    }
    updateMidiInputSelect('Detecting MIDI...', false);
    midiController.init();

    // 初始化播放列表
    updatePlaylistUI();
}

// 自动初始化
init();
