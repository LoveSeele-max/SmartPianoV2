/**
 * audioEngine.js - 音频引擎模块
 * 专职管理 Web Audio API、Soundfont 加载、压限器及节点生命周期管理
 */

const OUTPUT_BOOST = 6;
const FALLBACK_NOTE_GAIN = 0.22;

export class AudioEngine {
    constructor() {
        this.audioCtx = null;
        this.pianoInstrument = null;
        this.activeAudioNodes = {};
        this.activeMetronomeNodes = new Set();
        this.masterGain = null;
        this.outputBoostGain = null;
        this.masterCompressor = null;
        this.loadingPromise = null;
        this.usingFallback = false;
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
            this.masterGain.gain.value = this._normalizeVolume(document.getElementById('volume-slider')?.value);

            this.outputBoostGain = this.audioCtx.createGain();
            this.outputBoostGain.gain.value = OUTPUT_BOOST;

            // 3. 硬件连线：音色库 -> 音量 -> 固定增益补偿 -> 压限器 -> 扬声器
            this.masterGain.connect(this.outputBoostGain);
            this.outputBoostGain.connect(this.masterCompressor);
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

        const metronomeNode = { osc, gain };
        this.activeMetronomeNodes.add(metronomeNode);
        osc.onended = () => {
            this.activeMetronomeNodes.delete(metronomeNode);
        };

        osc.connect(gain);
        gain.connect(this.masterGain);
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
            this.usingFallback = false;
            this._updateStatus('🎹 钢琴音色加载完成！可以开始弹奏了。');
            return piano;
        } catch (err) {
            console.error('音色加载失败', err);
            this.usingFallback = true;
            this._updateStatus('⚠️ 音色加载失败，已切换到备用合成音源。');
            return null;
        }
    }

    /** 使用 Web Audio oscillator 生成备用音源，保证断网或 CDN 失败时仍能发声 */
    _playFallbackNote(midiNum) {
        const ctx = this.audioCtx;
        const now = ctx.currentTime;
        const frequency = 440 * Math.pow(2, (midiNum - 69) / 12);
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        let stopped = false;

        osc.type = 'triangle';
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(FALLBACK_NOTE_GAIN, now + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.25);

        const fallbackNode = {
            stop: (when = ctx.currentTime) => {
                if (stopped) return;
                stopped = true;
                const stopAt = Math.max(ctx.currentTime, when);
                try {
                    gain.gain.cancelScheduledValues(stopAt);
                    gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), stopAt);
                    gain.gain.exponentialRampToValueAtTime(0.0001, stopAt + 0.045);
                    osc.stop(stopAt + 0.05);
                } catch (e) { /* 忽略已停止节点 */ }
            }
        };

        osc.onended = () => {
            if (this.activeAudioNodes[midiNum] === fallbackNode) {
                delete this.activeAudioNodes[midiNum];
            }
        };

        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 1.35);
        return fallbackNode;
    }

    /** 播放一个 MIDI 音符，返回专属节点引用 */
    playNote(midiNum) {
        if (!this.audioCtx) return null;

        if (this.activeAudioNodes[midiNum]) {
            try {
                this.activeAudioNodes[midiNum].stop(this.audioCtx.currentTime + 0.05);
            } catch (e) { /* 忽略已停止节点的错误 */ }
        }

        if (this.pianoInstrument) {
            // 返回生成的节点，用作这个音符的"身份证"
            const playedNode = this.pianoInstrument.play(midiNum, this.audioCtx.currentTime, { gain: 1.0 });
            this.activeAudioNodes[midiNum] = playedNode;
            return playedNode;
        }

        const fallbackNode = this._playFallbackNote(midiNum);
        this.activeAudioNodes[midiNum] = fallbackNode;
        return fallbackNode;
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

        this.activeMetronomeNodes.forEach(({ osc }) => {
            try {
                osc.stop();
            } catch (e) { /* 忽略 */ }
        });
        this.activeMetronomeNodes.clear();
    }

    /** 设置主音量 (0-1) */
    setVolume(value) {
        if (this.masterGain) {
            this.masterGain.gain.value = this._normalizeVolume(value);
        }
    }

    _normalizeVolume(value) {
        const parsedVolume = parseFloat(value);
        if (!Number.isFinite(parsedVolume)) return 1;
        return Math.max(0, Math.min(1, parsedVolume));
    }

    /** 更新状态文本 (内部) */
    _updateStatus(text) {
        if (this._onStatusChange) {
            this._onStatusChange(text);
        }
    }
}
