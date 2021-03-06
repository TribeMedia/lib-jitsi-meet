/* global __filename, Promise */
var logger = require("jitsi-meet-logger").getLogger(__filename);
var JitsiTrack = require("./JitsiTrack");
var RTCBrowserType = require("./RTCBrowserType");
var JitsiTrackEvents = require('../../JitsiTrackEvents');
var JitsiTrackErrors = require("../../JitsiTrackErrors");
var JitsiTrackError = require("../../JitsiTrackError");
var RTCEvents = require("../../service/RTC/RTCEvents");
var RTCUtils = require("./RTCUtils");
var MediaType = require('../../service/RTC/MediaType');
var VideoType = require('../../service/RTC/VideoType');
var CameraFacingMode = require('../../service/RTC/CameraFacingMode');

/**
 * Represents a single media track(either audio or video).
 * One <tt>JitsiLocalTrack</tt> corresponds to one WebRTC MediaStreamTrack.
 * @param stream WebRTC MediaStream, parent of the track
 * @param track underlying WebRTC MediaStreamTrack for new JitsiRemoteTrack
 * @param mediaType the MediaType of the JitsiRemoteTrack
 * @param videoType the VideoType of the JitsiRemoteTrack
 * @param resolution the video resoultion if it's a video track
 * @param deviceId the ID of the local device for this track
 * @param facingMode the camera facing mode used in getUserMedia call
 * @constructor
 */
function JitsiLocalTrack(stream, track, mediaType, videoType, resolution,
                         deviceId, facingMode) {
    var self = this;

    JitsiTrack.call(this,
        null /* RTC */, stream, track,
        function () {
            if(!this.dontFireRemoveEvent)
                this.eventEmitter.emit(
                    JitsiTrackEvents.LOCAL_TRACK_STOPPED);
            this.dontFireRemoveEvent = false;
        }.bind(this) /* inactiveHandler */,
        mediaType, videoType, null /* ssrc */);
    this.dontFireRemoveEvent = false;
    this.resolution = resolution;
    this.deviceId = deviceId;
    this.startMuted = false;
    this.initialMSID = this.getMSID();
    this.inMuteOrUnmuteProgress = false;

    /**
     * The facing mode of the camera from which this JitsiLocalTrack instance
     * was obtained.
     */
    this._facingMode = facingMode;

    // Currently there is no way to know the MediaStreamTrack ended due to to
    // device disconnect in Firefox through e.g. "readyState" property. Instead
    // we will compare current track's label with device labels from
    // enumerateDevices() list.
    this._trackEnded = false;

    // Currently there is no way to determine with what device track was
    // created (until getConstraints() support), however we can associate tracks
    // with real devices obtained from enumerateDevices() call as soon as it's
    // called.
    this._realDeviceId = this.deviceId === '' ? undefined : this.deviceId;

    this._onDeviceListChanged = function (devices) {
        self._setRealDeviceIdFromDeviceList(devices);

        // Mark track as ended for those browsers that do not support
        // "readyState" property. We do not touch tracks created with default
        // device ID "".
        if (typeof self.getTrack().readyState === 'undefined'
            && typeof self._realDeviceId !== 'undefined'
            && !devices.find(function (d) {
                return d.deviceId === self._realDeviceId;
            })) {
            self._trackEnded = true;
        }
    };

    // Subscribe each created local audio track to
    // RTCEvents.AUDIO_OUTPUT_DEVICE_CHANGED event. This is different from
    // handling this event for remote tracks (which are handled in RTC.js),
    // because there might be local tracks not attached to a conference.
    if (this.isAudioTrack() && RTCUtils.isDeviceChangeAvailable('output')) {
        this._onAudioOutputDeviceChanged = this.setAudioOutput.bind(this);

        RTCUtils.addListener(RTCEvents.AUDIO_OUTPUT_DEVICE_CHANGED,
            this._onAudioOutputDeviceChanged);
    }

    RTCUtils.addListener(RTCEvents.DEVICE_LIST_CHANGED,
        this._onDeviceListChanged);
}

