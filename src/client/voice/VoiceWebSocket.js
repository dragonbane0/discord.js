const Constants = require('../../util/Constants');
const SecretKey = require('./util/SecretKey');
const EventEmitter = require('events').EventEmitter;

let WebSocket;
try {
  WebSocket = require('@discordjs/uws');
} catch (err) {
  WebSocket = require('ws');
}

/**
 * Represents a Voice Connection's WebSocket.
 * @extends {EventEmitter}
 * @private
 */
class VoiceWebSocket extends EventEmitter {
  constructor(voiceConnection) {
    super();

    /**
     * The client of this voice WebSocket
     * @type {Client}
     */
    this.client = voiceConnection.voiceManager.client;

    /**
     * The Voice Connection that this WebSocket serves
     * @type {VoiceConnection}
     */
    this.voiceConnection = voiceConnection;

    /**
     * How many connection attempts have been made
     * @type {number}
     */
    this.attempts = 0;

    /**
     * The target version of the voice API to use
     * @type {number}
     */
    this.apiVersion = 4;

    /**
     * Timestamp of last pong packet received
     * @type {number}
     */
    this.lastPongPacket = 0;

    this.connect();
    this.dead = false;
    this.voiceConnection.on('closing', this.shutdown.bind(this));
  }

  shutdown() {
    this.dead = true;
    this.reset();
  }

  /**
   * Resets the current WebSocket.
   */
  reset() {
    if (this.ws) {
      if (this.ws.readyState !== WebSocket.CLOSED) this.ws.close();
      this.ws = null;
    }
    this.clearHeartbeat();
  }

  /**
   * Starts connecting to the Voice WebSocket Server.
   */
  connect() {
    if (this.dead) return;
    if (this.ws) this.reset();
    if (this.attempts >= 5) {
      this.emit('debug', new Error(`Too many connection attempts (${this.attempts}).`));
      return;
    }

    this.attempts++;

    /**
     * The actual WebSocket used to connect to the Voice WebSocket Server.
     * @type {WebSocket}
     */
    this.ws = new WebSocket(`wss://${this.voiceConnection.authentication.endpoint}/?v=${this.apiVersion}`);
    this.ws.onopen = this.onOpen.bind(this);
    this.ws.onmessage = this.onMessage.bind(this);
    this.ws.onclose = this.onClose.bind(this);
    this.ws.onerror = this.onError.bind(this);
  }

