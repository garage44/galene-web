// Font config
import "@fontsource/oswald"
import "@fontsource/roboto"

import animate from './animate'
import {createI18n} from 'vue-i18n'
import env from './env.js'
import EventEmitter from 'eventemitter3'
import localeNL from '../locales/nl.js'
import Logger from './logger.js'
import protocol from './protocol.js'
import router from '../js/router.js'
import Store from './store.js'

class Pyrite extends EventEmitter {

    constructor() {
        super()
        this.logger = new Logger(this)
        this.logger.setLevel('debug')

        this.animate = animate
        this.env = env
        this.router = router(this)
        this.protocol = protocol

        this.logger.debug('loading store')
        this.store = new Store()
        this.$s = this.store.load()

        this.i18n = createI18n({
            locale: this.$s.language.id,
            messages: {
                nl: localeNL,
            },
            silentFallbackWarn: true,
            silentTranslationWarn: true,
        })

        this.router.beforeResolve((to, from, next) => {

            if (!this.$s.group.connected) {
                // Navigating groups will change the internally used groupId;
                // but only when not connected to a group already.
                if (to.name === 'groupsDisconnected') {
                    this.$s.group.name = to.params.groupId
                }
            }
            next()
        })
    }

    async addFileMedia(file) {
        this.logger.info('add file media')

        const {glnStream} = this.newUpStream(null, {
            direction: 'up',
            mirror: false,
            src: file,
        })
        glnStream.kind = 'video'

        this.$s.upMedia[glnStream.kind].push(glnStream.id)
        glnStream.userdata.play = true
        return glnStream
    }

    async addShareMedia() {
        this.logger.info('add share media')
        let stream = null
        try {
            if(!('getDisplayMedia' in navigator.mediaDevices))
                throw new Error('Your browser does not support screen sharing')
            /** @ts-ignore */
            stream = await navigator.mediaDevices.getDisplayMedia({video: true})
        } catch(e) {
            this.notify({level: 'error', message: e})
            return
        }

        const {glnStream, streamState} = this.newUpStream()
        glnStream.kind = 'screenshare'
        this.$s.upMedia[glnStream.kind].push(glnStream.id)

        glnStream.stream = stream

        stream.getTracks().forEach(t => {
            if (t.kind === 'audio') {
                streamState.hasAudio = true
            } else if (t.kind === 'video') {
                streamState.hasVideo = true
            }
            glnStream.pc.addTrack(t, stream)
            // Screensharing was stopped; e.g. through browser ui.
            t.onended = () => {
                this.delUpMedia(glnStream)
            }
            glnStream.labels[t.id] = 'screenshare'
        })

        return glnStream
    }

    async addUserMedia() {
        let localStreamId = this.findUpMedia('local')
        let oldStream = localStreamId && this.connection.up[localStreamId]

        if(oldStream) {
            this.logger.debug(`removing old stream`)
            this.stopUpMedia(oldStream)
        }

        const {glnStream, streamState} = this.newUpStream(localStreamId)
        glnStream.kind = 'local'
        glnStream.stream = this.localStream
        this.localGlnStream = glnStream

        this.$s.upMedia[glnStream.kind].push(glnStream.id)

        this.localStream.getTracks().forEach(t => {
            glnStream.labels[t.id] = t.kind
            if(t.kind === 'audio') {
                streamState.hasAudio = true
                if(!this.$s.devices.mic.enabled) {
                    this.logger.info('muting local stream')
                    t.enabled = false
                }
            } else if(t.kind === 'video') {
                streamState.hasVideo = true
                if(this.$s.devices.cam.resolution.id === '1080p') {
                    t.contentHint = 'detail'
                }
            }
            glnStream.pc.addTrack(t, this.localStream)
        })
    }

