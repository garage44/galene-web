<template>
    <canvas id="meter" ref="meter" />
</template>
<script>

function volumeAudioProcess(event) {
    var buf = event.inputBuffer.getChannelData(0)
    var bufLength = buf.length
    var sum = 0
    var x

    for (var i = 0; i < bufLength; i++) {
        x = buf[i]
        if (Math.abs(x) >= this.clipLevel) {
            this.clipping = true
            this.lastClip = window.performance.now()
        }
        sum += x * x
    }

    var rms = Math.sqrt(sum / bufLength)
    this.volume = Math.max(rms, this.volume * this.averaging)
}

function createAudioMeter(audioContext, clipLevel, averaging, clipLag) {
    const processor = audioContext.createScriptProcessor(512)
    processor.onaudioprocess = volumeAudioProcess
    processor.clipping = false
    processor.lastClip = 0
    processor.volume = 0.1
    processor.clipLevel = clipLevel || 0.98
    processor.averaging = averaging || 0.95
    processor.clipLag = clipLag || 750

    // this will have no effect, since we don't copy the input to the output,
    // but works around a current Chrome bug.
    processor.connect(audioContext.destination)
    processor.checkClipping = function() {
        if (!this.clipping) return false
        if ((this.lastClip + this.clipLag) < window.performance.now()) {
            this.clipping = false
        }
        return this.clipping
    }

    processor.shutdown = function() {
        this.disconnect()
        this.onaudioprocess = null
    }

    return processor
}


let meter = null


export default {
    props: {
        stream: {
            required: true,
            type: Object
        },
        /**
         * Stream id is passed to be able to react to stream changes.
         */
        streamId: {
            required: true,
            type: String
        }
    },
    data() {
        return {
            state: app.state
        }
    },
    watch: {
        streamId(streamId) {
            this.updateSoundmeter()
        }
    },
    unmounted: function() {
        // Stop the volume meter.
        window.cancelAnimationFrame(this.rafID)
    },
    mounted: async function() {
        this.canvasContext = this.$refs.meter.getContext('2d')
        const computedStyle = getComputedStyle(document.querySelector('.theme'))
        this.colors = {
            primary: computedStyle.getPropertyValue('--primary-color'),
            warning: computedStyle.getPropertyValue('--warning-color'),
        }

        this.updateSoundmeter()
        this.drawLoop()
    },
    methods: {
        drawLoop: function() {
            this.canvasContext.clearRect(0, 0, this.$refs.meter.width, this.$refs.meter.height)
            if (this.meter.checkClipping()) {
               this.canvasContext.fillStyle = this.colors.warning
            } else {
                this.canvasContext.fillStyle = this.colors.primary
            }

            this.canvasContext.fillRect(0, 0, this.meter.volume * this.$refs.meter.width * 2.4, this.$refs.meter.height)
            this.rafID = window.requestAnimationFrame(this.drawLoop)
        },
        updateSoundmeter: async function() {
            this.audioContext = new AudioContext()
            const mediaStreamSource = this.audioContext.createMediaStreamSource(this.stream)
            this.meter = createAudioMeter(this.audioContext)
            mediaStreamSource.connect(this.meter)
        },
    }
}

</script>
<style lang="postcss">
canvas {
    border: 1px solid var(--grey-200);
    height: var(--spacer);
    margin: var(--spacer);
    max-width: 300px;
    width: 100%;
}
</style>