// adapted from https://github.com/webrtc/testrtc/blob/master/src/js/bandwidth_test.js

import WebrtcCall from '../utils/WebrtcCall';
import Test from '../utils/Test';
import StatisticsAggregate from '../utils/StatisticsAggregate';

export default class VideoBandwidthTest extends Test {
  constructor () {
    super(...arguments);
    this.name = 'Bandwidth Test';
    this.maxVideoBitrateKbps = 2000;
    this.durationMs = 40000;
    this.statStepMs = 100;
    this.bweStats = new StatisticsAggregate(0.75 * this.maxVideoBitrateKbps * 1000);
    this.rttStats = new StatisticsAggregate();
    this.packetsLost = null;
    this.videoStats = [];
    this.startTime = null;
    this.call = null;
    // Open the camera with hd resolution specs to get a correct measurement of ramp-up time.
    this.constraints = {
      audio: false,
      video: {
        width: {
          min: 640,
          ideal: 1280,
          max: 1920
        },
        height: {
          min: 480,
          ideal: 720,
          max: 1080
        }
      }

    };
    if (this.options.mediaOptions.video.deviceId) {
      this.constraints.video.deviceId = this.options.mediaOptions.video.deviceId;
    }
    this.log = [];
    this.stats = {};
  }

  start () {
    super.start();

    this.addLog('info', 'Video Bandwidth Test');

    if (!this.options.iceConfig.iceServers.length) {
      this.addLog('error', 'No ice servers were provided');
      return this.reject(this.log);
    }
    this.call = new WebrtcCall(this.options.iceConfig);
    this.call.setIceCandidateFilter(WebrtcCall.isRelay);
    // FEC makes it hard to study bandwidth estimation since there seems to be
    // a spike when it is enabled and disabled. Disable it for now. FEC issue
    // tracked on: https://code.google.com/p/webrtc/issues/detail?id=3050
    this.call.disableVideoFec();
    this.call.constrainVideoBitrate(this.maxVideoBitrateKbps);

    return this.doGetUserMedia(this.constraints).then(() => {
      if (!this.hasError) {
        return this.resolve(this.getResults());
      } else {
        return this.reject(new Error('Video Bandwidth Error'), this.getResults());
      }
    }, (err) => {
      return this.reject(err, this.getResults());
    });
  }

  getResults () {
    const results = {
      log: this.log,
      stats: this.stats,
      constraints: this.constraints
    };
    return results;
  }

  addLog (level, msg) {
    this.logger[level.toLowerCase()](msg);
    if (msg && typeof msg === 'Object') {
      msg = JSON.stringify(msg);
    }
    if (level === 'error') {
      this.hasError = true;
    }
    this.log.push(`${level}: ${msg}`);
  }

  doGetUserMedia (constraints) {
    this.addLog('info', { status: 'pending', constraints });
    return navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then((stream) => {
      const camera = this.getDeviceName(stream.getVideoTracks());
      this.addLog('info', { status: 'success', camera });
      return this.gotStream(stream);
    }, (error) => {
      this.addLog('error', {'status': 'fail', 'error': error});
      this.addLog('error', `Failed to get access to local media due to error: ${error.name}`);
      return this.reject(error);
    });
  }

  getDeviceName (tracks) {
    if (tracks.length === 0) {
      return null;
    }
    return tracks[0].label;
  }

  gotStream (stream) {
    this.call.pc1.addStream(stream);
    return this.call.establishConnection().then(() => {
      this.addLog('info', { status: 'success', message: 'establishing connection' });
      this.startTime = new Date();
      this.localStream = stream.getVideoTracks()[0];

      return new Promise((resolve, reject) => {
        this.nextTimeout = setTimeout(() => {
          this.gatherStats().then(resolve, reject);
        }, this.statStepMs);
      });
    }, (error) => {
      this.addLog('warn', { status: 'error', error });
      return Promise.reject(error);
    });
  }

  gatherStats () {
    const now = new Date();
    if (now - this.startTime > this.durationMs) {
      return Promise.resolve(this.completed());
    }
    return this.call.pc1.getStats(this.localStream)
      .then(this.gotStats.bind(this), (error) => {
        this.addLog('error', 'Failed to getStats: ' + error);
      });
  }

