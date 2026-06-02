/**
 * noteMap.js - 音符映射与基础常量
 * 管理 MIDI 音符与名称的映射关系
 */

// 音符名称与中文唱名
const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const flatNoteNames = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const labels = ['do', '', 're', '', 'mi', 'fa', '', 'sol', '', 'la', '', 'si'];
const MIDI_MIN = 21;
const MIDI_MAX = 108;
const RENDER_MIN = 36;
const RENDER_MAX = 96;

// 数据存储
const noteMap = {};
const midiToNoteName = {};
const whiteKeysToRender = [];

// 初始化完整钢琴范围 (MIDI 21~108)，虚拟键盘仍渲染原 61 键范围
for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
    const noteIndex = midi % 12;
    const octave = Math.floor(midi / 12) - 1;
    const name = noteNames[noteIndex] + octave;
    const isBlack = name.includes('#');

    noteMap[name] = {
        midi,
        name,
        label: labels[noteIndex],
        type: isBlack ? 'black' : 'white'
    };
    const flatName = flatNoteNames[noteIndex] + octave;
    if (flatName !== name) {
        noteMap[flatName] = {
            ...noteMap[name],
            name: flatName,
            canonicalName: name
        };
    }
    midiToNoteName[midi] = name;

    if (!isBlack && midi >= RENDER_MIN && midi <= RENDER_MAX) whiteKeysToRender.push(name);
}

/** 根据音符名称获取音符信息 */
export function getNoteInfo(noteName) {
    if (!noteName) return null;
    const normalizedName = String(noteName).trim().replaceAll('♯', '#').replaceAll('♭', 'b');
    return noteMap[normalizedName] || null;
}

/** 根据 MIDI 编号查找音符信息 */
export function lookupByMidi(midiNum) {
    const name = midiToNoteName[midiNum];
    return name ? noteMap[name] : null;
}

/** 获取白键列表 */
export function getWhiteKeys() {
    return [...whiteKeysToRender];
}

/** 获取完整的音符名称列表 */
export function getNoteNames() {
    return [...noteNames];
}

export { noteMap, midiToNoteName, whiteKeysToRender, MIDI_MIN, MIDI_MAX };
