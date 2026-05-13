/**
 * parser.js - 曲谱解析模块
 * 存放 MusicXML、MIDI (二进制) 和 JSON 的纯文本/二进制解析逻辑
 */

import { getNoteInfo, lookupByMidi } from './noteMap.js';

/**
 * 解析 MusicXML 格式
 * @param {string} xmlText - XML 文本内容
 * @returns {{ notes: Array, bpm: number }}
 */
export function parseMusicXML(xmlText) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, 'text/xml');

    const parserError = xmlDoc.querySelector('parsererror');
    if (parserError) throw new Error('MusicXML 格式无效');

    // 尝试提取 BPM
    let extractedBpm = 100;
    const soundEl = xmlDoc.querySelector('sound');
    if (soundEl && soundEl.getAttribute('tempo')) {
        extractedBpm = parseInt(soundEl.getAttribute('tempo'));
    }

    const notes = [];
    const stepToSemitone = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    const typeDurMap = {
        maxima: 32,
        longa: 16,
        breve: 8,
        whole: 4,
        half: 2,
        quarter: 1,
        eighth: 0.5,
        '16th': 0.25,
        '32nd': 0.125,
        '64th': 0.0625
    };

    function getDurationBeat(el, divisions) {
        const durationEl = el.querySelector(':scope > duration');
        if (durationEl) {
            const raw = parseFloat(durationEl.textContent);
            if (Number.isFinite(raw) && raw > 0) {
                return Math.max(0.0625, raw / divisions);
            }
        }

        let duration = typeDurMap[el.querySelector(':scope > type')?.textContent || 'quarter'] || 1;
        const dots = el.querySelectorAll(':scope > dot').length;
        let add = duration / 2;
        for (let i = 0; i < dots; i++) {
            duration += add;
            add /= 2;
        }
        return duration;
    }

    function pitchToNoteName(pitchEl) {
        const step = pitchEl.querySelector(':scope > step')?.textContent || 'C';
        const octave = parseInt(pitchEl.querySelector(':scope > octave')?.textContent || '4');
        const alter = parseInt(pitchEl.querySelector(':scope > alter')?.textContent || '0');
        const midi = (octave + 1) * 12 + stepToSemitone[step] + alter;
        return lookupByMidi(midi)?.name || null;
    }

    const parts = xmlDoc.querySelectorAll('part');
    parts.forEach(partEl => {
        let divisions = 1;
        let cursorBeat = 0;
        let lastNoteStartBeat = 0;

        partEl.querySelectorAll(':scope > measure').forEach(measureEl => {
            const divsEl = measureEl.querySelector(':scope > attributes > divisions');
            if (divsEl) divisions = parseInt(divsEl.textContent) || divisions;

            const measureSoundEl = measureEl.querySelector(':scope > direction sound[tempo], :scope > sound[tempo]');
            if (measureSoundEl) {
                const tempo = parseInt(measureSoundEl.getAttribute('tempo'));
                if (Number.isFinite(tempo) && tempo > 0) extractedBpm = tempo;
            }

            Array.from(measureEl.children).forEach(child => {
                if (child.tagName === 'backup') {
                    cursorBeat = Math.max(0, cursorBeat - getDurationBeat(child, divisions));
                    return;
                }

                if (child.tagName === 'forward') {
                    cursorBeat += getDurationBeat(child, divisions);
                    return;
                }

                if (child.tagName !== 'note') return;

                const durationBeat = getDurationBeat(child, divisions);
                const isChordTone = !!child.querySelector(':scope > chord');
                const startTimeBeat = isChordTone ? lastNoteStartBeat : cursorBeat;

                if (!child.querySelector(':scope > rest')) {
                    const pitch = child.querySelector(':scope > pitch');
                    const noteName = pitch ? pitchToNoteName(pitch) : null;
                    if (noteName) {
                        notes.push({
                            note: noteName,
                            fingering: 1,
                            startTimeBeat,
                            durationBeat
                        });
                    }
                }

                if (!isChordTone) {
                    lastNoteStartBeat = startTimeBeat;
                    cursorBeat += durationBeat;
                }
            });
        });
    });

    notes.sort((a, b) => a.startTimeBeat - b.startTimeBeat || getNoteInfo(a.note).midi - getNoteInfo(b.note).midi);
    return { notes, bpm: extractedBpm };
}

/**
 * 解析 MIDI 二进制文件
 * @param {ArrayBuffer} arrayBuffer - MIDI 文件的 ArrayBuffer
 * @returns {{ notes: Array, bpm: number }}
 */