    async connect() {
        if(this.connection && this.connection.socket) {
            this.connection.close()
        }
        this.connection = new protocol.ServerConnection()

        this.connection.onconnected = this.onConnected.bind(this)
        this.connection.onclose = this.onClose.bind(this)
        this.connection.ondownstream = this.onDownStream.bind(this)
        this.connection.onuser = this.onUser.bind(this)
        this.connection.onjoined = this.onJoined.bind(this)

        this.connection.onusermessage = (id, dest, username, time, privileged, kind, message) => {
            switch(kind) {
            case 'error':
            case 'warning':
            case 'info':
                // eslint-disable-next-line no-case-declarations
                let from = id ? (username || 'Anonymous') : 'The Server'
                if(privileged) {
                    this.notify({level: 'error', message: `${from} said: ${message}`})
                }
                break
            case 'mute':
                if(privileged) {
                    this.muteLocalTracks(true)
                    this.notify({
                        level: 'warning',
                        message: `You have been muted${username ? ' by ' + username : ''}`,
                    })
                }
                break
            case 'clearchat':
                if(privileged) {
                    this.$s.chat.channels.main.messages = []
                }
                break
            default:
                break
            }
        }
        let url = `ws${location.protocol === 'https:' ? 's' : ''}://${location.host}/ws`
        this.logger.info(`connecting websocket ${url}`)
        try {
            await this.connection.connect(url)
        } catch(e) {
            this.notify({
                level: 'error',
                message: e.message ? e.message : "Couldn't connect to " + url,
            })
        }
    }

    delLocalMedia() {
        if (!this.localStream) return

        this.logger.info('delete local media share media')
        const stream = this.localStream
        const tracks = stream.getTracks()
        tracks.forEach(track => {
            this.logger.debug(`stopping track ${track.id}`)
            track.stop()
        })

        delete this.localStream
    }

    delMedia(id) {
        this.logger.debug(`[delMedia] remove stream ${id} from state`)
        this.$s.streams.splice(this.$s.streams.findIndex(i => i.id === id), 1)
    }

    delUpMedia(c) {
        this.stopUpMedia(c)
        this.delMedia(c.id)

        c.close()
        delete(this.connection.up[c.id])
    }

    delUpMediaKind(kind) {
        this.logger.debug(`remove all up media from kind: ${kind}`)
        for(let id in this.connection.up) {
            const c = this.connection.up[id]
            if(kind && c.kind != kind) {
                continue
            }
            c.close()
            this.delMedia(id)
            delete(this.connection.up[id])
            this.logger.debug(`remove up media stream: ${id}`)
            this.$s.upMedia[kind].splice(this.$s.upMedia[kind].indexOf(id), 1)
        }
    }

    disconnect() {
        this.logger.info(`disconnecting from group ${this.$s.group.name}`)
        this.$s.users = []
        this.$s.streams = []
        this.connection.close()
        this.delLocalMedia()
        this.$s.group.connected = false
    }

    findUpMedia(kind) {
        for(let id in this.connection.up) {
            if(this.connection.up[id].kind === kind)
                return id
        }
        return null
    }

    getMaxVideoThroughput() {
        switch(this.$s.media.upstream.id) {
        case 'lowest':
            return 150000
        case 'low':
            return 300000
        case 'normal':
            return 700000
        case 'unlimited':
            return null
        default:
            return 700000
        }
    }

