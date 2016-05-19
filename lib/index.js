'use strict';
const Bcrypt = require('bcrypt');
const Dns = require('dns');
const Http = require('http');
const Https = require('https');
const WebSocketServer = require('ws').Server;

const ApiApp = require('./api');
const CreateLogger = require('./create-logger');
const CreateNetProxyServer = require('./net-proxy-server');
const CreateTlsProxyServer = require('./tls-proxy-server');
const Db = require('./db');
const DynamicDns = require('./dynamic-dns');
const TlsCertificate = require('./tls-certificate');
const WebApp = require('./www');
const WebSocketRelay = require('./web-socket-relay');

const log = CreateLogger('SpaceKitService');

/**
 * The SpaceKitService listens for TLS connections. Depending on the hostname
 * (provided by SNI) of the connection, we'll do the following:
 *
 * If the hostname of the incoming connection is the hostname of SpaceKitService,
 * we will handle the request ourselves (either a WebSocket or HTTPS request).
 *
 * Otherwise, we will transparently proxy that connection to one of the
 * connected client relays serving the requested hostname (if available).
 *
 * If configured, SpaceKitService will act as a dynamic DNS service, updating
 * DNS records to the appropriate client relay.
 */
class SpaceKitService {
  constructor (config) {
    this.host = config.host; // "spacekit.io"
    this.apiHostname = `${config.api}.${config.host}`;
    this.webHostname = `${config.web}.${config.host}`;
    this.certificates = new Map();
    if (config.pg) {
      this.db = new Db(config);
    } else {
      log.warn('No database specified; relay authentication disabled!');
    }
    this.relays = new Map(); // hostname -> WebSocketRelay
    this.dnsCache = new Map(); // hostname -> IPv4

    if (config.apiKey || config.webKey) {
      // Listen for any incoming Tls connections.
      this.tlsServer = CreateTlsProxyServer(this.handleTlsConnection.bind(this));
      this.tlsServer.listen(443);
      // Listen for any incoming Net connections.
      this.plainServer = CreateNetProxyServer(this.handlePlainTextConnection.bind(this));
      this.plainServer.listen(config.tcpPort);
    } else {
      this.plainServer = CreateNetProxyServer(this.handleTlsConnection.bind(this));
      this.plainServer.listen(config.tcpPort);
    }

    // An HTTPS server will handle api requests and relay WebSocket upgrades.
    // Note: This server doesn't actually bind itself to a port; we hand it
    // established connections from a TLS proxy handler.
    if (config.apiKey) {
      this.apiServer = Https.createServer({
        SNICallback: (serverName, cb) => {
          this.getCertificate(serverName).processSniCallback(cb);
        }
        // key: Fs.readFileSync(config.apiKey),
        // cert: Fs.readFileSync(config.apiCert)
      }, ApiApp(config));
    } else {
      log.warn('No HTTPS certificate specified for the API server!');
      this.apiServer = Http.createServer();
    }

    // A WebSocket server will handle relay client connections for the api
    // server.
    this.wss = new WebSocketServer({ server: this.apiServer });
    this.wss.on('connection', this.authenticateRelayConnection.bind(this));
    this.wss.on('headers', (headers) => {
      headers['Access-Control-Allow-Origin'] = '*';
    });
    this.wss.on('error', (err) => {
      log.error(err, 'WebSocketServer error event');
    });

    // An HTTPS server will handle website requests. Note: This server doesn't
    // actually bind itself to a port; we hand it established connections from
    // a TLS proxy handler.
    if (config.webKey) {
      this.webServer = Https.createServer({
        SNICallback: (serverName, cb) => {
          this.getCertificate(serverName).processSniCallback(cb);
        }
      }, WebApp(config));
    } else {
      log.warn('No HTTPS certificate specified for the web server!');
      this.webServer = Http.createServer();
    }

    // Configure the DNS updater, if applicable.
    if (config.awsHostedZoneId) {
      this.dynamicDns = new DynamicDns(config);
    }

    log.info('the service has started');
  }

  close () {
    if (this.plainServer) {
      this.plainServer.close();
    }
    if (this.tlsServer) {
      this.tlsServer.close();
    }
  }

  getCertificate (hostname) {
    let cert = this.certificates.get(hostname);
    if (!cert) {
      cert = new TlsCertificate(hostname);
      this.certificates.set(hostname, cert);
    }
    return cert;
  }

  /**
   * Handle a TLS connection that needs to be forwarded to `hostname`.
   *
   * If this connection's hostname is one of SpaceKit's services, we forward
   * the request to our own HTTPS server.
   *
   * Otherwise, pass the connection onto a client relay for that hostname,
   * if one is available.
   */
  handleTlsConnection (socket, hostname) {
    log.info({ for: hostname }, 'new Tls connection');

    if (hostname === this.apiHostname) {
      this.apiServer.emit('connection', socket);
    } else if (hostname === this.webHostname) {
      this.webServer.emit('connection', socket);
    } else {
      let relay = this.relays.get(hostname);
      if (relay) {
        relay.addSocket(socket, hostname, 443);
      } else {
        let message = 'Relay not connected';
        socket.end(`HTTP/1.1 500 ${message}\r\n\r\n${message}`);
      }
    }
  }