JitsiLocalTrack.prototype = Object.create(JitsiTrack.prototype);
JitsiLocalTrack.prototype.constructor = JitsiLocalTrack;

/**
 * Returns if associated MediaStreamTrack is in the 'ended' state
 * @returns {boolean}
 */
JitsiLocalTrack.prototype.isEnded = function () {
    return  this.getTrack().readyState === 'ended' || this._trackEnded;
};

/**
 * Sets real device ID by comparing track information with device information.
 * This is temporary solution until getConstraints() method will be implemented
 * in browsers.
 * @param {MediaDeviceInfo[]} devices - list of devices obtained from
 *  enumerateDevices() call
 */
JitsiLocalTrack.prototype._setRealDeviceIdFromDeviceList = function (devices) {
    var track = this.getTrack(),
        device = devices.find(function (d) {
            return d.kind === track.kind + 'input' && d.label === track.label;
        });

    if (device) {
        this._realDeviceId = device.deviceId;
    }
};

/**
 * Mutes the track. Will reject the Promise if there is mute/unmute operation
 * in progress.
 * @returns {Promise}
 */
JitsiLocalTrack.prototype.mute = function () {
    return createMuteUnmutePromise(this, true);
};

/**
 * Unmutes the track. Will reject the Promise if there is mute/unmute operation
 * in progress.
 * @returns {Promise}
 */
JitsiLocalTrack.prototype.unmute = function () {
    return createMuteUnmutePromise(this, false);
};

/**
 * Creates Promise for mute/unmute operation.
 *
 * @param {JitsiLocalTrack} track - The track that will be muted/unmuted.
 * @param {boolean} mute - Whether to mute or unmute the track.
 * @returns {Promise}
 */
function createMuteUnmutePromise(track, mute) {
    if (track.inMuteOrUnmuteProgress) {
        return Promise.reject(
            new JitsiTrackError(JitsiTrackErrors.TRACK_MUTE_UNMUTE_IN_PROGRESS)
        );
    }

    track.inMuteOrUnmuteProgress = true;

    return track._setMute(mute)
        .then(function() {
            track.inMuteOrUnmuteProgress = false;
        })
        .catch(function(status) {
            track.inMuteOrUnmuteProgress = false;
            throw status;
        });
}

/**
 * Mutes / unmutes the track.
 *
 * @param {boolean} mute - If true the track will be muted. Otherwise the track
 * will be unmuted.
 * @private
 * @returns {Promise}
 */
