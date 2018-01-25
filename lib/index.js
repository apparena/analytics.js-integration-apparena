'use strict'

/**
 * Module dependencies.
 */

var ads = require('@segment/ad-params')
var clone = require('component-clone')
var cookie = require('component-cookie')
var extend = require('@ndhoule/extend')
var integration = require('@segment/analytics.js-integration')
var json = require('json3')
var keys = require('@ndhoule/keys')
var localstorage = require('yields-store')
var md5 = require('spark-md5').hash
var protocol = require('@segment/protocol')
var send = require('@segment/send-json')
var topDomain = require('@segment/top-domain')
var utm = require('@segment/utm-params')
var uuid = require('uuid').v4
var Queue = require('@segment/localstorage-retry')

/**
 * Cookie options
 */

var cookieOptions = {
    // 1 year
    maxage: 31536000000,
    secure: false,
    path: '/'
}

/**
 * Queue options
 *
 * for first hour, attempt with backoff
 *    Sum[k^2, {k, 0, 21}] = 3311000 (55min)
 * for remaining 23 hours, attempt 1/hr (linear)
 * total = 45 attempts
 */

var queueOptions = {
    maxRetryDelay: 360000, // max interval of 1hr
    minRetryDelay: 1000, // first attempt (1s)
    backoffFactor: 2,
    maxAttempts: 45,
    maxItems: 100
}

/**
 * Expose `AppArena` integration.
 */

var AppArena = exports = module.exports = integration('AppArena')
    .global('apparena', '')
    // .option('apiKey', '')
    .option('apiHost', 'app.app-arena.com/v1')
    .option('crossDomainId', true)
    .option('retryQueue', false)
    .option('addBundledMetadata', false)
    .option('unbundledIntegrations', [])
    .tag('<script src="//cdn-am.app-arena.com/client-sdk/1.0/shim.js">');

/**
 * Get the store.
 *
 * @return {Function}
 */

exports.storage = function () {
    return protocol() === 'file:' || protocol() === 'chrome-extension:' ? localstorage : cookie
}

/**
 * Expose global for testing.
 */

exports.global = window

/**
 * Initialize.
 *
 * @api public
 */

AppArena.prototype.initialize = function () {
    var self = this

    if (this.options.retryQueue) {
        this._lsqueue = new Queue('AppArena', queueOptions, function (item, done) {
            // apply sentAt at flush time and reset on each retry
            // so the tracking-api doesn't interpret a time skew
            item.msg.sentAt = new Date()
            // send
            send(item.url, item.msg, item.headers, function (err, res) {
                self.debug('sent %O, received %O', item.msg, [err, res])
                if (err) return done(err)
                done(null, res)
            })
        })

        this._lsqueue.start()
    }

    this.analytics.on('invoke', function (msg) {
        var action = msg.action()
        var listener = 'on' + msg.action()
        self.debug('%s %o', action, msg)
        if (self[listener]) self[listener](msg)
        self.ready()
    })

    this.load(this.ready);

    // At this moment we intentionally do not want events to be queued while we retrieve the `crossDomainId`
    // so `.ready` will get called right away and we'll try to figure out `crossDomainId`
    // separately
    if (this.options.crossDomainId) {
        this.retrieveCrossDomainId()
    }
}

/**
 * Loaded.
 *
 * @api private
 * @return {boolean}
 */

AppArena.prototype.loaded = function () {
    return typeof window.apparena === 'function';
}

/**
 * Page.
 *
 * @api public
 * @param {Page} page
 */

AppArena.prototype.onpage = function (page) {
    this.enqueue('/event/p', page.json())
}

/**
 * Identify.
 *
 * @api public
 * @param {Identify} identify
 */

AppArena.prototype.onidentify = function (identify) {
    this.enqueue('/event/i', identify.json())
}

/**
 * Group.
 *
 * @api public
 * @param {Group} group
 */

AppArena.prototype.ongroup = function (group) {
    this.enqueue('/event/g', group.json())
}

/**
 * ontrack.
 *
 * TODO: Document this.
 *
 * @api private
 * @param {Track} track
 */

AppArena.prototype.ontrack = function (track) {
    var json = track.json()
    // TODO: figure out why we need traits.
    delete json.traits
    this.enqueue('/event/t', json)
}

/**
 * Alias.
 *
 * @api public
 * @param {Alias} alias
 */

AppArena.prototype.onalias = function (alias) {
    var json = alias.json()
    var user = this.analytics.user()
    json.previousId = json.previousId || json.from || user.id() || user.anonymousId()
    json.userId = json.userId || json.to
    delete json.from
    delete json.to
    this.enqueue('/event/a', json)
}

/**
 * Normalize the given `msg`.
 *
 * @api private
 * @param {Object} msg
 */

AppArena.prototype.normalize = function (msg) {
    this.debug('normalize %o', msg)
    var user = this.analytics.user()
    var global = exports.global
    var query = global.location.search
    var ctx = msg.context = msg.context || msg.options || {}
    delete msg.options
    msg.writeKey = this.options.apiKey
    msg.companyId = this.options.companyId
    msg.appId = this.options.appId || this.analytics.options.appId;
    ctx.userAgent = navigator.userAgent
    if (!ctx.library) ctx.library = {name: 'analytics.js', version: this.analytics.VERSION}
    var crossDomainId = this.cookie('aa_xid')
    if (crossDomainId) {
        if (!ctx.traits) {
            ctx.traits = {crossDomainId: crossDomainId}
        } else if (!ctx.traits.crossDomainId) {
            ctx.traits.crossDomainId = crossDomainId
        }
    }
    // if user provides campaign via context, do not overwrite with UTM qs param
    if (query && !ctx.campaign) {
        ctx.campaign = utm(query)
    }
    this.referrerId(query, ctx)
    msg.userId = msg.userId || user.id()
    msg.anonymousId = user.anonymousId()
    msg.sentAt = new Date()
    // Add _metadata.
    var failedInitializations = this.analytics.failedInitializations || []
    if (failedInitializations.length > 0) {
        msg._metadata = {failedInitializations: failedInitializations}
    }
    if (this.options.addBundledMetadata) {
        var bundled = keys(this.analytics.Integrations)
        msg._metadata = msg._metadata || {}
        msg._metadata.bundled = bundled
        msg._metadata.unbundled = this.options.unbundledIntegrations
    }
    // add some randomness to the messageId checksum
    msg.messageId = 'ajs-' + md5(json.stringify(msg) + uuid())
    this.debug('normalized %o', msg)
    this.ampId(ctx)
    return msg
}

