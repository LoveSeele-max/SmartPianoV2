/**
 * audioEngine.js - 音频引擎模块
 * 专职管理 Web Audio API、Soundfont 加载、压限器及节点生命周期管理
 */

export class AudioEngine {
    constructor() {
        this.audioCtx = null;
        this.pianoInstrument = null;
        this.activeAudioNodes = {};
        this.masterGain = null;
        this.masterCompressor = null;
        this.loadingPromise = null;
        this._onStatusChange = null;
    }

    /** 注册状态变更回调函数 */
    onStatusChange(callback) {
        this._onStatusChange = callback;
    }

    /** 获取 AudioContext */
    getContext() {
        return this.audioCtx;
    }

    /** 初始化音频上下文与基础链路，不强制加载钢琴音色 */
    async ensureContext() {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

            // 1. 创建动态压限器 (完美解决多音符并发导致的音量骤降)
            this.masterCompressor = this.audioCtx.createDynamicsCompressor();
            this.masterCompressor.threshold.value = -12;
            this.masterCompressor.knee.value = 30;
            this.masterCompressor.ratio.value = 12;
            this.masterCompressor.attack.value = 0.003;
            this.masterCompressor.release.value = 0.25;

            // 2. 创建主控增益控制器
            this.masterGain = this.audioCtx.createGain();
            const parsedVolume = parseFloat(document.getElementById('volume-slider')?.value);
            this.masterGain.gain.value = Number.isFinite(parsedVolume) ? parsedVolume : 8;

            // 3. 硬件连线：音色库 -> 增益 -> 压限器 -> 扬声器
            this.masterGain.connect(this.masterCompressor);
            this.masterCompressor.connect(this.audioCtx.destination);
        }
        if (this.audioCtx.state === 'suspended') {
            await this.audioCtx.resume();
        }

        return this.audioCtx;
    }

    /** 初始化音频上下文与音色链路 */
    async init() {
        await this.ensureContext();

        if (!this.pianoInstrument) {
            if (!this.loadingPromise) {
                this.loadingPromise = this._loadSoundfont().finally(() => {
                    this.loadingPromise = null;
                });
            }
            await this.loadingPromise;
        }

        return this.pianoInstrument;
    }

    /** 播放节拍器提示音 */
    async playMetronomeTick(accent = false) {
        const ctx = await this.ensureContext();
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.value = accent ? 1320 : 880;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(accent ? 0.18 : 0.11, now + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);

        osc.connect(gain);
        gain.connect(this.masterCompressor);
        osc.start(now);
        osc.stop(now + 0.08);
    }

    /** 加载 Soundfont 钢琴音色库 */
    async _loadSoundfont() {
        this._updateStatus('⏳ 正在加载真实钢琴音色，请稍候...');
        try {
            const piano = await Soundfont.instrument(this.audioCtx, 'acoustic_grand_piano', {
                destination: this.masterGain
            });
            this.pianoInstrument = piano;
            this._updateStatus('🎹 钢琴音色加载完成！可以开始弹奏了。');
            return piano;
        } catch (err) {
            console.error('音色加载失败', err);
            this._updateStatus('⚠️ 音色加载失败，请检查网络。');
            return null;
        }
    }

    /** 播放一个 MIDI 音符，返回专属节点引用 */
    playNote(midiNum) {
        if (!this.audioCtx) return null;

        if (this.pianoInstrument) {
            // 停止同一个音符的旧声音
            if (this.activeAudioNodes[midiNum]) {
                try {
                    this.activeAudioNodes[midiNum].stop(this.audioCtx.currentTime + 0.05);
                } catch (e) { /* 忽略已停止节点的错误 */ }
            }
            // 返回生成的节点，用作这个音符的"身份证"
            const playedNode = this.pianoInstrument.play(midiNum, this.audioCtx.currentTime, { gain: 1.0 });
            this.activeAudioNodes[midiNum] = playedNode;
            return playedNode;
        }
        return null;
    }

    /** 停止一个音符的声音 */
    stopNote(midiNum, specificNode = null) {
        if (specificNode) {
            // 自动播放模式：精准狙击，只停止它自己的声音
            try { specificNode.stop(); } catch (e) { /* 忽略 */ }
            if (this.activeAudioNodes[midiNum] === specificNode) {
                delete this.activeAudioNodes[midiNum];
            }
        } else if (this.activeAudioNodes[midiNum]) {
            // 纯手动模式：平滑衰减当前活跃节点
            try {
                this.activeAudioNodes[midiNum].stop(this.audioCtx.currentTime + 0.05);
            } catch (e) { /* 忽略 */ }
            delete this.activeAudioNodes[midiNum];
        }
    }

    /** 停止所有活动音符 */
    stopAllNotes() {
        Object.keys(this.activeAudioNodes).forEach(midi => {
            try {
                this.activeAudioNodes[midi].stop();
            } catch (e) { /* 忽略 */ }
        });
        this.activeAudioNodes = {};
    }

    /** 设置主音量 (0-10) */
    setVolume(value) {
        if (this.masterGain) {
            const parsedVolume = parseFloat(value);
            if (Number.isFinite(parsedVolume)) {
                this.masterGain.gain.value = parsedVolume;
            }
        }
    }

    /** 更新状态文本 (内部) */
    _updateStatus(text) {
        if (this._onStatusChange) {
            this._onStatusChange(text);
        }
    }
}