    async getUserMedia(presence) {
        // Cleanup the old networked stream first:
        if (this.localStream && this.$s.group.connected) {
            app.delUpMediaKind('local')
        }

        if (this.localStream) {
            this.delLocalMedia()
        }

        await this.setMediaChoices()

        let selectedAudioDevice = false
        let selectedVideoDevice = false

        if (this.$s.devices.mic.selected.id !== null) selectedAudioDevice = {deviceId: this.$s.devices.mic.selected.id}
        if (this.$s.devices.cam.selected.id !== null) selectedVideoDevice = {deviceId: this.$s.devices.cam.selected.id}

        if (presence) {
            if (!presence.cam.enabled) selectedVideoDevice = false
            if (!presence.mic.enabled) selectedAudioDevice = false
            // A local stream cannot be initialized with neither audio and video; return early.
            if (!presence.cam.enabled && !presence.mic.enabled) {
                return
            }
        }

        // Verify whether the local mediastream is using the proper device setup.
        this.logger.debug(`using cam ${this.$s.devices.cam.selected.name}`)
        this.logger.debug(`using mic ${this.$s.devices.mic.selected.name}`)

        if(selectedVideoDevice) {
            if (this.$s.devices.cam.resolution.id === '720p') {
                this.logger.debug(`using 720p resolution`)
                selectedVideoDevice.width = {ideal: 1280, min: 640}
                selectedVideoDevice.height = {ideal: 720, min: 400}
            } else if(this.$s.devices.cam.resolution.id === '1080p') {
                this.logger.debug(`using 1080p resolution`)
                selectedVideoDevice.width = {ideal: 1920, min: 640}
                selectedVideoDevice.height = {ideal: 1080, min: 400}
            }
        }

        const constraints = {
            audio: selectedAudioDevice,
            video: selectedVideoDevice,
        }

        try {
            this.localStream = await navigator.mediaDevices.getUserMedia(constraints)
            this.$s.mediaReady = true
        } catch(e) {
            this.notify({level: 'error', message: e})
            return
        }

        // Add local stream to Galène; handle peer connection logic.
        if (this.$s.group.connected) {
            this.addUserMedia()
        }

        return this.localStream
    }

    muteLocalTracks(enabled) {
        for(let id in this.connection.up) {
            const glnStream = this.connection.up[id]
            if(glnStream.kind === 'local') {
                glnStream.stream.getTracks().forEach(t => {
                    if(t.kind === 'audio') {
                        t.enabled = enabled
                    }
                })
            }
        }
    }

    newUpStream(_id, state) {
        const glnStream = this.connection.newUpStream(_id)

        let streamState = {
            direction: 'up',
            hasAudio: false,
            hasVideo: false,
            id: glnStream.id,
            mirror: true,
            settings: {audio: {}, video: {}},
            volume: {
                locked: false,
                value: 100,
            },
        }

        if (state) {
            Object.assign(streamState, state)
        }

        this.$s.streams.push(streamState)

        glnStream.onerror = (e) => {
            this.notify({level: 'error', message: e})
            this.delUpMedia(glnStream)
        }
        glnStream.onabort = () => {
            this.delUpMedia(glnStream)
        }
        glnStream.onnegotiationcompleted = () => {
            const maxThroughput = this.getMaxVideoThroughput()
            this.setMaxVideoThroughput(glnStream, maxThroughput)
        }

        return {glnStream, streamState}
    }

    notify(notification) {
        if (!this.notificationId) {
            this.notificationId = 1
            notification.id = this.notificationId
        }

        if (typeof notification.timeout === 'undefined') {
            notification.timeout = 3000
        }

        this.$s.notifications.push(notification)
        setTimeout(() => {
            this.$s.notifications.splice(this.$s.notifications.findIndex(i => i.id === notification.id), 1)
        }, notification.timeout)

        this.notificationId += 1
    }

    onClose(code, reason) {
        this.$s.group.connected = false
        this.delUpMediaKind(null)
        this.notify({level: 'error', message: 'Disconnected'})

        if(code != 1000) {
            this.notify({level: 'error', message: `Socket close ${code}: ${reason}`})
        }
    }

    onConnected() {
        this.$s.user.id = this.connection.id
        const groupName = this.router.currentRoute.value.params.groupId
        this.logger.info(`joining group: ${groupName}`)
        this.connection.join(groupName, this.$s.user.name, this.$s.user.password)
        this.$s.group.connected = true
    }

    onDownStream(c) {
        this.logger.info(`new downstream ${c.id}`)
        c.onclose = (replace) => {
            if(!replace) {
                this.logger.debug(`[onclose] downstream ${c.id}`)
                this.delMedia(c.id)
            }
        }

        c.onerror = () => {
            const message = `[onerror] downstream ${c.id}`
            this.logger.info(message)
            this.notify({level: 'error', message})
        }

        const streamState = {
            direction: 'down',
            hasAudio: false,
            hasVideo: false,
            id: c.id,
            mirror: true,
            settings: {audio: {}, video: {}},
            volume: {
                locked: false,
                value: 100,
            },
        }

        this.$s.streams.push(streamState)
    }