  gotStats (response) {
    const isWebkit = 'WebkitAppearance' in document.documentElement.style;
    const isFirefox = navigator.userAgent.toLowerCase().indexOf('firefox') > -1;
    if (isWebkit) {
      const results = typeof response.result === 'function' ? response.result() : response;
      results.forEach((report) => {
        if (report.id === 'bweforvideo') {
          this.bweStats.add(Date.parse(report.timestamp), parseInt(report['googAvailableSendBandwidth'], 10));
        } else if (report.type === 'ssrc') {
          this.rttStats.add(Date.parse(report.timestamp), parseInt(report['googRtt'], 10));
          // Grab the last stats.
          this.videoStats[0] = report['googFrameWidthSent'];
          this.videoStats[1] = report['googFrameHeightSent'];
          this.packetsLost = report['packetsLost'];
        }
      });
    } else if (isFirefox) {
      for (let j in response) {
        let stats = response[j];
        if (stats.id === 'outbound_rtcp_video_0') {
          this.rttStats.add(Date.parse(stats.timestamp), parseInt(stats.mozRtt, 10));
          // Grab the last stats.
          this.jitter = stats.jitter;
          this.packetsLost = stats.packetsLost;
        } else if (stats.id === 'outbound_rtp_video_0') {
          // TODO: Get dimensions from getStats when supported in FF.
          this.videoStats[0] = 'Not supported on Firefox';
          this.videoStats[1] = 'Not supported on Firefox';
          this.bitrateMean = stats.bitrateMean;
          this.bitrateStdDev = stats.bitrateStdDev;
          this.framerateMean = stats.framerateMean;
        }
      }
    } else {
      this.addLog('error', 'Only Firefox and Chrome getStats implementations are supported.');
    }
    return new Promise((resolve, reject) => {
      this.nextTimeout = setTimeout(() => {
        this.gatherStats().then(resolve, reject);
      }, this.statStepMs);
    });
  }
  completed () {
    const isWebkit = 'WebkitAppearance' in document.documentElement.style;
    const isFirefox = navigator.userAgent.toLowerCase().indexOf('firefox') > -1;
    this.call.pc1.getLocalStreams()[0].getTracks().forEach((track) => {
      track.stop();
    });
    this.call.close();
    this.call = null;
    const stats = this.stats;

    if (isWebkit) {
      // Checking if greater than 2 because Chrome sometimes reports 2x2 when a camera starts but fails to deliver frames.
      if (this.videoStats[0] < 2 && this.videoStats[1] < 2) {
        this.addLog('error', `Camera failure: ${this.videoStats[0]}x${this.videoStats[1]}. Cannot test bandwidth without a working camera.`);
      } else {
        stats.resolution = `${this.videoStats[0]}x${this.videoStats[1]}`;
        stats.bpsAvg = this.bweStats.getAverage();
        stats.bpsMax = this.bweStats.getMax();
        stats.rampUpTimeMs = this.bweStats.getRampUpTime();

        this.addLog('info', `Video resolution: ${stats.resolution}`);
        this.addLog('info', `Send bandwidth estimate average: ${stats.bpsAvg} bps`);
        this.addLog('info', `Send bandwidth estimate max: ${stats.bpsMax} bps`);
        this.addLog('info', `Send bandwidth ramp-up time: ${stats.rampUpTimeMs} ms`);
      }
    } else if (isFirefox) {
      if (parseInt(this.framerateMean, 10) > 0) {
        this.addLog('SUCCESS', `Frame rate mean: ${parseInt(this.framerateMean, 10)}`);
      } else {
        this.addLog('error', 'Frame rate mean is 0, cannot test bandwidth without a working camera.');
      }
      stats.framerateMean = this.framerateMean || null;

      stats.bitrateMean = this.bitrateMean;
      stats.bitrateStdDev = this.bitrateStdDev;
      this.addLog('info', `Send bitrate mean: ${stats.bitrateMean} bps`);
      this.addLog('info', `Send bitrate standard deviation: ${stats.bitrateStdDev} bps`);
    }
    stats.rttAverage = this.rttStats.getAverage();
    stats.rttMax = this.rttStats.getMax();
    stats.lostPackets = parseInt(this.packetsLost, 10);

    this.addLog('info', `RTT average: ${stats.rttAverage} ms`);
    this.addLog('info', `RTT max: ${stats.rttMax} ms`);
    this.addLog('info', `Lost packets: ${stats.lostPackets}`);
    return this.results;
  }

  destroy () {
    super.destroy();
    window.clearTimeout(this.nextTimeout);
    if (this.call) {
      this.call.close();
      this.call = null;
    }
  }
}

export default VideoBandwidthTest;
