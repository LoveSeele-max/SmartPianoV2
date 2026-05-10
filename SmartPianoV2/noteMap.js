/**
 * noteMap.js - 音符映射与基础常量
 * 管理 MIDI 音符与名称的映射关系
 */

// 音符名称与中文唱名
const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const labels = ['do', '', 're', '', 'mi', 'fa', '', 'sol', '', 'la', '', 'si'];

// 数据存储
const noteMap = {};
const midiToNoteName = {};
const whiteKeysToRender = [];

// 初始化所有音符 (MIDI 36~96)
for (let midi = 36; midi <= 96; midi++) {
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
    midiToNoteName[midi] = name;

    if (!isBlack) whiteKeysToRender.push(name);
}

/** 根据音符名称获取音符信息 */
export function getNoteInfo(noteName) {
    return noteMap[noteName] || null;
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

export { noteMap, midiToNoteName, whiteKeysToRender };