  /**
   * Sends data to the WebSocket if it is open.
   * @param {string} data The data to send to the WebSocket
   * @returns {Promise<string>}
   */
  send(data) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        throw new Error(`Voice websocket not open to send ${data}.`);
      }
      this.ws.send(data, null, error => {
        if (error) reject(error); else resolve(data);
      });
    });
  }

  /**
   * JSON.stringify's a packet and then sends it to the WebSocket Server.
   * @param {Object} packet The packet to send
   * @returns {Promise<string>}
   */
  sendPacket(packet) {
    try {
      packet = JSON.stringify(packet);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.send(packet);
  }

  /**
   * Called whenever the WebSocket opens.
   */
  onOpen() {
    this.sendPacket({
      op: Constants.VoiceOPCodes.IDENTIFY,
      d: {
        server_id: this.voiceConnection.channel.guild.id,
        user_id: this.client.user.id,
        token: this.voiceConnection.authentication.token,
        session_id: this.voiceConnection.authentication.sessionID,
      },
    }).catch(() => {
      this.emit('error', new Error('Tried to send join packet, but the WebSocket is not open.'));
    });
  }

  /**
   * Called whenever a message is received from the WebSocket.
   * @param {MessageEvent} event The message event that was received
   * @returns {void}
   */
  onMessage(event) {
    try {
      return this.onPacket(JSON.parse(event.data));
    } catch (error) {
      return this.onError(error);
    }
  }

  /**
   * Called whenever the connection to the WebSocket server is lost.
   */
  onClose() {

    this.reset();

    if (!this.dead) {
      console.error("[discord.js] TCP Voice Socket got closed, need a re-connect!");
      this.emit('error', { message: "reconnect_required" }); //this.client.setTimeout(this.connect.bind(this), this.attempts * 1000);
    }
  }

  /**
   * Called whenever an error occurs with the WebSocket.
   * @param {Error} error The error that occurred
   */
  onError(error) {

    console.error("[discord.js] TCP Voice Socket error:", error);

    if (!this.dead) {

      if (error.message === "uWs client connection error") { //Got disconnected from the TCP Voice Socket
        this.reset();
        this.emit('error', { message: "reconnect_required" });

        return;
      }

      this.emit('error', error);
    }
  }

  /**
   * Called whenever a valid packet is received from the WebSocket.
   * @param {Object} packet The received packet
   */
  onPacket(packet) {

    switch (packet.op) {
      case Constants.VoiceOPCodes.INFO:   
        /**
         * Emitted once the voice WebSocket receives the info packet.
         * @param {Object} packet The received packet
         * @event VoiceWebSocket#info
         */

        this.setHeartbeat(packet.d.heartbeat_interval);

        // Verify version is correct
        if (packet.d.v !== this.apiVersion) {
            console.error("[discord.js] Voice API version wasn't correct. Got:", packet.d.v, "expected:", this.apiVersion);
        }

        break;
      case Constants.VoiceOPCodes.READY:
        /**
         * Emitted once the voice WebSocket receives the ready packet.
         * @param {Object} packet The received packet
         * @event VoiceWebSocket#ready
         */
        this.emit('ready', packet.d);
        break;
      case Constants.VoiceOPCodes.SESSION_DESCRIPTION:
        /**
         * Emitted once the Voice Websocket receives a description of this voice session.
         * @param {string} encryptionMode The type of encryption being used
         * @param {SecretKey} secretKey The secret key used for encryption
         * @event VoiceWebSocket#sessionDescription
         */
        this.emit('sessionDescription', packet.d.mode, new SecretKey(packet.d.secret_key));
        break;
      case Constants.VoiceOPCodes.SPEAKING:
        /**
         * Emitted whenever a speaking packet is received.
         * @param {Object} data
         * @event VoiceWebSocket#speaking
         */

        console.log("Speaking association packet received:", packet);

        this.emit('startSpeaking', packet.d);
        break;
      case Constants.VoiceOPCodes.PONG:
        /**
         * Emitted whenever a pong packet is received.
         * @param {Object} data
         * @event VoiceWebSocket#pong
         */
        
        this.lastPongPacket = packet.d;
        break;
      default:
        /**
         * Emitted when an unhandled packet is received.
         * @param {Object} packet
         * @event VoiceWebSocket#unknownPacket
         */
        this.emit('unknownPacket', packet);
        break;
    }
  }

  /**
   * Sets an interval at which to send a heartbeat packet to the WebSocket.
   * @param {number} interval The interval at which to send a heartbeat packet
   */
  setHeartbeat(interval) {
    if (!interval || isNaN(interval)) {
      this.onError(new Error('Tried to set voice heartbeat but no valid interval was specified.'));
      return;
    }
    if (this.heartbeatInterval) {
      /**
       * Emitted whenver the voice WebSocket encounters a non-fatal error.
       * @param {string} warn The warning
       * @event VoiceWebSocket#warn
       */
      this.emit('warn', 'A voice heartbeat interval is being overwritten');
      clearInterval(this.heartbeatInterval);
    }
    this.heartbeatInterval = this.client.setInterval(this.sendHeartbeat.bind(this), interval);
  }

  /**
   * Clears a heartbeat interval, if one exists.
   */
  clearHeartbeat() {
    if (!this.heartbeatInterval) {
      this.emit('warn', 'Tried to clear a heartbeat interval that does not exist');
      return;
    }
    clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = null;
  }

  /**
   * Sends a heartbeat packet.
   */
  sendHeartbeat() {

    this.sendPacket({ op: Constants.VoiceOPCodes.HEARTBEAT, d: Date.now() }).catch(() => {

      if (!this.dead) {
        console.error("[discord.js] Heartbeat couldn't be delivered, maybe need a re-connect!?");
        //this.emit('error', { message: "reconnect_required" });
      }

      this.emit('warn', 'Tried to send heartbeat, but connection is not open');
      this.clearHeartbeat();
    });
  }
}

module.exports = VoiceWebSocket;