JitsiLocalTrack.prototype._setMute = function (mute) {
    if (this.isMuted() === mute) {
        return Promise.resolve();
    }

    var promise = Promise.resolve();
    var self = this;

    // Local track can be used out of conference, so we need to handle that
    // case and mark that track should start muted or not when added to
    // conference.
    if(!this.conference || !this.conference.room) {
        this.startMuted = mute;
    }

    this.dontFireRemoveEvent = false;

    // FIXME FF does not support 'removeStream' method used to mute
    if (window.location.protocol !== "https:" ||
        this.isAudioTrack() ||
        this.videoType === VideoType.DESKTOP ||
        RTCBrowserType.isFirefox()) {

        if(this.track)
            this.track.enabled = !mute;
    } else {
        if(mute) {
            this.dontFireRemoveEvent = true;

            promise = this._removeStreamFromConferenceAsMute()
                .then(function() {
                    //FIXME: Maybe here we should set the SRC for the containers
                    // to something
                    RTCUtils.stopMediaStream(self.stream);
                    self.stream = null;
                });
        } else {
            // This path is only for camera.
            var streamOptions = {
                cameraDeviceId: this.getDeviceId(),
                devices: [ MediaType.VIDEO ],
                facingMode: this.getCameraFacingMode(),
                resolution: this.resolution
            };

            promise = RTCUtils.obtainAudioAndVideoPermissions(streamOptions)
                .then(function (streamsInfo) {
                    var mediaType = self.getType();
                    var streamInfo = streamsInfo.find(function(info) {
                        return info.mediaType === mediaType;
                    });

                    if(!streamInfo) {
                        throw new JitsiTrackError(
                            JitsiTrackErrors.TRACK_NO_STREAM_FOUND);
                    }else {
                        self.stream = streamInfo.stream;
                        self.track = streamInfo.track;
                        // This is not good when video type changes after
                        // unmute, but let's not crash here
                        if (self.videoType !== streamInfo.videoType) {
                            logger.warn(
                                "Video type has changed after unmute!",
                                self.videoType, streamInfo.videoType);
                            self.videoType = streamInfo.videoType;
                        }
                    }

                    self.containers = self.containers.map(function(cont) {
                        return RTCUtils.attachMediaStream(cont, self.stream);
                    });

                   return self._addStreamToConferenceAsUnmute();
                });
        }
    }

    return promise
        .then(function() {
            return self._sendMuteStatus(mute);
        })
        .then(function() {
            self.eventEmitter.emit(JitsiTrackEvents.TRACK_MUTE_CHANGED);
        });
};

/**
 * Adds stream to conference and marks it as "unmute" operation.
 *
 * @private
 * @returns {Promise}
 */
JitsiLocalTrack.prototype._addStreamToConferenceAsUnmute = function () {
    if (!this.conference || !this.conference.room) {
        return Promise.resolve();
    }

    var self = this;

    return new Promise(function(resolve, reject) {
        self.conference.room.addStream(
            self.stream,
            resolve,
            reject,
            {
                mtype: self.type,
                type: "unmute",
                ssrc: self.ssrc,
                msid: self.getMSID()
            });
    });
};

/**
 * Removes stream from conference and marks it as "mute" operation.
 *
 * @private
 * @returns {Promise}
 */
JitsiLocalTrack.prototype._removeStreamFromConferenceAsMute = function () {
    if (!this.conference || !this.conference.room) {
        return Promise.resolve();
    }

    var self = this;

    return new Promise(function(resolve, reject) {
        self.conference.room.removeStream(
            self.stream,
            resolve,
            reject,
            {
                mtype: self.type,
                type: "mute",
                ssrc: self.ssrc
            });
    });
};

/**
 * Sends mute status for a track to conference if any.
 *
 * @param {boolean} mute - If track is muted.
 * @private
 * @returns {Promise}
 */
JitsiLocalTrack.prototype._sendMuteStatus = function(mute) {
    if (!this.conference || !this.conference.room) {
        return Promise.resolve();
    }

    var self = this;

    return new Promise(function(resolve) {
        self.conference.room[
            self.isAudioTrack()
                ? 'setAudioMute'
                : 'setVideoMute'](mute, resolve);
    });
};

/**
 * @inheritdoc
 *
 * Stops sending the media track. And removes it from the HTML.
 * NOTE: Works for local tracks only.
 *
 * @extends JitsiTrack#dispose
 * @returns {Promise}
 */
JitsiLocalTrack.prototype.dispose = function () {
    var self = this;
    var promise = Promise.resolve();

    if (this.conference){
        promise = this.conference.removeTrack(this);
    }

    if (this.stream) {
        RTCUtils.stopMediaStream(this.stream);
        this.detach();
    }

    RTCUtils.removeListener(RTCEvents.DEVICE_LIST_CHANGED,
        this._onDeviceListChanged);

    if (this._onAudioOutputDeviceChanged) {
        RTCUtils.removeListener(RTCEvents.AUDIO_OUTPUT_DEVICE_CHANGED,
            this._onAudioOutputDeviceChanged);
    }

    return promise
        .then(function() {
            return JitsiTrack.prototype.dispose.call(self); // super.dispose();
        });
};