  /**
   * Handle an insecure connection that needs to be forwarded to `hostname`.
   *
   * If this connection's hostname is one of SpaceKit's services, we redirect
   * the request to the secure location.
   *
   * Otherwise we forward ACME certificate exchange requests to a connected
   * relay, so that users can run providers like Let's Encrypt themselves to
   * receive certificates.
   */
  handlePlainTextConnection (socket, hostname, path) {
    log.info({ for: hostname, path: path }, 'new Net connection');

    if (hostname === this.host) {
      // Redirect "spacekit.io" to "www.spacekit.io"
      socket.end(`HTTP/1.1 301\r\nLocation: https://${this.webHostname}${path}\r\n\r\n`);
    } else if (path.startsWith('/.well-known/acme-challenge/')) {
      // Forward ACME challenges, including our own web and api handlers.
      if (hostname === this.apiHostname || hostname === this.webHostname) {
        // XXX: forward to TLS cert generator
        this.getCertificate(hostname).handleAcmeChallengeSocket(socket, path);
      } else {
        let relay = this.relays.get(hostname);
        if (relay) {
          relay.addSocket(socket, hostname, 80);
        } else {
          let message = 'Relay not connected';
          socket.end(`HTTP/1.1 500 ${message}\r\n\r\n${message}`);
        }
      }
    } else {
      // Otherwise, redirect everything to HTTPS.
      socket.end(`HTTP/1.1 301\r\nLocation: https://${hostname}${path}\r\n\r\n`);
    }
  }

  /**
   * Authenticate an incoming connection from a client relay.
   */
  authenticateRelayConnection (webSocket) {
    let subdomain = webSocket.upgradeReq.headers['x-spacekit-subdomain'];
    let username = webSocket.upgradeReq.headers['x-spacekit-username'];
    let apiKey = webSocket.upgradeReq.headers['x-spacekit-apikey'];
    let hostname = `${subdomain}.${username}.${this.host}`;
    let existingRelay = this.relays.get(hostname);

    webSocket.log = log.child({ for: hostname });

    webSocket.on('error', (err) => {
      webSocket.log.error({ err: err }, 'relay web socket error event');
    });

    if (existingRelay) {
      webSocket.log.info('existing relay found, closing');
      existingRelay.webSocket.close(1001); // 1001 (going away)
    }

    if (!this.db) {
      webSocket.log.info('Bypassing authentication.');
      this.handleRelayConnection(webSocket, hostname);
      return;
    }

    let query = `SELECT id, api_key FROM users WHERE username = $1`;

    this.db.run(query, [username], (err, result) => {
      if (err) {
        webSocket.log.error(err, 'relay auth failed (db query error)');
        return webSocket.close();
      }

      if (result.rows.length === 0) {
        webSocket.log.info('relay auth failed (user not found)');
        return webSocket.close();
      }

      Bcrypt.compare(apiKey, result.rows[0].api_key, (err, pass) => {
        if (err) {
          webSocket.log.error(err, 'relay auth failed (bcrypt compare error)');
          return webSocket.close();
        }

        if (!pass) {
          webSocket.log.info('relay auth failed (api key incorrect)');
          return webSocket.close();
        }

        webSocket.log.info('relay auth success');

        this.handleRelayConnection(webSocket, hostname);
      });
    });
  }

  /**
   * Handle an incoming connection from a client relay.
   *
   * The webSocket here will send events to any TLS sockets it is associated
   * with. (That magic happens in WebSocketRelay.)
   *
   * If we're configured to update DNS, do so now.
   */
  handleRelayConnection (webSocket, hostname) {
    let relay = new WebSocketRelay(webSocket);

    this.relays.set(hostname, relay);

    webSocket.on('close', () => {
      this.relays.delete(hostname);
    });

    if (this.dynamicDns) {
      this.resolveDns(this.apiHostname, (err, ipAddress) => {
        if (err) {
          log.error(err, 'dns resolve error');
          return webSocket.close();
        } else {
          let options = {
            hostname: hostname,
            recordType: 'A',
            recordValue: ipAddress
          };

          this.dynamicDns.upsert(options, (err, data) => {
            if (err) {
              log.error(err, 'dynamic dns error');
              return webSocket.close();
            }

            log.info('dns upsert success');
          });
        }
      });
    }
  }

  /**
   * Resolves a hostname to IPv4, caches results.
   */
  resolveDns (hostname, callback) {
    if (this.dnsCache.get(hostname)) {
      return callback(null, this.dnsCache.get(hostname));
    }

    Dns.resolve4(hostname, (err, addresses) => {
      if (err) {
        return callback(err);
      }

      this.dnsCache.set(hostname, addresses[0]);

      callback(null, addresses[0]);
    });
  }
}

module.exports = SpaceKitService;
