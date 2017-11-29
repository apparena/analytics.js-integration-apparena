var send = require('@segment/send-json')

// Use double quotes to handle the case where writeKey maybe be an empty string.
// This shouldn't happen in production, but is how our tests are written
// (which don't assume the Segment integration always exists).
// Using single quotes in this case renders incorrectly as`var writeKey = ;`.
/*eslint-disable */
var loadedWriteKey = '1-11169'
/*eslint-enable */

module.exports = function () {
  if (loadedWriteKey) {
    // We're seeing cases where the snippet loaded is not the same the same as the
    // one requested due to a caching bug in Chrome 55.0.2883.59. So we verify that
    // the write key being loaded is the same as the write key being requested. We
    // do this by checking all script tags.

    // Some customers are loading a.js twice. So we look for two markers.
    // First we check if any script match our regex.
    // If we don't find any scripts that match our regex, we continue as normal.
    // If we do find scripts that match our regex, we check if these scripts
    // contain our writeKey.
    var regexFound = false
    var writeKeyFound = false

    var regex = /.*\/client-sdk\/1.0\/([^/]*)(\/platform)?\/analytics.*/
    var scripts = global.document.getElementsByTagName('script')
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src
      var result = regex.exec(src)

      // Check if the script src matches our regex.
      if (!result) {
        continue
      }

      regexFound = true

      // If the script does match our regex, check which writeKey was requested.
      var requestedKey = result[1]
      if (requestedKey === loadedWriteKey) {
        writeKeyFound = true
        break
      }
    }

    // Only track an event if we found at least one script matching our regex,
    // but none of those matching scripts contained our writeKey.
    if (regexFound && !writeKeyFound) {
      // Record an event if the writeKey does not match.
      var url = 'https://app.app-arena.com/dev/event/t'
      var headers = {'Content-Type': 'text/plain'}
      var msg = {
        userId: 'apparena',
        event: 'Invalid WriteKey Loaded',
        properties: {
          hostname: global.window.location.hostname,
          href: global.window.location.href,
          loadedKey: loadedWriteKey,
          requestedKey: requestedKey,
          userAgent: global.navigator.userAgent,
          bailed: true
        }
      }
      send(url, msg, headers, function () {})
      return true
    }
  }
  return false
}