/**
 * Returns <tt>true</tt> - if the stream is muted
 * and <tt>false</tt> otherwise.
 * @returns {boolean} <tt>true</tt> - if the stream is muted
 * and <tt>false</tt> otherwise.
 */
JitsiLocalTrack.prototype.isMuted = function () {
    // this.stream will be null when we mute local video on Chrome
    if (!this.stream)
        return true;
    if (this.isVideoTrack() && !this.isActive()) {
        return true;
    } else {
        return !this.track || !this.track.enabled;
    }
};

/**
 * Updates the SSRC associated with the MediaStream in JitsiLocalTrack object.
 * @ssrc the new ssrc
 */
JitsiLocalTrack.prototype._setSSRC = function (ssrc) {
    this.ssrc = ssrc;
};


/**
 * Sets the JitsiConference object associated with the track. This is temp
 * solution.
 * @param conference the JitsiConference object
 */
JitsiLocalTrack.prototype._setConference = function(conference) {
    this.conference = conference;

    // We want to keep up with postponed events which should have been fired
    // on "attach" call, but for local track we not always have the conference
    // before attaching. However this may result in duplicated events if they
    // have been triggered on "attach" already.
    for(var i = 0; i < this.containers.length; i++)
    {
        this._maybeFireTrackAttached(this.containers[i]);
    }
};

/**
 * Gets the SSRC of this local track if it's available already or <tt>null</tt>
 * otherwise. That's because we don't know the SSRC until local description is
 * created.
 * In case of video and simulcast returns the the primarySSRC.
 * @returns {string} or {null}
 */
JitsiLocalTrack.prototype.getSSRC = function () {
    if(this.ssrc && this.ssrc.groups && this.ssrc.groups.length)
        return this.ssrc.groups[0].primarySSRC;
    else if(this.ssrc && this.ssrc.ssrcs && this.ssrc.ssrcs.length)
        return this.ssrc.ssrcs[0];
    else
        return null;
};

/**
 * Returns <tt>true</tt>.
 * @returns {boolean} <tt>true</tt>
 */
JitsiLocalTrack.prototype.isLocal = function () {
    return true;
};

/**
 * Returns device id associated with track.
 * @returns {string}
 */
JitsiLocalTrack.prototype.getDeviceId = function () {
    return this._realDeviceId || this.deviceId;
};

/**
 * Returns facing mode for video track from camera. For other cases (e.g. audio
 * track or 'desktop' video track) returns undefined.
 *
 * @returns {CameraFacingMode|undefined}
 */
JitsiLocalTrack.prototype.getCameraFacingMode = function () {
    if (this.isVideoTrack() && this.videoType === VideoType.CAMERA) {
        // MediaStreamTrack#getSettings() is not implemented in many browsers,
        // so we need feature checking here. Progress on the respective
        // browser's implementation can be tracked at
        // https://bugs.chromium.org/p/webrtc/issues/detail?id=2481 for Chromium
        // and https://bugzilla.mozilla.org/show_bug.cgi?id=1213517 for Firefox.
        // Even if a browser implements getSettings() already, it might still
        // not return anything for 'facingMode'.
        var trackSettings;

        try {
            trackSettings = this.track.getSettings();
        } catch (e) {
            // XXX React-native-webrtc, for example, defines
            // MediaStreamTrack#getSettings() but the implementation throws a
            // "Not implemented" Error.
        }
        if (trackSettings && 'facingMode' in trackSettings) {
            return trackSettings.facingMode;
        }

        if (typeof this._facingMode !== 'undefined') {
            return this._facingMode;
        }

        // In most cases we are showing a webcam. So if we've gotten here, it
        // should be relatively safe to assume that we are probably showing
        // the user-facing camera.
        return CameraFacingMode.USER;
    }

    return undefined;
};


module.exports = JitsiLocalTrack;