    async onJoined(kind, group, perms, message) {
        this.$s.permissions = perms
        this.logger.info(`joined group ${group}`)
        this.logger.debug(`permissions: ${JSON.stringify(perms)}`)

        switch(kind) {
        case 'fail':
            this.notify({level: 'error', message: `The server said: ${message}`})
            this.connection.close()
            return
        case 'redirect':
            this.connection.close()
            document.location = message
            return
        case 'leave':
            this.connection.close()
            return
        case 'join':
        case 'change':
            if(kind === 'change')
                return
            break
        default:
            this.notify({level: 'error', message: 'Unknown join message'})
            this.connection.close()
            return
        }

        this.logger.info(`acceptable media types: ${this.$s.media.accept.id}`)
        this.connection.request(this.$s.media.accept.id)

        if(this.connection.permissions.present && !this.findUpMedia('local')) {
            await this.getUserMedia(this.$s.devices)
        }
    }

    onUser(id, kind, name) {

        const user = {id, name}
        switch(kind) {
        case 'add':
            if (name === 'RECORDING') this.$s.group.recording = true
            this.$s.users.push(user)
            this.emit('user', {action: 'add', user})
            break
        case 'delete':
            if (name === 'RECORDING') this.$s.group.recording = false
            this.$s.users.splice(this.$s.users.findIndex((u) => u.id === id), 1)
            this.emit('user', {action: 'del', user})
            break
        default:
            break
        }
    }

    removeTrack(glnStream, kind) {
        const tracks = glnStream.stream.getTracks()
        tracks.forEach(track => {
            if (track.kind === kind) {
                this.logger.debug(`stopping track ${track.id}`)
                track.stop()

                const streamState = this.$s.streams.find((s) => s.id === glnStream.id)
                streamState.hasVideo = false
            }

        })
    }

    async setMaxVideoThroughput(c, bps) {
        let senders = c.pc.getSenders()
        for(let i = 0; i < senders.length; i++) {
            let s = senders[i]
            if(!s.track || s.track.kind !== 'video')
                continue
            let p = s.getParameters()
            if(!p.encodings) p.encodings = [{}]
            p.encodings.forEach(e => {
                if(bps > 0) e.maxBitrate = bps
                else delete e.maxBitrate
            })
            this.logger.info(`cap video bandwidth: ${bps}`)

            await s.setParameters(p)
        }
    }

    async setMediaChoices() {
        let devices = await navigator.mediaDevices.enumerateDevices()

        let cn = 1, mn = 1

        this.$s.devices.mic.options = []
        this.$s.devices.cam.options = []

        devices.forEach(d => {
            let label = d.label

            if(d.kind === 'videoinput') {
                if(!label) label = `Camera ${cn}`
                this.$s.devices.cam.options.push({id: d.deviceId, name: label})
                cn++
            } else if(d.kind === 'audioinput') {
                if(!label) label = `Microphone ${mn}`
                this.$s.devices.mic.options.push({id: d.deviceId, name: label})
                mn++
            }
        })

        // Set default audio/video options when none is set.
        if (this.$s.devices.mic.selected.id === null && this.$s.devices.mic.options.length) {
            this.$s.devices.mic.selected = this.$s.devices.mic.options[0]
        }

        if (this.$s.devices.cam.selected.id === null && this.$s.devices.cam.options.length) {
            this.$s.devices.cam.selected = this.$s.devices.cam.options[0]
        }

        this.logger.info(`setMediaChoices: video(${this.$s.devices.cam.options.length}) audio(${this.$s.devices.mic.options.length})`)
    }

    stopUpMedia(c) {
        this.logger.debug(`stopping up-stream ${c.id}`)
        c.stream.getTracks().forEach(t => t.stop())

        this.$s.upMedia[c.kind].splice(this.$s.upMedia[c.kind].indexOf(c.id), 1)
    }
}

export default Pyrite