export function parseMIDIFile(arrayBuffer) {
    const u8 = new Uint8Array(arrayBuffer);
    const dv = new DataView(arrayBuffer);
    let offset = 0;

    function readChunk() {
        const id = String.fromCharCode(u8[offset++], u8[offset++], u8[offset++], u8[offset++]);
        const length = dv.getUint32(offset, false);
        offset += 4;
        return { id, length, data: u8.slice(offset, offset + length) };
    }

    function readVarLen() {
        let value = 0, byte;
        do {
            byte = u8[offset++];
            value = (value << 7) | (byte & 0x7F);
        } while (byte & 0x80);
        return value;
    }

    const head = readChunk();
    offset += head.length;
    const numTracks = (head.data[2] << 8) | head.data[3];
    const ppq = (head.data[4] << 8) | head.data[5];
    let fileBpm = 120;
    const allEvents = [];

    for (let t = 0; t < numTracks; t++) {
        const trk = readChunk();
        if (trk.id !== 'MTrk') { offset += trk.length; continue; }
        const trkEnd = offset + trk.length;
        let absTime = 0;
        let runningStatus = 0;

        while (offset < trkEnd) {
            absTime += readVarLen();
            let statusByte = u8[offset++];

            if (statusByte < 0x80) {
                offset--;
                statusByte = runningStatus;
            } else if (statusByte < 0xF0) {
                runningStatus = statusByte;
            }

            const highNibble = statusByte & 0xF0;

            if (highNibble === 0xF0) {
                if (statusByte === 0xFF) {
                    const metaType = u8[offset++];
                    const len = readVarLen();
                    if (metaType === 0x51 && len === 3) {
                        fileBpm = Math.round(60000000 / ((u8[offset] << 16) | (u8[offset+1] << 8) | u8[offset+2]));
                    }
                    offset += len;
                } else if (statusByte === 0xF0 || statusByte === 0xF7) {
                    offset += readVarLen();
                }
            } else if (highNibble === 0x90 || highNibble === 0x80) {
                allEvents.push({
                    absTime,
                    type: highNibble,
                    noteNum: u8[offset++],
                    velocity: u8[offset++]
                });
            } else if (highNibble === 0xA0 || highNibble === 0xB0 || highNibble === 0xE0) {
                offset += 2;
            } else if (highNibble === 0xC0 || highNibble === 0xD0) {
                offset += 1;
            } else {
                break;
            }
        }
        offset = trkEnd;
    }

    allEvents.sort((a, b) => a.absTime - b.absTime);

    const activeNotes = {};
    const notes = [];

    allEvents.forEach(evt => {
        if (evt.type === 0x90 && evt.velocity > 0) {
            if (!activeNotes[evt.noteNum]) activeNotes[evt.noteNum] = [];
            activeNotes[evt.noteNum].push(evt.absTime);
        } else if (evt.type === 0x80 || (evt.type === 0x90 && evt.velocity === 0)) {
            if (activeNotes[evt.noteNum] && activeNotes[evt.noteNum].length > 0) {
                const startTime = activeNotes[evt.noteNum].shift();
                const name = lookupByMidi(evt.noteNum);
                if (name) {
                    notes.push({
                        note: name.name,
                        midi: evt.noteNum,
                        fingering: 1,
                        startTimeBeat: startTime / ppq,
                        durationBeat: Math.max(0.25, (evt.absTime - startTime) / ppq) || 1
                    });
                }
            }
        }
    });

    return { notes, bpm: fileBpm };
}

/**
 * 解析 JSON 格式曲谱
 * @param {string} jsonText - JSON 文本
 * @returns {{ name: string, data: Array }}
 */
export function parseJSONSheet(jsonText) {
    const data = JSON.parse(jsonText);
    return data.data ? data : { name: '自定义曲谱', data };
}

/**
 * 根据文件扩展名自动选择解析方式
 * @param {File} file - 上传的文件对象
 * @param {string|ArrayBuffer} content - 文件内容
 * @returns {{ name: string, data: Array, bpm: number }}
 */
export function parseSheetFile(file, content) {
    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'xml') {
        const parsed = parseMusicXML(content);
        return { name: file.name.replace(/\.xml$/i, ''), data: parsed.notes, bpm: parsed.bpm };
    }

    if (ext === 'mid' || ext === 'midi') {
        const parsed = parseMIDIFile(content);
        if (parsed.notes.length === 0) throw new Error('未在 MIDI 文件中找到有效音符');
        return { name: file.name.replace(/\.(mid|midi)$/i, ''), data: parsed.notes, bpm: parsed.bpm };
    }

    if (ext === 'json') return parseJSONSheet(content);

    throw new Error('不支持的格式');
}