/**
 * Add amp id if it exists.
 *
 * @param {Object} ctx
 */

AppArena.prototype.ampId = function (ctx) {
    var ampId = this.cookie('aa_amp_id')
    if (ampId) ctx.amp = {id: ampId}
}

/**
 * Send `obj` to `path`.
 *
 * @api private
 * @param {string} path
 * @param {Object} msg
 * @param {Function} fn
 */

AppArena.prototype.enqueue = function (path, msg, fn) {
    var url = 'https://' + this.options.apiHost + path
    var headers = {'Content-Type': 'text/plain'}
    msg = this.normalize(msg)
    this.debug('enqueueing')

    var self = this
    if (this.options.retryQueue) {
        this._lsqueue.addItem({
            url: url,
            headers: headers,
            msg: msg
        })
    } else {
        send(url, msg, headers, function (err, res) {
            self.debug('sent %O, received %O', msg, [err, res])
            if (fn) {
                if (err) return fn(err)
                fn(null, res)
            }
        })
    }
}

/**
 * Gets/sets cookies on the appropriate domain.
 *
 * @api private
 * @param {string} name
 * @param {*} val
 */

AppArena.prototype.cookie = function (name, val) {
    var store = AppArena.storage()
    if (arguments.length === 1) return store(name)
    var global = exports.global
    var href = global.location.href
    var domain = '.' + topDomain(href)
    if (domain === '.') domain = ''
    this.debug('store domain %s -> %s', href, domain)
    var opts = clone(cookieOptions)
    opts.domain = domain
    this.debug('store %s, %s, %o', name, val, opts)
    store(name, val, opts)
    if (store(name)) return
    delete opts.domain
    this.debug('fallback store %s, %s, %o', name, val, opts)
    store(name, val, opts)
}

/**
 * Add referrerId to context.
 *
 * TODO: remove.
 *
 * @api private
 * @param {Object} query
 * @param {Object} ctx
 */

AppArena.prototype.referrerId = function (query, ctx) {
    var stored = this.cookie('s:context.referrer')
    var ad

    if (stored) stored = json.parse(stored)
    if (query) ad = ads(query)

    ad = ad || stored

    if (!ad) return
    ctx.referrer = extend(ctx.referrer || {}, ad)
    this.cookie('s:context.referrer', json.stringify(ad))
}

/**
 *
 * retrieveCrossDomainId.
 *
 * @api private
 * @param {function} callback => err, {crossDomainId, fromServer, timestamp}
 */
AppArena.prototype.retrieveCrossDomainId = function (callback) {
    if (!this.options.crossDomainId) {
        if (callback) {
            callback('crossDomainId not enabled', null)
        }
        return
    }
    if (!this.cookie('aa_xid')) {
        var self = this
        var domain = this.options.apiHost
        getCrossDomainIdFromSingleServer(domain, function (err, res) {
            if (err) {
                // We optimize for no conflicting xid as much as possible. So bail out if there is an
                // error and we cannot be sure that xid does not exist on any other domains
                if (callback) {
                    callback(err, null)
                }
                return
            }
            var crossDomainId = null
            var fromDomain = null
            if (res) {
                crossDomainId = res.id
                fromDomain = res.domain
            } else {
                crossDomainId = uuid()
                fromDomain = window.location.hostname
            }
            var currentTimeMillis = (new Date()).getTime()
            self.cookie('aa_xid', crossDomainId)
            // Not actively used. Saving for future conflict resolution purposes
            self.cookie('aa_xid_fd', fromDomain)
            self.cookie('aa_xid_ts', currentTimeMillis)
            self.analytics.user().anonymousId(crossDomainId)
            self.analytics.identify({
                crossDomainId: crossDomainId
            })
            if (callback) {
                callback(null, {
                    crossDomainId: crossDomainId,
                    fromDomain: fromDomain,
                    timestamp: currentTimeMillis
                })
            }
        })
    }
}

/**
 * getCrossDomainId
 * @param {Array} domain
 * @param {function} callback => err, {domain, id}
 */
function getCrossDomainIdFromSingleServer(domain, callback) {
    var endpoint = 'https://' + domain + '/ping'
    getJson(endpoint, function (err, res) {
        if (err) {
            callback(err, null)
        } else {
            callback(null, {
                domain: domain,
                id: res && res.aa_xid || null
            })
        }
    })
}

/**
 * getJson
 * @param {string} url
 * @param {function} callback => err, json
 */
function getJson(url, callback) {
    var xhr = new XMLHttpRequest()
    xhr.open('GET', url, true)
    xhr.withCredentials = true
    xhr.onreadystatechange = function () {
        if (xhr.readyState === XMLHttpRequest.DONE) {
            if (xhr.status >= 200 && xhr.status < 300) {
                callback(null, xhr.responseText ? json.parse(xhr.responseText) : null)
            } else {
                callback(xhr.statusText || 'Unknown Error', null)
            }
        }
    }
    xhr.send()
}