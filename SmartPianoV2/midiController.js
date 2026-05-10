/**
 * midiController.js - MIDI 控制器模块
 * 专职管理 Web MIDI API 连接、雅马哈专属信号过滤、MIDI 信号解析
 */

export class MidiController {
    constructor() {
        this._onNoteOn = null;
        this._onNoteOff = null;
        this._onStatusChange = null;
        this._midiAccess = null;
        this._connectedDeviceName = '';
    }

    /** 注册回调函数 */
    onNoteOn(callback) { this._onNoteOn = callback; }
    onNoteOff(callback) { this._onNoteOff = callback; }
    onStatusChange(callback) { this._onStatusChange = callback; }

    /** 获取当前连接的设备名称 */
    getDeviceName() { return this._connectedDeviceName; }

    /** 初始化 MIDI 连接 */
    init() {
        if (navigator.requestMIDIAccess) {
            navigator.requestMIDIAccess()
                .then(access => this._onMIDISuccess(access))
                .catch(err => this._onMIDIFailure(err));
        } else {
            this._updateStatus('浏览器不支持 MIDI，请使用鼠标点击。');
        }
    }

    /** MIDI 连接成功回调 */
    _onMIDISuccess(midiAccess) {
        this._midiAccess = midiAccess;
        const inputs = midiAccess.inputs.values();
        let hasDevice = false;

        for (let input = inputs.next(); input && !input.done; input = inputs.next()) {
            hasDevice = true;
            input.value.onmidimessage = (msg) => this._onMIDIMessage(msg);
            this._connectedDeviceName = input.value.name;
            this._updateStatus(`已连接: ${input.value.name}`, true);
        }

        if (!hasDevice) {
            this._updateStatus('未检测到外部 MIDI 键盘。', false);
        }

        // 监听设备热插拔
        midiAccess.onstatechange = (e) => {
            if (e.port.type === 'input') {
                if (e.port.state === 'connected') {
                    e.port.onmidimessage = (msg) => this._onMIDIMessage(msg);
                    this._connectedDeviceName = e.port.name;
                    this._updateStatus(`已连接: ${e.port.name}`, true);
                } else {
                    this._connectedDeviceName = '';
                    this._updateStatus('MIDI已断开。', false);
                }
            }
        };
    }

    /** MIDI 连接失败回调 */
    _onMIDIFailure(err) {
        console.error('MIDI 连接失败:', err);
        this._updateStatus('无法访问MIDI权限。', false);
    }

    /**
     * MIDI 消息处理
     * 【雅马哈专属优化】过滤掉心跳包(254)和时钟信号(248)
     */
    _onMIDIMessage(message) {
        // 雅马哈 PSR-E383 专属优化：过滤心跳包和时钟信号
        if (message.data[0] === 254 || message.data[0] === 248) return;

        // 提取高四位指令，忽略低四位通道号
        const cmd = message.data[0] & 0xF0;
        const note = message.data[1];
        const vel = message.data[2];

        if (cmd === 144 && vel > 0) {
            // Note On
            if (this._onNoteOn) this._onNoteOn(note);
        } else if (cmd === 128 || (cmd === 144 && vel === 0)) {
            // Note Off
            if (this._onNoteOff) this._onNoteOff(note);
        }
    }

    /** 更新状态显示 */
    _updateStatus(text, connected = false) {
        if (this._onStatusChange) {
            this._onStatusChange(text, connected);
        }
    }
}
